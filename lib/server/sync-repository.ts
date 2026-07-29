import type { Actor } from "./bootstrap";
import { authorizeBeforeExpose } from "./authorization";
import {
  expenseData,
  incomeData,
  maintenanceData,
  tripData,
  vehicleData,
} from "./bootstrap";
import {
  amountToCents,
  booleanValue,
  classifyVersion,
  dateValue,
  isObject,
  optionalIsoDateTime,
  optionalText,
  periodDays,
  RecordValidationError,
  rejectOwnershipFields,
  requiredId,
  requiredText,
  roleCanWriteVehicle,
  sortOrder,
  type SyncOperation,
  type SyncResult,
  type SyncType,
} from "./sync-contract";

type RawRow = Record<string, unknown>;
type Normalized = Record<string, unknown>;

export function validateSyncPut(operation: SyncOperation): Normalized {
  return normalizePut(operation);
}

export async function applySyncOperation(
  d1: D1Database,
  actor: Actor,
  operation: SyncOperation,
): Promise<SyncResult> {
  try {
    await requireActiveMembership(d1, actor);
    return operation.op === "put"
      ? await putRecord(d1, actor, operation)
      : await deleteRecord(d1, actor, operation);
  } catch (error) {
    if (error instanceof RecordValidationError) {
      return rejected(operation, error.code, error.message);
    }
    if (isConstraintError(error)) {
      return rejected(
        operation,
        "constraint_failed",
        readableConstraintMessage(error),
      );
    }
    throw error;
  }
}

export async function markFleetInitialized(
  d1: D1Database,
  fleetId: string,
): Promise<void> {
  await d1
    .prepare(
      "UPDATE fleet_settings SET initialized_at = COALESCE(initialized_at, ?) WHERE fleet_id = ?",
    )
    .bind(new Date().toISOString(), fleetId)
    .run();
}

async function putRecord(
  d1: D1Database,
  actor: Actor,
  operation: SyncOperation,
): Promise<SyncResult> {
  const normalized = normalizePut(operation);
  const current = await getCurrent(d1, actor.fleetId, operation);
  if ("createdAt" in normalized && !normalized.createdAt) {
    normalized.createdAt =
      (current?.created_at as string | undefined) ?? new Date().toISOString();
  }
  if (current) {
    await authorizeCurrentRecord(d1, actor, operation.type, current);
  }

  const decision = classifyVersion(
    operation.expectedVersion,
    current ? Number(current.version) : null,
  );
  if (decision === "conflict") return conflict(operation, current);

  if (decision === "create") {
    await validateRelationships(d1, actor, operation, normalized, null);
    try {
      await insertRecord(d1, actor.fleetId, operation.type, normalized);
    } catch (error) {
      if (isConstraintError(error)) {
        const raced = await getCurrent(d1, actor.fleetId, operation);
        if (raced) {
          return authorizedConflict(d1, actor, operation, raced);
        }
      }
      throw error;
    }
    return {
      op: operation.op,
      type: operation.type,
      id: operation.id,
      status: "applied",
      version: 1,
      data: clientDataFromNormalized(operation.type, normalized),
    };
  }

  if (!current) return conflict(operation, current);
  await validateRelationships(d1, actor, operation, normalized, current);
  const nextVersion = operation.expectedVersion + 1;
  const updated = await updateRecord(
    d1,
    actor.fleetId,
    operation.type,
    normalized,
    operation.expectedVersion,
    nextVersion,
  );
  if (!updated) {
    return authorizedConflict(
      d1,
      actor,
      operation,
      await getCurrent(d1, actor.fleetId, operation),
    );
  }

  return {
    op: operation.op,
    type: operation.type,
    id: operation.id,
    status: "applied",
    version: nextVersion,
    data: clientDataFromNormalized(operation.type, normalized),
  };
}

async function deleteRecord(
  d1: D1Database,
  actor: Actor,
  operation: SyncOperation,
): Promise<SyncResult> {
  if (operation.type === "fleet_settings") {
    throw new RecordValidationError(
      "protected_record",
      "不能删除车队设置",
    );
  }
  const current = await getCurrent(d1, actor.fleetId, operation);
  if (current) {
    await authorizeCurrentRecord(d1, actor, operation.type, current);
  }
  if (
    !current ||
    classifyVersion(
      operation.expectedVersion,
      Number(current.version),
    ) !== "update"
  ) {
    return conflict(operation, current);
  }
  const nextVersion = operation.expectedVersion + 1;
  if (operation.type === "category") {
    const updated = await d1
      .prepare(
        "UPDATE categories SET active = 0, updated_at = ?, version = ? WHERE fleet_id = ? AND kind = ? AND id = ? AND version = ?",
      )
      .bind(
        new Date().toISOString(),
        nextVersion,
        actor.fleetId,
        current.kind,
        current.id,
        operation.expectedVersion,
      )
      .run();
    if (Number(updated.meta.changes) !== 1) {
      return authorizedConflict(
        d1,
        actor,
        operation,
        await getCurrent(d1, actor.fleetId, operation),
      );
    }
  } else if (operation.type === "vehicle") {
    await validateVehicleDeactivation(d1, actor.fleetId, String(current.id));
    const updated = await d1
      .prepare(
        "UPDATE vehicles SET active = 0, updated_at = ?, version = ? WHERE fleet_id = ? AND id = ? AND version = ?",
      )
      .bind(
        new Date().toISOString(),
        nextVersion,
        actor.fleetId,
        current.id,
        operation.expectedVersion,
      )
      .run();
    if (Number(updated.meta.changes) !== 1) {
      return authorizedConflict(
        d1,
        actor,
        operation,
        await getCurrent(d1, actor.fleetId, operation),
      );
    }
  } else {
    const { table, id, tripId } = physicalDeleteTarget(operation, current);
    const deleted = tripId
      ? await d1
          .prepare(
            `DELETE FROM ${table} WHERE fleet_id = ? AND trip_id = ? AND id = ? AND version = ?`,
          )
          .bind(
            actor.fleetId,
            tripId,
            id,
            operation.expectedVersion,
          )
          .run()
      : await d1
          .prepare(
            `DELETE FROM ${table} WHERE fleet_id = ? AND id = ? AND version = ?`,
          )
          .bind(actor.fleetId, id, operation.expectedVersion)
          .run();
    if (Number(deleted.meta.changes) !== 1) {
      return authorizedConflict(
        d1,
        actor,
        operation,
        await getCurrent(d1, actor.fleetId, operation),
      );
    }
  }

  return {
    op: operation.op,
    type: operation.type,
    id: operation.id,
    status: "applied",
    version: nextVersion,
  };
}

function normalizePut(operation: SyncOperation): Normalized {
  const data = operation.data;
  if (!isObject(data)) {
    throw new RecordValidationError("missing_data", "同步记录缺少 data");
  }
  rejectOwnershipFields(data);

  switch (operation.type) {
    case "fleet_settings":
      return normalizeSettings(operation, data);
    case "category":
      return normalizeCategory(operation, data);
    case "vehicle":
      return normalizeVehicle(operation, data);
    case "trip":
      return normalizeTrip(operation, data);
    case "trip_expense":
      return normalizeExpense(operation, data);
    case "trip_income":
      return normalizeIncome(operation, data);
    case "maintenance":
      return normalizeMaintenance(operation, data);
  }
}

function normalizeSettings(
  operation: SyncOperation,
  data: Record<string, unknown>,
): Normalized {
  if (operation.id !== "settings") {
    throw new RecordValidationError(
      "id_mismatch",
      "fleet_settings 的 id 必须是 settings",
    );
  }
  const theme = data.theme === "night" ? "night" : "day";
  const start = dateValue(data.periodStartDate, "periodStartDate");
  const end = dateValue(data.periodEndDate, "periodEndDate");
  const days = periodDays(start, end);
  if (days < 1 || days > 366) {
    throw new RecordValidationError(
      "invalid_period",
      "账期结束日不能早于开始日，且最长 366 天",
    );
  }
  return {
    theme,
    lastReportSeen: optionalText(
      data.lastReportSeen,
      "lastReportSeen",
      10,
    ),
    lastBackupAt: optionalText(data.lastBackupAt, "lastBackupAt", 10),
    activeVehicleId:
      data.activeVehicleId === "all"
        ? "all"
        : requiredId(data.activeVehicleId, "activeVehicleId"),
    periodStartDate: start,
    periodEndDate: end,
  };
}

function normalizeCategory(
  operation: SyncOperation,
  data: Record<string, unknown>,
): Normalized {
  const id = dataRecordId(data.id, "category.id");
  const kind = data.kind;
  if (kind !== "expense" && kind !== "income") {
    throw new RecordValidationError(
      "invalid_category_kind",
      "科目 kind 必须是 expense 或 income",
    );
  }
  if (operation.id !== `${kind}:${id}`) {
    throw new RecordValidationError(
      "id_mismatch",
      "科目同步 id 必须由 kind 和科目 id 组成",
    );
  }
  return {
    id,
    kind,
    name: requiredText(data.name, "category.name", 40),
    icon: optionalText(data.icon, "category.icon", 16),
    builtin: booleanValue(data.builtin, false),
    active: booleanValue(data.active, true),
    sortOrder: sortOrder(data.sortOrder),
  };
}

function normalizeVehicle(
  operation: SyncOperation,
  data: Record<string, unknown>,
): Normalized {
  const id = dataRecordId(data.id, "vehicle.id");
  assertSimpleId(operation, id);
  return {
    id,
    name: requiredText(data.name, "vehicle.name", 60),
    plateNo: optionalText(data.plateNo, "vehicle.plateNo", 24),
    active: booleanValue(data.active, true),
    sortOrder: sortOrder(data.sortOrder),
    createdAt: optionalIsoDateTime(data.createdAt, "vehicle.createdAt"),
  };
}

function normalizeTrip(
  operation: SyncOperation,
  data: Record<string, unknown>,
): Normalized {
  const id = dataRecordId(data.id, "trip.id");
  assertSimpleId(operation, id);
  const vehicleId = dataRecordId(data.vehicleId, "trip.vehicleId");
  const startDate = dateValue(data.startDate, "trip.startDate");
  const status = data.status;
  if (status !== "open" && status !== "closed") {
    throw new RecordValidationError(
      "invalid_trip_status",
      "趟次状态必须是 open 或 closed",
    );
  }
  const endDate =
    data.endDate == null || data.endDate === ""
      ? null
      : dateValue(data.endDate, "trip.endDate");
  if (status === "open" && endDate) {
    throw new RecordValidationError(
      "invalid_trip_dates",
      "在途趟次不能填写到家日期",
    );
  }
  if (status === "closed" && (!endDate || endDate < startDate)) {
    throw new RecordValidationError(
      "invalid_trip_dates",
      "已收车趟次必须填写不早于发车日的到家日期",
    );
  }
  return {
    id,
    vehicleId,
    startDate,
    endDate,
    status,
    closedAt: optionalIsoDateTime(data.closedAt, "trip.closedAt"),
    sortOrder: sortOrder(data.sortOrder),
    createdAt: optionalIsoDateTime(data.createdAt, "trip.createdAt"),
  };
}

function normalizeExpense(
  operation: SyncOperation,
  data: Record<string, unknown>,
): Normalized {
  const id = dataRecordId(data.id, "trip_expense.id");
  const tripId = dataRecordId(data.tripId, "trip_expense.tripId");
  assertChildId(operation, tripId, id);
  return {
    id,
    tripId,
    categoryId: dataRecordId(
      data.categoryId ?? data.catId,
      "trip_expense.categoryId",
    ),
    amountCents: amountToCents(data.amount),
    date: dateValue(data.date, "trip_expense.date"),
    note: optionalText(data.note, "trip_expense.note", 300),
    sortOrder: sortOrder(data.sortOrder),
    createdAt: optionalIsoDateTime(data.createdAt, "trip_expense.createdAt"),
  };
}

function normalizeIncome(
  operation: SyncOperation,
  data: Record<string, unknown>,
): Normalized {
  const id = dataRecordId(data.id, "trip_income.id");
  const tripId = dataRecordId(data.tripId, "trip_income.tripId");
  assertChildId(operation, tripId, id);
  return {
    id,
    tripId,
    categoryId: dataRecordId(
      data.categoryId ?? data.catId,
      "trip_income.categoryId",
    ),
    amountCents: amountToCents(data.amount),
    date: dateValue(data.date, "trip_income.date"),
    sortOrder: sortOrder(data.sortOrder),
    createdAt: optionalIsoDateTime(data.createdAt, "trip_income.createdAt"),
  };
}

function normalizeMaintenance(
  operation: SyncOperation,
  data: Record<string, unknown>,
): Normalized {
  const id = dataRecordId(data.id, "maintenance.id");
  assertSimpleId(operation, id);
  return {
    id,
    vehicleId: dataRecordId(data.vehicleId, "maintenance.vehicleId"),
    date: dateValue(data.date, "maintenance.date"),
    amountCents: amountToCents(data.amount),
    note: optionalText(data.note, "maintenance.note", 300),
    sortOrder: sortOrder(data.sortOrder),
    createdAt: optionalIsoDateTime(data.createdAt, "maintenance.createdAt"),
  };
}

async function validateRelationships(
  d1: D1Database,
  actor: Actor,
  operation: SyncOperation,
  data: Normalized,
  current: RawRow | null,
): Promise<void> {
  if (
    operation.type === "fleet_settings" ||
    operation.type === "category" ||
    operation.type === "vehicle"
  ) {
    requireOwner(actor);
  }

  switch (operation.type) {
    case "fleet_settings": {
      const activeVehicleId = String(data.activeVehicleId);
      if (
        activeVehicleId !== "all" &&
        !(await vehicleExists(d1, actor.fleetId, activeVehicleId))
      ) {
        throw new RecordValidationError(
          "vehicle_not_found",
          "当前车辆不属于这个车队",
        );
      }
      break;
    }
    case "vehicle": {
      if (data.active === false) {
        await validateVehicleDeactivation(
          d1,
          actor.fleetId,
          String(data.id),
          current == null,
        );
      }
      break;
    }
    case "trip": {
      const vehicleId = String(data.vehicleId);
      const vehicle = await requireVehicle(d1, actor.fleetId, vehicleId);
      if (data.status === "open" && !Boolean(vehicle.active)) {
        throw new RecordValidationError(
          "vehicle_inactive",
          "停用车辆不能发车",
        );
      }
      await requireVehicleWriteAccess(d1, actor, vehicleId);
      if (data.status === "open") {
        const other = await d1
          .prepare(
            "SELECT id FROM trips WHERE fleet_id = ? AND vehicle_id = ? AND status = 'open' AND id <> ? LIMIT 1",
          )
          .bind(actor.fleetId, vehicleId, data.id)
          .first();
        if (other) {
          throw new RecordValidationError(
            "vehicle_has_open_trip",
            "这辆车已有一趟在途中",
          );
        }
      }
      break;
    }
    case "trip_expense":
    case "trip_income": {
      const trip = await requireTrip(
        d1,
        actor.fleetId,
        String(data.tripId),
      );
      await requireVehicleWriteAccess(
        d1,
        actor,
        String(trip.vehicle_id),
      );
      await requireCategory(
        d1,
        actor.fleetId,
        String(data.categoryId),
        operation.type === "trip_expense" ? "expense" : "income",
      );
      break;
    }
    case "maintenance": {
      const vehicleId = String(data.vehicleId);
      await requireVehicle(d1, actor.fleetId, vehicleId);
      await requireVehicleWriteAccess(d1, actor, vehicleId);
      break;
    }
  }
}

async function authorizeCurrentRecord(
  d1: D1Database,
  actor: Actor,
  type: SyncType,
  current: RawRow,
): Promise<void> {
  await requireActiveMembership(d1, actor);
  if (type === "category" || type === "vehicle" || type === "fleet_settings") {
    requireOwner(actor);
    return;
  }
  if (type === "trip" || type === "maintenance") {
    await requireVehicleWriteAccess(
      d1,
      actor,
      String(current.vehicle_id),
    );
    return;
  }
  const trip = await requireTrip(
    d1,
    actor.fleetId,
    String(current.trip_id),
  );
  await requireVehicleWriteAccess(d1, actor, String(trip.vehicle_id));
}

async function requireActiveMembership(
  d1: D1Database,
  actor: Actor,
): Promise<void> {
  const membership = await d1
    .prepare(
      "SELECT role FROM fleet_members WHERE id = ? AND fleet_id = ? AND user_id = ? AND active = 1 LIMIT 1",
    )
    .bind(actor.membershipId, actor.fleetId, actor.userId)
    .first<{ role: string }>();
  if (!membership || membership.role !== actor.role) {
    throw new RecordValidationError(
      "membership_inactive",
      "车队成员身份已失效，请重新登录或联系车主",
    );
  }
}

function requireOwner(actor: Actor): void {
  if (actor.role !== "owner") {
    throw new RecordValidationError(
      "owner_required",
      "只有车主可以修改车队、车辆、科目和设置",
    );
  }
}

async function requireVehicleWriteAccess(
  d1: D1Database,
  actor: Actor,
  vehicleId: string,
): Promise<void> {
  if (roleCanWriteVehicle(actor.role, false)) return;
  const assignment = await d1
    .prepare(
      "SELECT id FROM vehicle_assignments WHERE fleet_id = ? AND user_id = ? AND vehicle_id = ? AND active = 1 AND datetime(starts_at) <= CURRENT_TIMESTAMP AND (ends_at IS NULL OR datetime(ends_at) > CURRENT_TIMESTAMP) LIMIT 1",
    )
    .bind(actor.fleetId, actor.userId, vehicleId)
    .first();
  if (!roleCanWriteVehicle(actor.role, Boolean(assignment))) {
    throw new RecordValidationError(
      "vehicle_not_assigned",
      "不能修改未分配给你的车辆账目",
    );
  }
}

async function validateVehicleDeactivation(
  d1: D1Database,
  fleetId: string,
  vehicleId: string,
  insertingInactive = false,
): Promise<void> {
  const openTrip = await d1
    .prepare(
      "SELECT id FROM trips WHERE fleet_id = ? AND vehicle_id = ? AND status = 'open' LIMIT 1",
    )
    .bind(fleetId, vehicleId)
    .first();
  if (openTrip) {
    throw new RecordValidationError(
      "vehicle_has_open_trip",
      "在途车辆不能停用",
    );
  }
  const anotherActive = await d1
    .prepare(
      "SELECT id FROM vehicles WHERE fleet_id = ? AND active = 1 AND id <> ? LIMIT 1",
    )
    .bind(fleetId, vehicleId)
    .first();
  if (!anotherActive) {
    const currentIsActive = insertingInactive
      ? false
      : Boolean(
          await d1
            .prepare(
              "SELECT id FROM vehicles WHERE fleet_id = ? AND id = ? AND active = 1 LIMIT 1",
            )
            .bind(fleetId, vehicleId)
            .first(),
        );
    if (currentIsActive || insertingInactive) {
      throw new RecordValidationError(
        "last_active_vehicle",
        "车队至少要保留一辆启用车辆",
      );
    }
  }
}

async function vehicleExists(
  d1: D1Database,
  fleetId: string,
  vehicleId: string,
): Promise<boolean> {
  return Boolean(
    await d1
      .prepare(
        "SELECT id FROM vehicles WHERE fleet_id = ? AND id = ? LIMIT 1",
      )
      .bind(fleetId, vehicleId)
      .first(),
  );
}

async function requireVehicle(
  d1: D1Database,
  fleetId: string,
  vehicleId: string,
): Promise<RawRow> {
  const vehicle = await d1
    .prepare(
      "SELECT * FROM vehicles WHERE fleet_id = ? AND id = ? LIMIT 1",
    )
    .bind(fleetId, vehicleId)
    .first<RawRow>();
  if (!vehicle) {
    throw new RecordValidationError(
      "vehicle_not_found",
      "车辆不存在或不属于这个车队",
    );
  }
  return vehicle;
}

async function requireTrip(
  d1: D1Database,
  fleetId: string,
  tripId: string,
): Promise<RawRow> {
  const trip = await d1
    .prepare("SELECT * FROM trips WHERE fleet_id = ? AND id = ? LIMIT 1")
    .bind(fleetId, tripId)
    .first<RawRow>();
  if (!trip) {
    throw new RecordValidationError(
      "trip_not_found",
      "趟次不存在或不属于这个车队",
    );
  }
  return trip;
}

async function requireCategory(
  d1: D1Database,
  fleetId: string,
  categoryId: string,
  kind: "expense" | "income",
): Promise<void> {
  const category = await d1
    .prepare(
      "SELECT id FROM categories WHERE fleet_id = ? AND id = ? AND kind = ? LIMIT 1",
    )
    .bind(fleetId, categoryId, kind)
    .first();
  if (!category) {
    throw new RecordValidationError(
      "category_not_found",
      "科目不存在、类型不符或不属于这个车队",
    );
  }
}

async function getCurrent(
  d1: D1Database,
  fleetId: string,
  operation: SyncOperation,
): Promise<RawRow | null> {
  if (operation.type === "fleet_settings") {
    return d1
      .prepare("SELECT * FROM fleet_settings WHERE fleet_id = ? LIMIT 1")
      .bind(fleetId)
      .first<RawRow>();
  }
  if (operation.type === "category") {
    const separator = operation.id.indexOf(":");
    const kind = operation.id.slice(0, separator);
    const id = requiredId(operation.id.slice(separator + 1), "category.id");
    if (kind !== "expense" && kind !== "income") {
      throw new RecordValidationError(
        "invalid_id",
        "科目同步 id 格式不正确",
      );
    }
    return d1
      .prepare(
        "SELECT * FROM categories WHERE fleet_id = ? AND kind = ? AND id = ? LIMIT 1",
      )
      .bind(fleetId, kind, id)
      .first<RawRow>();
  }
  if (
    operation.type === "trip_expense" ||
    operation.type === "trip_income"
  ) {
    const { tripId, id } = childRecordKey(operation.id);
    const table =
      operation.type === "trip_expense"
        ? "trip_expenses"
        : "trip_incomes";
    return d1
      .prepare(
        `SELECT * FROM ${table} WHERE fleet_id = ? AND trip_id = ? AND id = ? LIMIT 1`,
      )
      .bind(fleetId, tripId, id)
      .first<RawRow>();
  }
  const target = recordTarget(operation);
  return d1
    .prepare(
      `SELECT * FROM ${target.table} WHERE fleet_id = ? AND id = ? LIMIT 1`,
    )
    .bind(fleetId, target.id)
    .first<RawRow>();
}

function recordTarget(operation: SyncOperation): {
  table: string;
  id: string;
} {
  switch (operation.type) {
    case "fleet_settings":
      return { table: "fleet_settings", id: operation.id };
    case "category":
      return { table: "categories", id: operation.id };
    case "vehicle":
      return { table: "vehicles", id: operation.id };
    case "trip":
      return { table: "trips", id: operation.id };
    case "trip_expense":
      return {
        table: "trip_expenses",
        id: childRecordKey(operation.id).id,
      };
    case "trip_income":
      return {
        table: "trip_incomes",
        id: childRecordKey(operation.id).id,
      };
    case "maintenance":
      return { table: "maintenance", id: operation.id };
  }
}

function childRecordKey(id: string): { tripId: string; id: string } {
  const separator = id.indexOf(":");
  if (separator < 1) {
    throw new RecordValidationError(
      "invalid_id",
      "子账目同步 id 格式不正确",
    );
  }
  return {
    tripId: dataRecordId(id.slice(0, separator), "entry.tripId"),
    id: dataRecordId(id.slice(separator + 1), "entry.id"),
  };
}

async function insertRecord(
  d1: D1Database,
  fleetId: string,
  type: SyncType,
  data: Normalized,
): Promise<void> {
  const now = new Date().toISOString();
  const createdAt = data.createdAt || now;
  let statement: D1PreparedStatement;

  switch (type) {
    case "fleet_settings":
      // Account bootstrap always creates settings, so this is normally an
      // update. Keeping the insert path makes the repository independently safe.
      statement = d1
        .prepare(
          "INSERT INTO fleet_settings (fleet_id, theme, last_report_seen, last_backup_at, active_vehicle_id, period_start_date, period_end_date, initialized_at, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)",
        )
        .bind(
          fleetId,
          data.theme,
          data.lastReportSeen,
          data.lastBackupAt,
          data.activeVehicleId,
          data.periodStartDate,
          data.periodEndDate,
          now,
          now,
        );
      break;
    case "category":
      statement = d1
        .prepare(
          "INSERT INTO categories (fleet_id, id, kind, name, icon, builtin, active, sort_order, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
        )
        .bind(
          fleetId,
          data.id,
          data.kind,
          data.name,
          data.icon,
          data.builtin ? 1 : 0,
          data.active ? 1 : 0,
          data.sortOrder,
          now,
          now,
        );
      break;
    case "vehicle":
      statement = d1
        .prepare(
          "INSERT INTO vehicles (fleet_id, id, name, plate_no, active, sort_order, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
        )
        .bind(
          fleetId,
          data.id,
          data.name,
          data.plateNo,
          data.active ? 1 : 0,
          data.sortOrder,
          createdAt,
          now,
        );
      break;
    case "trip":
      statement = d1
        .prepare(
          "INSERT INTO trips (fleet_id, id, vehicle_id, start_date, end_date, status, closed_at, sort_order, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
        )
        .bind(
          fleetId,
          data.id,
          data.vehicleId,
          data.startDate,
          data.endDate,
          data.status,
          data.closedAt,
          data.sortOrder,
          createdAt,
          now,
        );
      break;
    case "trip_expense":
      statement = d1
        .prepare(
          "INSERT INTO trip_expenses (fleet_id, id, trip_id, category_id, amount_cents, date, note, sort_order, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
        )
        .bind(
          fleetId,
          data.id,
          data.tripId,
          data.categoryId,
          data.amountCents,
          data.date,
          data.note,
          data.sortOrder,
          createdAt,
          now,
        );
      break;
    case "trip_income":
      statement = d1
        .prepare(
          "INSERT INTO trip_incomes (fleet_id, id, trip_id, category_id, amount_cents, date, sort_order, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
        )
        .bind(
          fleetId,
          data.id,
          data.tripId,
          data.categoryId,
          data.amountCents,
          data.date,
          data.sortOrder,
          createdAt,
          now,
        );
      break;
    case "maintenance":
      statement = d1
        .prepare(
          "INSERT INTO maintenance (fleet_id, id, vehicle_id, date, amount_cents, note, sort_order, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
        )
        .bind(
          fleetId,
          data.id,
          data.vehicleId,
          data.date,
          data.amountCents,
          data.note,
          data.sortOrder,
          createdAt,
          now,
        );
      break;
  }
  await statement.run();
}

async function updateRecord(
  d1: D1Database,
  fleetId: string,
  type: SyncType,
  data: Normalized,
  expectedVersion: number,
  nextVersion: number,
): Promise<boolean> {
  const now = new Date().toISOString();
  let statement: D1PreparedStatement;

  switch (type) {
    case "fleet_settings":
      statement = d1
        .prepare(
          "UPDATE fleet_settings SET theme = ?, last_report_seen = ?, last_backup_at = ?, active_vehicle_id = ?, period_start_date = ?, period_end_date = ?, updated_at = ?, version = ? WHERE fleet_id = ? AND version = ?",
        )
        .bind(
          data.theme,
          data.lastReportSeen,
          data.lastBackupAt,
          data.activeVehicleId,
          data.periodStartDate,
          data.periodEndDate,
          now,
          nextVersion,
          fleetId,
          expectedVersion,
        );
      break;
    case "category":
      statement = d1
        .prepare(
          "UPDATE categories SET name = ?, icon = ?, builtin = ?, active = ?, sort_order = ?, updated_at = ?, version = ? WHERE fleet_id = ? AND kind = ? AND id = ? AND version = ?",
        )
        .bind(
          data.name,
          data.icon,
          data.builtin ? 1 : 0,
          data.active ? 1 : 0,
          data.sortOrder,
          now,
          nextVersion,
          fleetId,
          data.kind,
          data.id,
          expectedVersion,
        );
      break;
    case "vehicle":
      statement = d1
        .prepare(
          "UPDATE vehicles SET name = ?, plate_no = ?, active = ?, sort_order = ?, updated_at = ?, version = ? WHERE fleet_id = ? AND id = ? AND version = ?",
        )
        .bind(
          data.name,
          data.plateNo,
          data.active ? 1 : 0,
          data.sortOrder,
          now,
          nextVersion,
          fleetId,
          data.id,
          expectedVersion,
        );
      break;
    case "trip":
      statement = d1
        .prepare(
          "UPDATE trips SET vehicle_id = ?, start_date = ?, end_date = ?, status = ?, closed_at = ?, sort_order = ?, updated_at = ?, version = ? WHERE fleet_id = ? AND id = ? AND version = ?",
        )
        .bind(
          data.vehicleId,
          data.startDate,
          data.endDate,
          data.status,
          data.closedAt,
          data.sortOrder,
          now,
          nextVersion,
          fleetId,
          data.id,
          expectedVersion,
        );
      break;
    case "trip_expense":
      statement = d1
        .prepare(
          "UPDATE trip_expenses SET category_id = ?, amount_cents = ?, date = ?, note = ?, sort_order = ?, updated_at = ?, version = ? WHERE fleet_id = ? AND trip_id = ? AND id = ? AND version = ?",
        )
        .bind(
          data.categoryId,
          data.amountCents,
          data.date,
          data.note,
          data.sortOrder,
          now,
          nextVersion,
          fleetId,
          data.tripId,
          data.id,
          expectedVersion,
        );
      break;
    case "trip_income":
      statement = d1
        .prepare(
          "UPDATE trip_incomes SET category_id = ?, amount_cents = ?, date = ?, sort_order = ?, updated_at = ?, version = ? WHERE fleet_id = ? AND trip_id = ? AND id = ? AND version = ?",
        )
        .bind(
          data.categoryId,
          data.amountCents,
          data.date,
          data.sortOrder,
          now,
          nextVersion,
          fleetId,
          data.tripId,
          data.id,
          expectedVersion,
        );
      break;
    case "maintenance":
      statement = d1
        .prepare(
          "UPDATE maintenance SET vehicle_id = ?, date = ?, amount_cents = ?, note = ?, sort_order = ?, updated_at = ?, version = ? WHERE fleet_id = ? AND id = ? AND version = ?",
        )
        .bind(
          data.vehicleId,
          data.date,
          data.amountCents,
          data.note,
          data.sortOrder,
          now,
          nextVersion,
          fleetId,
          data.id,
          expectedVersion,
        );
      break;
  }
  const result = await statement.run();
  return Number(result.meta.changes) === 1;
}

function physicalDeleteTarget(
  operation: SyncOperation,
  current: RawRow,
): { table: string; id: unknown; tripId?: unknown } {
  switch (operation.type) {
    case "trip":
      return { table: "trips", id: current.id };
    case "trip_expense":
      return {
        table: "trip_expenses",
        id: current.id,
        tripId: current.trip_id,
      };
    case "trip_income":
      return {
        table: "trip_incomes",
        id: current.id,
        tripId: current.trip_id,
      };
    case "maintenance":
      return { table: "maintenance", id: current.id };
    default:
      throw new RecordValidationError(
        "protected_record",
        "这类记录不能物理删除",
      );
  }
}

function conflict(
  operation: SyncOperation,
  current: RawRow | null,
): SyncResult {
  return {
    op: operation.op,
    type: operation.type,
    id: operation.id,
    status: "conflict",
    version: current ? Number(current.version) : null,
    current: current ? currentData(operation.type, current) : null,
    error: {
      code: "version_conflict",
      message: current
        ? "云端记录已被更新，请先刷新后再保存"
        : "云端记录已不存在，请先刷新后再保存",
    },
  };
}

async function authorizedConflict(
  d1: D1Database,
  actor: Actor,
  operation: SyncOperation,
  current: RawRow | null,
): Promise<SyncResult> {
  return authorizeBeforeExpose(
    current,
    (record) =>
      authorizeCurrentRecord(d1, actor, operation.type, record),
    (record) => conflict(operation, record),
  );
}

function rejected(
  operation: SyncOperation,
  code: string,
  message: string,
): SyncResult {
  return {
    op: operation.op,
    type: operation.type,
    id: operation.id,
    status: "rejected",
    error: { code, message },
  };
}

function currentData(type: SyncType, row: RawRow): Record<string, unknown> {
  switch (type) {
    case "fleet_settings":
      return {
        theme: row.theme,
        lastReportSeen: row.last_report_seen,
        lastBackupAt: row.last_backup_at,
        activeVehicleId: row.active_vehicle_id,
        periodStartDate: row.period_start_date,
        periodEndDate: row.period_end_date,
      };
    case "category":
      return {
        id: row.id,
        kind: row.kind,
        name: row.name,
        icon: row.icon,
        builtin: Boolean(row.builtin),
        active: Boolean(row.active),
        sortOrder: Number(row.sort_order),
      };
    case "vehicle":
      return vehicleData(row);
    case "trip":
      return tripData(row);
    case "trip_expense":
      return expenseData(row);
    case "trip_income":
      return incomeData(row);
    case "maintenance":
      return maintenanceData(row);
  }
}

function clientDataFromNormalized(
  type: SyncType,
  data: Normalized,
): Record<string, unknown> {
  if (
    type !== "trip_expense" &&
    type !== "trip_income" &&
    type !== "maintenance"
  ) {
    return { ...data };
  }
  const { amountCents, ...clientData } = data;
  return {
    ...clientData,
    amount: Number(amountCents) / 100,
  };
}

function assertSimpleId(operation: SyncOperation, dataId: string): void {
  if (operation.id !== dataId) {
    throw new RecordValidationError(
      "id_mismatch",
      "同步记录 id 与 data.id 不一致",
    );
  }
}

function assertChildId(
  operation: SyncOperation,
  tripId: string,
  dataId: string,
): void {
  if (operation.id !== `${tripId}:${dataId}`) {
    throw new RecordValidationError(
      "id_mismatch",
      "子账目同步 id 必须由 tripId 和记录 id 组成",
    );
  }
}

function dataRecordId(value: unknown, field: string): string {
  const id = requiredId(value, field);
  if (id.includes(":")) {
    throw new RecordValidationError(
      "invalid_id",
      `${field} 不能包含冒号`,
    );
  }
  return id;
}

function isConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /constraint|unique|foreign key|last_active_vehicle|vehicle_has_open_trip|vehicle_inactive|trip_has_entries/i.test(
    message,
  );
}

function readableConstraintMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/trips_one_open_per_vehicle/i.test(message)) {
    return "这辆车已有一趟在途中";
  }
  if (/trip_incomes_trip_category/i.test(message)) {
    return "同一趟同一收入科目只能有一条记录";
  }
  if (/foreign key/i.test(message)) {
    return "关联的车辆、趟次或科目不存在";
  }
  if (/last_active_vehicle/i.test(message)) {
    return "车队至少要保留一辆启用车辆";
  }
  if (/vehicle_has_open_trip/i.test(message)) {
    return "在途车辆不能停用";
  }
  if (/vehicle_inactive/i.test(message)) {
    return "停用车辆不能发车";
  }
  if (/trip_has_entries/i.test(message)) {
    return "这趟还有收入或支出，请刷新后重试";
  }
  return "记录与现有数据冲突，请刷新后重试";
}
