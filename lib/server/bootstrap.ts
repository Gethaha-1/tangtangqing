import type { TrustedIdentity } from "./auth";
import { centsToAmount } from "./sync-contract";

export type Actor = {
  userId: string;
  identityId: string;
  fleetId: string;
  fleetName: string;
  fleetVersion: number;
  membershipId: string;
  membershipVersion: number;
  role: "owner" | "driver";
};

type ActorRow = {
  user_id: string;
  identity_id: string;
  fleet_id: string;
  fleet_name: string;
  fleet_version: number;
  membership_id: string;
  membership_version: number;
  role: "owner" | "driver";
};

type RawRow = Record<string, unknown>;

export async function resolveOrCreateActor(
  d1: D1Database,
  identity: TrustedIdentity,
): Promise<Actor> {
  const existing = await findActor(d1, identity);
  if (existing) return actorFromRow(existing);

  const now = new Date().toISOString();
  const year = now.slice(0, 4);
  const userId = crypto.randomUUID();
  const identityId = crypto.randomUUID();
  const fleetId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const fleetName = `${identity.displayName.slice(0, 70)}的车队`;

  const statements = [
    d1
      .prepare(
        "INSERT INTO users (id, display_name, created_at, updated_at, version) VALUES (?, ?, ?, ?, 1)",
      )
      .bind(userId, identity.displayName, now, now),
    d1
      .prepare(
        "INSERT INTO identities (id, user_id, provider, provider_subject, email, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
      )
      .bind(
        identityId,
        userId,
        identity.provider,
        identity.providerSubject,
        identity.email,
        now,
        now,
      ),
    d1
      .prepare(
        "INSERT INTO fleets (id, name, created_by_user_id, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, 1)",
      )
      .bind(fleetId, fleetName, userId, now, now),
    d1
      .prepare(
        "INSERT INTO fleet_members (id, fleet_id, user_id, role, active, created_at, updated_at, version) VALUES (?, ?, ?, 'owner', 1, ?, ?, 1)",
      )
      .bind(membershipId, fleetId, userId, now, now),
    d1
      .prepare(
        "INSERT INTO fleet_settings (fleet_id, theme, last_report_seen, last_backup_at, active_vehicle_id, period_start_date, period_end_date, initialized_at, created_at, updated_at, version) VALUES (?, 'day', '', '', 'all', ?, ?, NULL, ?, ?, 1)",
      )
      .bind(fleetId, `${year}-01-01`, `${year}-12-31`, now, now),
  ];

  try {
    // D1 batch is transactional. Every prepared item above contains one SQL
    // statement, which keeps runtime initialization Sites-compatible.
    await d1.batch(statements);
  } catch (error) {
    // Two first requests can race. The provider/subject unique constraint lets
    // the winner create the account; the loser safely re-reads it.
    const raced = await findActor(d1, identity);
    if (raced) return actorFromRow(raced);
    throw error;
  }

  return {
    userId,
    identityId,
    fleetId,
    fleetName,
    fleetVersion: 1,
    membershipId,
    membershipVersion: 1,
    role: "owner",
  };
}

export async function loadBootstrap(d1: D1Database, actor: Actor) {
  const results = await d1.batch([
    d1
      .prepare("SELECT * FROM fleet_settings WHERE fleet_id = ? LIMIT 1")
      .bind(actor.fleetId),
    d1
      .prepare(
        "SELECT * FROM categories WHERE fleet_id = ? ORDER BY sort_order, created_at, id",
      )
      .bind(actor.fleetId),
    d1
      .prepare(
        "SELECT * FROM vehicles WHERE fleet_id = ? ORDER BY sort_order, created_at, id",
      )
      .bind(actor.fleetId),
    d1
      .prepare(
        "SELECT * FROM trips WHERE fleet_id = ? ORDER BY sort_order, created_at, id",
      )
      .bind(actor.fleetId),
    d1
      .prepare(
        "SELECT * FROM trip_expenses WHERE fleet_id = ? ORDER BY sort_order, created_at, id",
      )
      .bind(actor.fleetId),
    d1
      .prepare(
        "SELECT * FROM trip_incomes WHERE fleet_id = ? ORDER BY sort_order, created_at, id",
      )
      .bind(actor.fleetId),
    d1
      .prepare(
        "SELECT * FROM maintenance WHERE fleet_id = ? ORDER BY sort_order, created_at, id",
      )
      .bind(actor.fleetId),
    d1
      .prepare(
        "SELECT vehicle_id FROM vehicle_assignments WHERE fleet_id = ? AND user_id = ? AND active = 1 AND datetime(starts_at) <= CURRENT_TIMESTAMP AND (ends_at IS NULL OR datetime(ends_at) > CURRENT_TIMESTAMP)",
      )
      .bind(actor.fleetId, actor.userId),
  ]);

  const [
    settingsResult,
    categoriesResult,
    vehiclesResult,
    tripsResult,
    expensesResult,
    incomesResult,
    maintenanceResult,
    assignmentsResult,
  ] = results;
  const settings = rows(settingsResult)[0];
  if (!settings) throw new Error("车队设置不存在");

  const assignedVehicleIds =
    actor.role === "owner"
      ? null
      : new Set(
          rows(assignmentsResult).map((row) => String(row.vehicle_id)),
        );
  const canSeeVehicle = (id: unknown) =>
    assignedVehicleIds === null || assignedVehicleIds.has(String(id));

  const vehiclesRows = rows(vehiclesResult).filter((row) =>
    canSeeVehicle(row.id),
  );
  const tripRows = rows(tripsResult).filter((row) =>
    canSeeVehicle(row.vehicle_id),
  );
  const visibleTripIds = new Set(tripRows.map((row) => String(row.id)));
  const expenseRows = rows(expensesResult).filter((row) =>
    visibleTripIds.has(String(row.trip_id)),
  );
  const incomeRows = rows(incomesResult).filter((row) =>
    visibleTripIds.has(String(row.trip_id)),
  );
  const maintenanceRows = rows(maintenanceResult).filter((row) =>
    canSeeVehicle(row.vehicle_id),
  );

  const records = [
    {
      type: "fleet_settings",
      id: "settings",
      version: Number(settings.version),
      data: {
        theme: settings.theme,
        lastReportSeen: settings.last_report_seen,
        lastBackupAt: settings.last_backup_at,
        activeVehicleId: settings.active_vehicle_id,
        periodStartDate: settings.period_start_date,
        periodEndDate: settings.period_end_date,
      },
    },
    ...rows(categoriesResult).map((row) => ({
      type: "category",
      id: `${row.kind}:${row.id}`,
      version: Number(row.version),
      data: {
        id: row.id,
        kind: row.kind,
        name: row.name,
        icon: row.icon,
        builtin: Boolean(row.builtin),
        active: Boolean(row.active),
        sortOrder: Number(row.sort_order),
      },
    })),
    ...vehiclesRows.map((row) => ({
      type: "vehicle",
      id: String(row.id),
      version: Number(row.version),
      data: vehicleData(row),
    })),
    ...tripRows.map((row) => ({
      type: "trip",
      id: String(row.id),
      version: Number(row.version),
      data: tripData(row),
    })),
    ...expenseRows.map((row) => ({
      type: "trip_expense",
      id: `${row.trip_id}:${row.id}`,
      version: Number(row.version),
      data: expenseData(row),
    })),
    ...incomeRows.map((row) => ({
      type: "trip_income",
      id: `${row.trip_id}:${row.id}`,
      version: Number(row.version),
      data: incomeData(row),
    })),
    ...maintenanceRows.map((row) => ({
      type: "maintenance",
      id: String(row.id),
      version: Number(row.version),
      data: maintenanceData(row),
    })),
  ];

  return {
    fleet: {
      id: actor.fleetId,
      name: actor.fleetName,
      version: actor.fleetVersion,
    },
    membership: {
      id: actor.membershipId,
      role: actor.role,
      version: actor.membershipVersion,
    },
    records,
    cloudEmpty: settings.initialized_at == null,
  };
}

async function findActor(
  d1: D1Database,
  identity: TrustedIdentity,
): Promise<ActorRow | null> {
  return d1
    .prepare(
      `SELECT
         u.id AS user_id,
         i.id AS identity_id,
         f.id AS fleet_id,
         f.name AS fleet_name,
         f.version AS fleet_version,
         fm.id AS membership_id,
         fm.version AS membership_version,
         fm.role AS role
       FROM identities i
       JOIN users u ON u.id = i.user_id
       JOIN fleet_members fm ON fm.user_id = u.id AND fm.active = 1
       JOIN fleets f ON f.id = fm.fleet_id
       WHERE i.provider = ? AND i.provider_subject = ?
       ORDER BY CASE fm.role WHEN 'owner' THEN 0 ELSE 1 END, fm.created_at
       LIMIT 1`,
    )
    .bind(identity.provider, identity.providerSubject)
    .first<ActorRow>();
}

function actorFromRow(row: ActorRow): Actor {
  return {
    userId: row.user_id,
    identityId: row.identity_id,
    fleetId: row.fleet_id,
    fleetName: row.fleet_name,
    fleetVersion: Number(row.fleet_version),
    membershipId: row.membership_id,
    membershipVersion: Number(row.membership_version),
    role: row.role,
  };
}

function rows(result: D1Result): RawRow[] {
  return (result.results || []) as RawRow[];
}

export function vehicleData(row: RawRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    plateNo: row.plate_no,
    active: Boolean(row.active),
    sortOrder: Number(row.sort_order),
    createdAt: row.created_at,
  };
}

export function tripData(row: RawRow): Record<string, unknown> {
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    closedAt: row.closed_at,
    sortOrder: Number(row.sort_order),
    createdAt: row.created_at,
  };
}

export function expenseData(row: RawRow): Record<string, unknown> {
  return {
    id: row.id,
    tripId: row.trip_id,
    categoryId: row.category_id,
    amount: centsToAmount(row.amount_cents),
    date: row.date,
    note: row.note,
    sortOrder: Number(row.sort_order),
    createdAt: row.created_at,
  };
}

export function incomeData(row: RawRow): Record<string, unknown> {
  return {
    id: row.id,
    tripId: row.trip_id,
    categoryId: row.category_id,
    amount: centsToAmount(row.amount_cents),
    date: row.date,
    sortOrder: Number(row.sort_order),
    createdAt: row.created_at,
  };
}

export function maintenanceData(row: RawRow): Record<string, unknown> {
  return {
    id: row.id,
    vehicleId: row.vehicle_id,
    date: row.date,
    amount: centsToAmount(row.amount_cents),
    note: row.note,
    sortOrder: Number(row.sort_order),
    createdAt: row.created_at,
  };
}
