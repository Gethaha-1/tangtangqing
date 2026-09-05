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
  centsToAmount,
  dateValue,
  fuelDataFromScaled,
  isObject,
  normalizeFuelData,
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

export type AtomicSyncResponse = {
  operationId: string;
  results: SyncResult[];
  hasConflicts: false;
  hasRejected: false;
  syncedAt: string;
  replayed?: boolean;
};

export class AtomicSyncBatchError extends Error {
  status: 409 | 422;
  code: string;
  results?: SyncResult[];

  constructor(
    status: 409 | 422,
    code: string,
    message: string,
    results?: SyncResult[],
  ) {
    super(message);
    this.name = "AtomicSyncBatchError";
    this.status = status;
    this.code = code;
    this.results = results;
  }
}

type AtomicEntry =
  | {
      operation: SyncOperation;
      current: RawRow | null;
      normalized: Normalized;
      vehicleIds: string[];
      parentTripIds: string[];
      result: Extract<SyncResult, { status: "applied" }>;
    }
  | {
      operation: SyncOperation;
      current: RawRow;
      vehicleIds: string[];
      parentTripIds: string[];
      result: Extract<SyncResult, { status: "applied" }>;
    };

type BatchProjection = {
  puts: Map<string, Normalized>;
  deletes: Set<string>;
  tripCreates: Set<string>;
  snapshot?: BatchReadSnapshot;
};

type BatchReadSnapshot = {
  vehicles: Map<string, RawRow>;
  trips: Map<string, RawRow>;
  categories: Set<string>;
  assignedVehicles: Set<string>;
};

const BULK_TABLES: [SyncType, string][] = [
  ['fleet_settings', 'fleet_settings'], ['category', 'categories'], ['vehicle', 'vehicles'],
  ['trip', 'trips'], ['trip_expense', 'trip_expenses'], ['trip_income', 'trip_incomes'], ['maintenance', 'maintenance'],
];
function bulkRowId(type: SyncType, row: RawRow): string {
  if (type === 'fleet_settings') return 'settings';
  if (type === 'category') return `${row.kind}:${row.id}`;
  if (type === 'trip_expense' || type === 'trip_income') return `${row.trip_id}:${row.id}`;
  return String(row.id);
}

// Request-scoped, fleet-filtered preflight only. Transaction-time membership,
// assignment, parent and version guards still read the live database.
function relatedReadStatements(d1: D1Database, actor: Actor, operations: SyncOperation[]) {
  const tripIds = Array.from(new Set(operations.flatMap(operation => {
    if (operation.type === 'trip') return [operation.id];
    if (operation.type === 'trip_expense' || operation.type === 'trip_income')
      return [childRecordKey(operation.id).tripId];
    return [];
  })));
  const tripPredicate = tripIds.length ? ` OR id IN (${tripIds.map(() => '?').join(',')})` : '';
  return [
    d1.prepare('SELECT id, active FROM vehicles WHERE fleet_id = ?').bind(actor.fleetId),
    d1.prepare(`SELECT id, vehicle_id, status FROM trips WHERE fleet_id = ? AND (status = 'open'${tripPredicate})`).bind(actor.fleetId, ...tripIds),
    d1.prepare('SELECT id, kind FROM categories WHERE fleet_id = ?').bind(actor.fleetId),
    d1.prepare("SELECT vehicle_id FROM vehicle_assignments WHERE fleet_id = ? AND user_id = ? AND active = 1 AND datetime(starts_at) <= CURRENT_TIMESTAMP AND (ends_at IS NULL OR datetime(ends_at) > CURRENT_TIMESTAMP)").bind(actor.fleetId, actor.userId),
  ];
}

export async function hashSyncPayload(payload: string): Promise<string> {
  const bytes = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function applyAtomicSyncBatch(
  d1: D1Database,
  actor: Actor,
  operationId: string,
  requestHash: string,
  operations: SyncOperation[],
  finalize: boolean,
  restore?: { jobId: string; baseVersion: number },
): Promise<AtomicSyncResponse> {
  if (restore) requireOwner(actor);
  const preflight = await d1.batch([
    activeMembershipStatement(d1, actor),
    syncCommitStatement(d1, actor.fleetId, operationId),
    ...(restore
      ? BULK_TABLES.map(([, table]) => d1.prepare(`SELECT * FROM ${table} WHERE fleet_id = ?`).bind(actor.fleetId))
      : [...operations.map(operation => currentStatement(d1, actor.fleetId, operation)), ...relatedReadStatements(d1, actor, operations)]),
  ]);
  assertActiveMembership(
    actor,
    (preflight[0]?.results?.[0] as { role?: string } | undefined) ?? null,
  );
  const replay =
    (preflight[1]?.results?.[0] as {
      request_hash: string;
      response_json: string;
    } | undefined) ?? null;
  if (replay) return replaySyncCommit(replay, requestHash);
  let currentRows = preflight.slice(2, 2 + operations.length).map(
    (result) => (result.results?.[0] as RawRow | undefined) ?? null,
  );

  const projection = buildBatchProjection(operations);
  const related = preflight.slice(2 + operations.length);
  const rows = (index: number) => (related[index]?.results ?? []) as RawRow[];
  projection.snapshot = {
    vehicles: new Map(rows(0).map(row => [String(row.id), row])),
    trips: new Map(rows(1).map(row => [String(row.id), row])),
    categories: new Set(rows(2).map(row => `${row.kind}:${row.id}`)),
    assignedVehicles: new Set(rows(3).map(row => String(row.vehicle_id))),
  };
  if (restore) {
    // Seven set-based reads, not ten thousand point SELECTs. The atomic write
    // path below still uses the same validated operations and live guards.
    const index = new Map<string, RawRow>();
    const tableRows = new Map<SyncType, RawRow[]>();
    BULK_TABLES.forEach(([type], ordinal) => {
      const records = (preflight[2 + ordinal]?.results || []) as RawRow[];
      tableRows.set(type, records);
      records.forEach(row => index.set(`${type}\u0000${bulkRowId(type, row)}`, row));
    });
    currentRows = operations.map(operation => index.get(batchRecordKey(operation)) || null);
    projection.snapshot = {
      vehicles: new Map((tableRows.get('vehicle') || []).map(row => [String(row.id), row])),
      trips: new Map((tableRows.get('trip') || []).map(row => [String(row.id), row])),
      categories: new Set((tableRows.get('category') || []).map(row => `${row.kind}:${row.id}`)),
      assignedVehicles: new Set(), // Restore is owner-only.
    };
  }
  const entries: AtomicEntry[] = [];
  const failures: SyncResult[] = [];

  for (const [operationIndex, operation] of operations.entries()) {
    try {
      const current = currentRows[operationIndex] ?? null;
      if (current) {
        await authorizeCurrentRecord(
          d1,
          actor,
          operation.type,
          current,
          true,
          projection.snapshot,
        );
      }

      if (operation.op === "delete") {
        if (operation.type === "fleet_settings") {
          throw new RecordValidationError(
            "protected_record",
            "不能删除车队设置",
          );
        }
        if (
          !current ||
          classifyVersion(
            operation.expectedVersion,
            Number(current.version),
          ) !== "update"
        ) {
          failures.push(conflict(operation, current));
          continue;
        }
        if (operation.type === "vehicle") {
          requireOwner(actor);
        }
        if (operation.type === "category") {
          requireOwner(actor);
        }
        const authorization = await operationAuthorizationFootprint(
          d1,
          actor.fleetId,
          operation,
          current,
          undefined,
          projection,
        );
        entries.push({
          operation,
          current,
          ...authorization,
          result: {
            op: operation.op,
            type: operation.type,
            id: operation.id,
            status: "applied",
            version: operation.expectedVersion + 1,
          },
        });
        continue;
      }

      const normalized = projection.puts.get(batchRecordKey(operation));
      if (!normalized) {
        throw new RecordValidationError(
          "missing_data",
          "同步记录缺少 data",
        );
      }
      if ("createdAt" in normalized && !normalized.createdAt) {
        normalized.createdAt =
          (current?.created_at as string | undefined) ??
          new Date().toISOString();
      }
      const decision = classifyVersion(
        operation.expectedVersion,
        current ? Number(current.version) : null,
      );
      if (decision === "conflict") {
        failures.push(conflict(operation, current));
        continue;
      }
      await validateRelationships(
        d1,
        actor,
        operation,
        normalized,
        current,
        projection,
      );
      const authorization = await operationAuthorizationFootprint(
        d1,
        actor.fleetId,
        operation,
        current,
        normalized,
        projection,
      );
      entries.push({
        operation,
        current,
        normalized,
        ...authorization,
        result: {
          op: operation.op,
          type: operation.type,
          id: operation.id,
          status: "applied",
          version: operation.expectedVersion + 1,
          data: clientDataFromNormalized(operation.type, normalized),
        },
      });
    } catch (error) {
      if (error instanceof RecordValidationError) {
        failures.push(rejected(operation, error.code, error.message));
        continue;
      }
      throw error;
    }
  }

  if (failures.length) {
    const conflictFound = failures.some(
      (result) => result.status === "conflict",
    );
    throw new AtomicSyncBatchError(
      conflictFound ? 409 : 422,
      conflictFound ? "version_conflict" : "batch_rejected",
      conflictFound
        ? "云端记录已变化，本批次没有写入"
        : "本批次有记录未通过校验，所有记录都没有写入",
      failures,
    );
  }

  const syncedAt = new Date().toISOString();
  const response: AtomicSyncResponse = {
    operationId,
    results: entries.map((entry) => entry.result),
    hasConflicts: false,
    hasRejected: false,
    syncedAt,
  };
  // Authorization is checked again inside the same database transaction as the
  // business writes. A membership revocation/role change racing the preflight
  // therefore aborts the whole batch instead of permitting a stale actor.
  const statements: D1PreparedStatement[] = [
    prepareActorGuard(d1, actor, operationId),
  ];
  if (restore) {
    // This guard and the task receipt share the business transaction. A new
    // record on another device (not present in operations) also invalidates a
    // full replacement; per-record expectedVersion alone cannot detect it.
    requireOwner(actor);
    statements.push(d1.prepare(`INSERT INTO sync_assertions (fleet_id, operation_id, ordinal, ok)
      VALUES (?, ?, -2147483648, CASE WHEN EXISTS (
        SELECT 1 FROM fleets f JOIN restore_jobs j ON j.fleet_id = f.id
        WHERE f.id = ? AND f.version = ? AND j.id = ? AND j.status = 'ready'
          AND j.membership_id = ? AND j.user_id = ? AND j.expires_at > ?
      ) THEN 1 ELSE 0 END)`).bind(actor.fleetId, operationId, actor.fleetId,
        restore.baseVersion, restore.jobId, actor.membershipId, actor.userId, syncedAt));
  }
  const assignmentVehicleIds = assignmentGuardVehicleIds(
    actor.role,
    entries,
  );
  assignmentVehicleIds.forEach(
    (vehicleId, index) => {
      statements.push(
        prepareAssignmentGuard(
          d1,
          actor,
          operationId,
          -2 - index,
          vehicleId,
        ),
      );
    },
  );
  // A child version guard cannot detect its parent trip moving vehicles.
  // Re-authorize each existing parent against its current vehicle in-transaction.
  parentTripGuardIds(actor.role, entries).forEach((tripId, index) => {
    statements.push(
      prepareParentTripAssignmentGuard(
        d1,
        actor,
        operationId,
        -2 - assignmentVehicleIds.length - index,
        tripId,
      ),
    );
  });
  entries.forEach((entry, ordinal) => {
    statements.push(
      prepareVersionGuard(
        d1,
        actor.fleetId,
        operationId,
        ordinal,
        entry.operation,
      ),
      prepareAtomicWrite(d1, actor.fleetId, entry),
    );
  });
  statements.push(
    d1
      .prepare(
        "DELETE FROM sync_assertions WHERE fleet_id = ? AND operation_id = ?",
      )
      .bind(actor.fleetId, operationId),
  );
  if (finalize && entries.length > 0) {
    statements.push(
      d1
        .prepare(
          "UPDATE fleet_settings SET initialized_at = COALESCE(initialized_at, ?) WHERE fleet_id = ?",
        )
        .bind(syncedAt, actor.fleetId),
    );
  }
  statements.push(
    d1
      .prepare(
        "INSERT INTO sync_commits (fleet_id, operation_id, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        actor.fleetId,
        operationId,
        requestHash,
        JSON.stringify(response),
        syncedAt,
      ),
  );

  if (restore) {
    statements.push(d1.prepare("UPDATE restore_jobs SET status = 'complete' WHERE fleet_id = ? AND id = ?")
      .bind(actor.fleetId, restore.jobId));
    statements.push(d1.prepare("DELETE FROM restore_chunks WHERE fleet_id = ? AND job_id = ?")
      .bind(actor.fleetId, restore.jobId));
  }

  try {
    await d1.batch(statements);
    return response;
  } catch (error) {
    const raced = await readSyncCommit(d1, actor.fleetId, operationId);
    if (raced) return replaySyncCommit(raced, requestHash);
    const message = error instanceof Error ? error.message : String(error);
    if (/sync_assertions_ok_check|CHECK constraint failed: ok/i.test(message)) {
      throw new AtomicSyncBatchError(
        409,
        "version_conflict",
        "云端记录已变化，本批次没有写入",
      );
    }
    if (isConstraintError(error)) {
      throw new AtomicSyncBatchError(
        422,
        "constraint_failed",
        readableConstraintMessage(error) +
          "；本批次所有记录都没有写入",
      );
    }
    throw error;
  }
}

function buildBatchProjection(
  operations: SyncOperation[],
): BatchProjection {
  const puts = new Map<string, Normalized>();
  const deletes = new Set<string>();
  const tripCreates = batchTripCreateIds(operations);
  for (const operation of operations) {
    const key = batchRecordKey(operation);
    if (operation.op === "put") {
      puts.set(key, normalizePut(operation));
    } else {
      deletes.add(key);
    }
  }
  return { puts, deletes, tripCreates };
}

export function batchTripCreateIds(
  operations: ReadonlyArray<
    Pick<SyncOperation, "expectedVersion" | "op" | "type" | "id">
  >,
): Set<string> {
  return new Set(
    operations
      .filter(
        (operation) =>
          operation.type === "trip" &&
          operation.op === "put" &&
          operation.expectedVersion === 0,
      )
      .map((operation) => operation.id),
  );
}

function batchRecordKey(
  operation: Pick<SyncOperation, "type" | "id">,
): string {
  return `${operation.type}\u0000${operation.id}`;
}

async function readSyncCommit(
  d1: D1Database,
  fleetId: string,
  operationId: string,
): Promise<{ request_hash: string; response_json: string } | null> {
  return syncCommitStatement(d1, fleetId, operationId)
    .first<{ request_hash: string; response_json: string }>();
}

function syncCommitStatement(
  d1: D1Database,
  fleetId: string,
  operationId: string,
): D1PreparedStatement {
  return d1
    .prepare(
      "SELECT request_hash, response_json FROM sync_commits WHERE fleet_id = ? AND operation_id = ? LIMIT 1",
    )
    .bind(fleetId, operationId);
}

function replaySyncCommit(
  row: { request_hash: string; response_json: string },
  requestHash: string,
): AtomicSyncResponse {
  if (row.request_hash !== requestHash) {
    throw new AtomicSyncBatchError(
      409,
      "operation_id_reused",
      "这个 operationId 已用于另一批数据，请为新操作生成新的标识",
    );
  }
  const response = JSON.parse(row.response_json) as AtomicSyncResponse;
  return { ...response, replayed: true };
}

function prepareVersionGuard(
  d1: D1Database,
  fleetId: string,
  operationId: string,
  ordinal: number,
  operation: SyncOperation,
): D1PreparedStatement {
  const target = versionGuardTarget(operation);
  const predicate =
    operation.expectedVersion === 0
      ? `NOT EXISTS (SELECT 1 FROM ${target.table} WHERE ${target.where})`
      : `EXISTS (SELECT 1 FROM ${target.table} WHERE ${target.where} AND version = ?)`;
  const values: unknown[] = [
    fleetId,
    operationId,
    ordinal,
    fleetId,
    ...target.values,
  ];
  if (operation.expectedVersion !== 0) {
    values.push(operation.expectedVersion);
  }
  return d1
    .prepare(
      `INSERT INTO sync_assertions (fleet_id, operation_id, ordinal, ok)
       VALUES (?, ?, ?, CASE WHEN ${predicate} THEN 1 ELSE 0 END)`,
    )
    .bind(...values);
}

function prepareActorGuard(
  d1: D1Database,
  actor: Actor,
  operationId: string,
): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO sync_assertions (fleet_id, operation_id, ordinal, ok)
       VALUES (
         ?, ?, -1,
         CASE WHEN EXISTS (
           SELECT 1
           FROM fleet_members
           WHERE id = ?
             AND fleet_id = ?
             AND user_id = ?
             AND active = 1
             AND version = ?
             AND role = ?
         ) THEN 1 ELSE 0 END
       )`,
    )
    .bind(
      actor.fleetId,
      operationId,
      actor.membershipId,
      actor.fleetId,
      actor.userId,
      actor.membershipVersion,
      actor.role,
    );
}

function prepareAssignmentGuard(
  d1: D1Database,
  actor: Actor,
  operationId: string,
  ordinal: number,
  vehicleId: string,
): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO sync_assertions (fleet_id, operation_id, ordinal, ok)
       VALUES (
         ?, ?, ?,
         CASE WHEN EXISTS (
           SELECT 1
           FROM vehicle_assignments
           WHERE fleet_id = ?
             AND user_id = ?
             AND vehicle_id = ?
             AND active = 1
             AND datetime(starts_at) <= CURRENT_TIMESTAMP
             AND (ends_at IS NULL OR datetime(ends_at) > CURRENT_TIMESTAMP)
         ) THEN 1 ELSE 0 END
       )`,
    )
    .bind(
      actor.fleetId,
      operationId,
      ordinal,
      actor.fleetId,
      actor.userId,
      vehicleId,
    );
}

function prepareParentTripAssignmentGuard(
  d1: D1Database,
  actor: Actor,
  operationId: string,
  ordinal: number,
  tripId: string,
): D1PreparedStatement {
  return d1
    .prepare(
      `INSERT INTO sync_assertions (fleet_id, operation_id, ordinal, ok)
       VALUES (
         ?, ?, ?,
         CASE WHEN EXISTS (
           SELECT 1
           FROM trips AS t
           JOIN vehicle_assignments AS a
             ON a.fleet_id = t.fleet_id
            AND a.vehicle_id = t.vehicle_id
            AND a.user_id = ?
            AND a.active = 1
            AND datetime(a.starts_at) <= CURRENT_TIMESTAMP
            AND (a.ends_at IS NULL OR datetime(a.ends_at) > CURRENT_TIMESTAMP)
           WHERE t.fleet_id = ?
             AND t.id = ?
         ) THEN 1 ELSE 0 END
       )`,
    )
    .bind(
      actor.fleetId,
      operationId,
      ordinal,
      actor.userId,
      actor.fleetId,
      tripId,
    );
}

function versionGuardTarget(operation: SyncOperation): {
  table: string;
  where: string;
  values: unknown[];
} {
  if (operation.type === "fleet_settings") {
    return {
      table: "fleet_settings",
      where: "fleet_id = ?",
      values: [],
    };
  }
  if (operation.type === "category") {
    const separator = operation.id.indexOf(":");
    return {
      table: "categories",
      where: "fleet_id = ? AND kind = ? AND id = ?",
      values: [
        operation.id.slice(0, separator),
        operation.id.slice(separator + 1),
      ],
    };
  }
  if (
    operation.type === "trip_expense" ||
    operation.type === "trip_income"
  ) {
    const child = childRecordKey(operation.id);
    return {
      table:
        operation.type === "trip_expense"
          ? "trip_expenses"
          : "trip_incomes",
      where: "fleet_id = ? AND trip_id = ? AND id = ?",
      values: [child.tripId, child.id],
    };
  }
  const target = recordTarget(operation);
  return {
    table: target.table,
    where: "fleet_id = ? AND id = ?",
    values: [target.id],
  };
}

function prepareAtomicWrite(
  d1: D1Database,
  fleetId: string,
  entry: AtomicEntry,
): D1PreparedStatement {
  const { operation } = entry;
  if (operation.op === "put" && "normalized" in entry) {
    if (entry.current) {
      return prepareUpdateRecord(
        d1,
        fleetId,
        operation.type,
        entry.normalized,
        operation.expectedVersion,
        operation.expectedVersion + 1,
      );
    }
    return prepareInsertRecord(
      d1,
      fleetId,
      operation.type,
      entry.normalized,
    );
  }

  const current = entry.current;
  if (!current) {
    throw new Error("原子删除缺少预检记录");
  }
  const nextVersion = operation.expectedVersion + 1;
  const now = new Date().toISOString();
  if (operation.type === "category") {
    return d1
      .prepare(
        "UPDATE categories SET active = 0, updated_at = ?, version = ? WHERE fleet_id = ? AND kind = ? AND id = ? AND version = ?",
      )
      .bind(
        now,
        nextVersion,
        fleetId,
        current.kind,
        current.id,
        operation.expectedVersion,
      );
  }
  if (operation.type === "vehicle") {
    return d1
      .prepare(
        "UPDATE vehicles SET active = 0, updated_at = ?, version = ? WHERE fleet_id = ? AND id = ? AND version = ?",
      )
      .bind(
        now,
        nextVersion,
        fleetId,
        current.id,
        operation.expectedVersion,
      );
  }
  const target = physicalDeleteTarget(operation, current);
  if (target.tripId) {
    return d1
      .prepare(
        `DELETE FROM ${target.table} WHERE fleet_id = ? AND trip_id = ? AND id = ? AND version = ?`,
      )
      .bind(
        fleetId,
        target.tripId,
        target.id,
        operation.expectedVersion,
      );
  }
  return d1
    .prepare(
      `DELETE FROM ${target.table} WHERE fleet_id = ? AND id = ? AND version = ?`,
    )
    .bind(fleetId, target.id, operation.expectedVersion);
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
  const categoryId = dataRecordId(
    data.categoryId ?? data.catId,
    "trip_expense.categoryId",
  );
  const amountCents = amountToCents(data.amount);
  const fuel = normalizeFuelData(categoryId, data.amount, data.fuel);
  return {
    id,
    tripId,
    categoryId,
    amountCents,
    ...fuel,
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

export function authorizationVehicleFootprint(
  operation: Pick<SyncOperation, "op" | "type">,
  current: RawRow | null,
  normalized: Normalized | undefined,
  currentTrip?: RawRow | null,
  projectedTrip?: RawRow | null,
): string[] {
  const vehicleIds: string[] = [];
  const addVehicleId = (value: unknown): void => {
    if (value == null) return;
    const vehicleId = String(value);
    if (vehicleId && !vehicleIds.includes(vehicleId)) {
      vehicleIds.push(vehicleId);
    }
  };

  if (operation.type === "trip" || operation.type === "maintenance") {
    addVehicleId(current?.vehicle_id);
    if (operation.op === "put") addVehicleId(normalized?.vehicleId);
  } else if (
    operation.type === "trip_expense" ||
    operation.type === "trip_income"
  ) {
    addVehicleId(currentTrip?.vehicle_id ?? currentTrip?.vehicleId);
    addVehicleId(projectedTrip?.vehicle_id ?? projectedTrip?.vehicleId);
  }
  return vehicleIds;
}

export function assignmentGuardVehicleIds(
  role: Actor["role"],
  entries: ReadonlyArray<{ vehicleIds: readonly string[] }>,
): string[] {
  if (role !== "driver") return [];
  return Array.from(
    new Set(entries.flatMap((entry) => entry.vehicleIds)),
  );
}

export function parentTripGuardIds(
  role: Actor["role"],
  entries: ReadonlyArray<{ parentTripIds: readonly string[] }>,
): string[] {
  if (role !== "driver") return [];
  return Array.from(
    new Set(entries.flatMap((entry) => entry.parentTripIds)),
  );
}

async function operationAuthorizationFootprint(
  d1: D1Database,
  fleetId: string,
  operation: SyncOperation,
  current: RawRow | null,
  normalized: Normalized | undefined,
  projection: BatchProjection,
): Promise<{ vehicleIds: string[]; parentTripIds: string[] }> {
  if (
    operation.type === "fleet_settings" ||
    operation.type === "category" ||
    operation.type === "vehicle"
  ) {
    return { vehicleIds: [], parentTripIds: [] };
  }
  if (operation.type === "trip" || operation.type === "maintenance") {
    return {
      vehicleIds: authorizationVehicleFootprint(
        operation,
        current,
        normalized,
      ),
      parentTripIds: [],
    };
  }
  const tripId = String(normalized?.tripId ?? current?.trip_id ?? "");
  if (!tripId) return { vehicleIds: [], parentTripIds: [] };
  const currentTrip = await findTrip(d1, fleetId, tripId, projection.snapshot);
  const targetTrip = projection.deletes.has(`trip\u0000${tripId}`)
    ? null
    : await projectedTrip(d1, fleetId, tripId, projection);
  return {
    vehicleIds: authorizationVehicleFootprint(
      operation,
      current,
      normalized,
      currentTrip,
      targetTrip,
    ),
    parentTripIds: projection.tripCreates.has(tripId) ? [] : [tripId],
  };
}

async function validateRelationships(
  d1: D1Database,
  actor: Actor,
  operation: SyncOperation,
  data: Normalized,
  current: RawRow | null,
  projection?: BatchProjection,
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
        !(await projectedVehicleExists(
          d1,
          actor.fleetId,
          activeVehicleId,
          projection,
        ))
      ) {
        throw new RecordValidationError(
          "vehicle_not_found",
          "当前车辆不属于这个车队",
        );
      }
      break;
    }
    case "vehicle": {
      if (data.active === false && !projection) {
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
      const vehicle = await projectedVehicle(
        d1,
        actor.fleetId,
        vehicleId,
        projection,
      );
      if (data.status === "open" && !Boolean(vehicle.active)) {
        throw new RecordValidationError(
          "vehicle_inactive",
          "停用车辆不能发车",
        );
      }
      await requireVehicleWriteAccess(d1, actor, vehicleId, projection?.snapshot);
      if (data.status === "open") {
        if (projection) {
          const otherProjectedOpen = Array.from(
            projection.puts.entries(),
          ).find(([key, value]) =>
            key.startsWith("trip\u0000") &&
            key !== batchRecordKey(operation) &&
            value.vehicleId === vehicleId &&
            value.status === "open"
          );
          if (otherProjectedOpen) {
            throw new RecordValidationError(
              "vehicle_has_open_trip",
              "这辆车同一批次里已有另一趟在途中",
            );
          }
        }
        const other = projection?.snapshot
          ? Array.from(projection.snapshot.trips.values()).find(trip =>
              trip.status === 'open' && trip.vehicle_id === vehicleId && trip.id !== data.id) ?? null
          : await d1
          .prepare(
            "SELECT id FROM trips WHERE fleet_id = ? AND vehicle_id = ? AND status = 'open' AND id <> ? LIMIT 1",
          )
          .bind(actor.fleetId, vehicleId, data.id)
          .first();
        const otherId = other && String((other as RawRow).id);
        const otherWillClose =
          otherId &&
          projection &&
          (projection.deletes.has(`trip\u0000${otherId}`) ||
            (projection.puts.has(`trip\u0000${otherId}`) &&
              projection.puts.get(`trip\u0000${otherId}`)?.status !==
                "open"));
        if (other && !otherWillClose) {
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
      const trip = await projectedTrip(
        d1,
        actor.fleetId,
        String(data.tripId),
        projection,
      );
      await requireVehicleWriteAccess(
        d1,
        actor,
        String(trip.vehicle_id ?? trip.vehicleId),
        projection?.snapshot,
      );
      await requireProjectedCategory(
        d1,
        actor.fleetId,
        String(data.categoryId),
        operation.type === "trip_expense" ? "expense" : "income",
        projection,
      );
      break;
    }
    case "maintenance": {
      const vehicleId = String(data.vehicleId);
      await projectedVehicle(
        d1,
        actor.fleetId,
        vehicleId,
        projection,
      );
      await requireVehicleWriteAccess(d1, actor, vehicleId, projection?.snapshot);
      break;
    }
  }
}

async function projectedVehicleExists(
  d1: D1Database,
  fleetId: string,
  vehicleId: string,
  projection?: BatchProjection,
): Promise<boolean> {
  const key = `vehicle\u0000${vehicleId}`;
  if (projection?.deletes.has(key)) return false;
  if (projection?.puts.has(key)) return true;
  return vehicleExists(d1, fleetId, vehicleId, projection?.snapshot);
}

async function projectedVehicle(
  d1: D1Database,
  fleetId: string,
  vehicleId: string,
  projection?: BatchProjection,
): Promise<RawRow> {
  const key = `vehicle\u0000${vehicleId}`;
  if (projection?.deletes.has(key)) {
    throw new RecordValidationError(
      "vehicle_not_found",
      "车辆在本批次中已停用或删除",
    );
  }
  const proposed = projection?.puts.get(key);
  if (proposed) {
    return {
      id: proposed.id,
      active: proposed.active,
    };
  }
  return requireVehicle(d1, fleetId, vehicleId, projection?.snapshot);
}

async function projectedTrip(
  d1: D1Database,
  fleetId: string,
  tripId: string,
  projection?: BatchProjection,
): Promise<RawRow> {
  const key = `trip\u0000${tripId}`;
  if (projection?.deletes.has(key)) {
    throw new RecordValidationError(
      "trip_not_found",
      "趟次在本批次中已删除",
    );
  }
  const proposed = projection?.puts.get(key);
  if (proposed) {
    return {
      id: proposed.id,
      vehicle_id: proposed.vehicleId,
    };
  }
  return requireTrip(d1, fleetId, tripId, projection?.snapshot);
}

async function requireProjectedCategory(
  d1: D1Database,
  fleetId: string,
  categoryId: string,
  kind: "expense" | "income",
  projection?: BatchProjection,
): Promise<void> {
  const key = `category\u0000${kind}:${categoryId}`;
  if (projection?.deletes.has(key)) {
    throw new RecordValidationError(
      "category_not_found",
      "科目在本批次中已停用或删除",
    );
  }
  const proposed = projection?.puts.get(key);
  if (proposed) {
    if (proposed.kind !== kind) {
      throw new RecordValidationError(
        "category_not_found",
        "科目类型不匹配",
      );
    }
    return;
  }
  return requireCategory(d1, fleetId, categoryId, kind, projection?.snapshot);
}

async function authorizeCurrentRecord(
  d1: D1Database,
  actor: Actor,
  type: SyncType,
  current: RawRow,
  membershipAlreadyVerified = false,
  snapshot?: BatchReadSnapshot,
): Promise<void> {
  if (!membershipAlreadyVerified) await requireActiveMembership(d1, actor);
  if (type === "category" || type === "vehicle" || type === "fleet_settings") {
    requireOwner(actor);
    return;
  }
  if (type === "trip" || type === "maintenance") {
    await requireVehicleWriteAccess(
      d1,
      actor,
      String(current.vehicle_id),
      snapshot,
    );
    return;
  }
  const trip = await requireTrip(
    d1,
    actor.fleetId,
    String(current.trip_id),
    snapshot,
  );
  await requireVehicleWriteAccess(d1, actor, String(trip.vehicle_id), snapshot);
}

async function requireActiveMembership(
  d1: D1Database,
  actor: Actor,
): Promise<void> {
  const membership = await activeMembershipStatement(d1, actor)
    .first<{ role: string }>();
  assertActiveMembership(actor, membership);
}

function activeMembershipStatement(
  d1: D1Database,
  actor: Actor,
): D1PreparedStatement {
  return d1
    .prepare(
      "SELECT role FROM fleet_members WHERE id = ? AND fleet_id = ? AND user_id = ? AND active = 1 LIMIT 1",
    )
    .bind(actor.membershipId, actor.fleetId, actor.userId);
}

function assertActiveMembership(
  actor: Actor,
  membership: { role?: string } | null,
): void {
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
  snapshot?: BatchReadSnapshot,
): Promise<void> {
  if (roleCanWriteVehicle(actor.role, false)) return;
  const assignment = snapshot ? snapshot.assignedVehicles.has(vehicleId) : await d1
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
  snapshot?: BatchReadSnapshot,
): Promise<boolean> {
  if (snapshot) return snapshot.vehicles.has(vehicleId);
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
  snapshot?: BatchReadSnapshot,
): Promise<RawRow> {
  const vehicle = snapshot ? snapshot.vehicles.get(vehicleId) : await d1
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
  snapshot?: BatchReadSnapshot,
): Promise<RawRow> {
  const trip = await findTrip(d1, fleetId, tripId, snapshot);
  if (!trip) {
    throw new RecordValidationError(
      "trip_not_found",
      "趟次不存在或不属于这个车队",
    );
  }
  return trip;
}

async function findTrip(
  d1: D1Database,
  fleetId: string,
  tripId: string,
  snapshot?: BatchReadSnapshot,
): Promise<RawRow | null> {
  if (snapshot) return snapshot.trips.get(tripId) ?? null;
  return d1
    .prepare("SELECT * FROM trips WHERE fleet_id = ? AND id = ? LIMIT 1")
    .bind(fleetId, tripId)
    .first<RawRow>();
}

async function requireCategory(
  d1: D1Database,
  fleetId: string,
  categoryId: string,
  kind: "expense" | "income",
  snapshot?: BatchReadSnapshot,
): Promise<void> {
  const category = snapshot ? snapshot.categories.has(`${kind}:${categoryId}`) : await d1
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
  return currentStatement(d1, fleetId, operation).first<RawRow>();
}

function currentStatement(
  d1: D1Database,
  fleetId: string,
  operation: SyncOperation,
): D1PreparedStatement {
  if (operation.type === "fleet_settings") {
    return d1
      .prepare("SELECT * FROM fleet_settings WHERE fleet_id = ? LIMIT 1")
      .bind(fleetId);
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
      .bind(fleetId, kind, id);
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
      .bind(fleetId, tripId, id);
  }
  const target = recordTarget(operation);
  return d1
    .prepare(
      `SELECT * FROM ${target.table} WHERE fleet_id = ? AND id = ? LIMIT 1`,
    )
    .bind(fleetId, target.id);
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
  await prepareInsertRecord(d1, fleetId, type, data).run();
}

function prepareInsertRecord(
  d1: D1Database,
  fleetId: string,
  type: SyncType,
  data: Normalized,
): D1PreparedStatement {
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
          "INSERT INTO trip_expenses (fleet_id, id, trip_id, category_id, amount_cents, fuel_unit_price_x10000, fuel_volume_ml, date, note, sort_order, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
        )
        .bind(
          fleetId,
          data.id,
          data.tripId,
          data.categoryId,
          data.amountCents,
          data.fuelUnitPriceX10000,
          data.fuelVolumeMl,
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
  return statement;
}

async function updateRecord(
  d1: D1Database,
  fleetId: string,
  type: SyncType,
  data: Normalized,
  expectedVersion: number,
  nextVersion: number,
): Promise<boolean> {
  const result = await prepareUpdateRecord(
    d1,
    fleetId,
    type,
    data,
    expectedVersion,
    nextVersion,
  ).run();
  return Number(result.meta.changes) === 1;
}

function prepareUpdateRecord(
  d1: D1Database,
  fleetId: string,
  type: SyncType,
  data: Normalized,
  expectedVersion: number,
  nextVersion: number,
): D1PreparedStatement {
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
          "UPDATE trip_expenses SET category_id = ?, amount_cents = ?, fuel_unit_price_x10000 = ?, fuel_volume_ml = ?, date = ?, note = ?, sort_order = ?, updated_at = ?, version = ? WHERE fleet_id = ? AND trip_id = ? AND id = ? AND version = ?",
        )
        .bind(
          data.categoryId,
          data.amountCents,
          data.fuelUnitPriceX10000,
          data.fuelVolumeMl,
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
  return statement;
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
  const {
    amountCents,
    fuelUnitPriceX10000,
    fuelVolumeMl,
    ...clientData
  } = data;
  if (type === "trip_expense") {
    const amount = centsToAmount(amountCents);
    const fuel = fuelDataFromScaled(
      fuelUnitPriceX10000,
      fuelVolumeMl,
    );
    normalizeFuelData(String(data.categoryId), amount, fuel);
    return {
      ...clientData,
      amount,
      ...(fuel === undefined ? {} : { fuel }),
    };
  }
  return {
    ...clientData,
    amount: centsToAmount(amountCents),
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
