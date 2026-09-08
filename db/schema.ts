import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    check("users_version_check", sql`${table.version} > 0`),
  ],
);

export const identities = sqliteTable(
  "identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerSubject: text("provider_subject").notNull(),
    email: text("email"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    check("identities_version_check", sql`${table.version} > 0`),
    uniqueIndex("identities_provider_subject_uq").on(
      table.provider,
      table.providerSubject,
    ),
    index("identities_user_idx").on(table.userId),
  ],
);

export const fleets = sqliteTable(
  "fleets",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    check("fleets_version_check", sql`${table.version} > 0`),
  ],
);

export const fleetMembers = sqliteTable(
  "fleet_members",
  {
    id: text("id").primaryKey(),
    fleetId: text("fleet_id")
      .notNull()
      .references(() => fleets.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "driver"] }).notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    check(
      "fleet_members_role_check",
      sql`${table.role} IN ('owner', 'driver')`,
    ),
    check(
      "fleet_members_active_check",
      sql`${table.active} IN (0, 1)`,
    ),
    check("fleet_members_version_check", sql`${table.version} > 0`),
    uniqueIndex("fleet_members_fleet_user_uq").on(
      table.fleetId,
      table.userId,
    ),
    index("fleet_members_user_idx").on(table.userId, table.active),
  ],
);

export const vehicles = sqliteTable(
  "vehicles",
  {
    fleetId: text("fleet_id")
      .notNull()
      .references(() => fleets.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    name: text("name").notNull(),
    plateNo: text("plate_no").notNull().default(""),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    check("vehicles_active_check", sql`${table.active} IN (0, 1)`),
    check("vehicles_sort_order_check", sql`${table.sortOrder} >= 0`),
    check("vehicles_version_check", sql`${table.version} > 0`),
    primaryKey({ columns: [table.fleetId, table.id] }),
    index("vehicles_fleet_active_idx").on(table.fleetId, table.active),
  ],
);

export const vehicleAssignments = sqliteTable(
  "vehicle_assignments",
  {
    fleetId: text("fleet_id")
      .notNull()
      .references(() => fleets.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    vehicleId: text("vehicle_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startsAt: text("starts_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    endsAt: text("ends_at"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    check(
      "vehicle_assignments_active_check",
      sql`${table.active} IN (0, 1)`,
    ),
    check(
      "vehicle_assignments_version_check",
      sql`${table.version} > 0`,
    ),
    primaryKey({ columns: [table.fleetId, table.id] }),
    foreignKey({
      columns: [table.fleetId, table.vehicleId],
      foreignColumns: [vehicles.fleetId, vehicles.id],
      name: "vehicle_assignments_vehicle_fk",
    }).onDelete("cascade"),
    index("vehicle_assignments_user_active_idx").on(
      table.fleetId,
      table.userId,
      table.active,
    ),
    index("vehicle_assignments_vehicle_active_idx").on(
      table.fleetId,
      table.vehicleId,
      table.active,
    ),
  ],
);

export const categories = sqliteTable(
  "categories",
  {
    fleetId: text("fleet_id")
      .notNull()
      .references(() => fleets.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    kind: text("kind", { enum: ["expense", "income"] }).notNull(),
    name: text("name").notNull(),
    icon: text("icon").notNull().default(""),
    builtin: integer("builtin", { mode: "boolean" }).notNull().default(false),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    check(
      "categories_kind_check",
      sql`${table.kind} IN ('expense', 'income')`,
    ),
    check("categories_builtin_check", sql`${table.builtin} IN (0, 1)`),
    check("categories_active_check", sql`${table.active} IN (0, 1)`),
    check("categories_sort_order_check", sql`${table.sortOrder} >= 0`),
    check("categories_version_check", sql`${table.version} > 0`),
    primaryKey({ columns: [table.fleetId, table.kind, table.id] }),
    index("categories_fleet_kind_active_idx").on(
      table.fleetId,
      table.kind,
      table.active,
    ),
  ],
);

export const fleetSettings = sqliteTable(
  "fleet_settings",
  {
    fleetId: text("fleet_id")
      .primaryKey()
      .references(() => fleets.id, { onDelete: "cascade" }),
    theme: text("theme", { enum: ["day", "night"] }).notNull().default("day"),
    lastReportSeen: text("last_report_seen").notNull().default(""),
    lastBackupAt: text("last_backup_at").notNull().default(""),
    activeVehicleId: text("active_vehicle_id").notNull().default("all"),
    periodStartDate: text("period_start_date").notNull(),
    periodEndDate: text("period_end_date").notNull(),
    businessJson: text("business_json").notNull().default("{}"),
    initializedAt: text("initialized_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    check(
      "fleet_settings_theme_check",
      sql`${table.theme} IN ('day', 'night')`,
    ),
    check(
      "fleet_settings_business_json_check",
      sql`json_valid(${table.businessJson}) AND json_type(${table.businessJson}) = 'object'`,
    ),
    check("fleet_settings_version_check", sql`${table.version} > 0`),
  ],
);

export const trips = sqliteTable(
  "trips",
  {
    fleetId: text("fleet_id")
      .notNull()
      .references(() => fleets.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    vehicleId: text("vehicle_id").notNull(),
    startDate: text("start_date").notNull(),
    endDate: text("end_date"),
    status: text("status", { enum: ["open", "closed"] }).notNull(),
    closedAt: text("closed_at"),
    businessJson: text("business_json").notNull().default("{}"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    check(
      "trips_status_check",
      sql`${table.status} IN ('open', 'closed')`,
    ),
    check(
      "trips_business_json_check",
      sql`json_valid(${table.businessJson}) AND json_type(${table.businessJson}) = 'object'`,
    ),
    check("trips_sort_order_check", sql`${table.sortOrder} >= 0`),
    check("trips_version_check", sql`${table.version} > 0`),
    primaryKey({ columns: [table.fleetId, table.id] }),
    foreignKey({
      columns: [table.fleetId, table.vehicleId],
      foreignColumns: [vehicles.fleetId, vehicles.id],
      name: "trips_vehicle_fk",
    }),
    index("trips_fleet_vehicle_status_idx").on(
      table.fleetId,
      table.vehicleId,
      table.status,
    ),
    index("trips_fleet_end_date_idx").on(table.fleetId, table.endDate),
    uniqueIndex("trips_one_open_per_vehicle_uq")
      .on(table.fleetId, table.vehicleId)
      .where(sql`${table.status} = 'open'`),
  ],
);

export const tripExpenses = sqliteTable(
  "trip_expenses",
  {
    fleetId: text("fleet_id")
      .notNull()
      .references(() => fleets.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    tripId: text("trip_id").notNull(),
    categoryId: text("category_id").notNull(),
    amountCents: integer("amount_cents").notNull(),
    fuelUnitPriceX10000: integer("fuel_unit_price_x10000"),
    fuelVolumeMl: integer("fuel_volume_ml"),
    date: text("date").notNull(),
    note: text("note").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    check(
      "trip_expenses_amount_check",
      sql`${table.amountCents} >= 0`,
    ),
    check(
      "trip_expenses_fuel_metadata_check",
      sql`(${table.fuelUnitPriceX10000} IS NULL AND ${table.fuelVolumeMl} IS NULL) OR (${table.categoryId} = 'fuel' AND ${table.fuelUnitPriceX10000} IS NOT NULL AND ${table.fuelVolumeMl} IS NOT NULL AND ${table.fuelUnitPriceX10000} BETWEEN 1 AND 9999999 AND ${table.fuelVolumeMl} BETWEEN 1 AND 100000000)`,
    ),
    check(
      "trip_expenses_sort_order_check",
      sql`${table.sortOrder} >= 0`,
    ),
    check("trip_expenses_version_check", sql`${table.version} > 0`),
    primaryKey({ columns: [table.fleetId, table.id] }),
    foreignKey({
      columns: [table.fleetId, table.tripId],
      foreignColumns: [trips.fleetId, trips.id],
      name: "trip_expenses_trip_fk",
    }).onDelete("cascade"),
    index("trip_expenses_fleet_trip_idx").on(table.fleetId, table.tripId),
  ],
);

export const tripIncomes = sqliteTable(
  "trip_incomes",
  {
    fleetId: text("fleet_id")
      .notNull()
      .references(() => fleets.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    tripId: text("trip_id").notNull(),
    categoryId: text("category_id").notNull(),
    amountCents: integer("amount_cents").notNull(),
    date: text("date").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    check(
      "trip_incomes_amount_check",
      sql`${table.amountCents} >= 0`,
    ),
    check(
      "trip_incomes_sort_order_check",
      sql`${table.sortOrder} >= 0`,
    ),
    check("trip_incomes_version_check", sql`${table.version} > 0`),
    primaryKey({ columns: [table.fleetId, table.id] }),
    foreignKey({
      columns: [table.fleetId, table.tripId],
      foreignColumns: [trips.fleetId, trips.id],
      name: "trip_incomes_trip_fk",
    }).onDelete("cascade"),
    uniqueIndex("trip_incomes_trip_category_uq").on(
      table.fleetId,
      table.tripId,
      table.categoryId,
    ),
    index("trip_incomes_fleet_trip_idx").on(table.fleetId, table.tripId),
  ],
);

export const maintenance = sqliteTable(
  "maintenance",
  {
    fleetId: text("fleet_id")
      .notNull()
      .references(() => fleets.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    vehicleId: text("vehicle_id").notNull(),
    date: text("date").notNull(),
    amountCents: integer("amount_cents").notNull(),
    note: text("note").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    check(
      "maintenance_amount_check",
      sql`${table.amountCents} >= 0`,
    ),
    check(
      "maintenance_sort_order_check",
      sql`${table.sortOrder} >= 0`,
    ),
    check("maintenance_version_check", sql`${table.version} > 0`),
    primaryKey({ columns: [table.fleetId, table.id] }),
    foreignKey({
      columns: [table.fleetId, table.vehicleId],
      foreignColumns: [vehicles.fleetId, vehicles.id],
      name: "maintenance_vehicle_fk",
    }),
    index("maintenance_fleet_vehicle_date_idx").on(
      table.fleetId,
      table.vehicleId,
      table.date,
    ),
  ],
);

// A commit receipt is written in the same database batch as its business writes.
// Retrying the same operationId can therefore return the original acknowledgement
// without applying the records twice.
export const syncCommits = sqliteTable(
  "sync_commits",
  {
    fleetId: text("fleet_id")
      .notNull()
      .references(() => fleets.id, { onDelete: "cascade" }),
    operationId: text("operation_id").notNull(),
    requestHash: text("request_hash").notNull(),
    responseJson: text("response_json").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.fleetId, table.operationId] }),
    index("sync_commits_created_at_idx").on(table.createdAt),
  ],
);

// Version guards live only for the duration of one database batch. A failed CHECK
// aborts the entire batch; successful guard rows are removed before commit.
export const syncAssertions = sqliteTable(
  "sync_assertions",
  {
    fleetId: text("fleet_id")
      .notNull()
      .references(() => fleets.id, { onDelete: "cascade" }),
    operationId: text("operation_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    ok: integer("ok").notNull(),
  },
  (table) => [
    check("sync_assertions_ok_check", sql`${table.ok} = 1`),
    primaryKey({
      columns: [table.fleetId, table.operationId, table.ordinal],
    }),
  ],
);

// Local SQLite mirror of the additive production recovery schema.
export const restoreJobs = sqliteTable("restore_jobs", {
  fleetId: text("fleet_id").notNull().references(() => fleets.id),
  id: text("id").notNull(),
  membershipId: text("membership_id").notNull().references(() => fleetMembers.id),
  userId: text("user_id").notNull().references(() => users.id),
  baseVersion: integer("base_version").notNull(),
  manifestJson: text("manifest_json").notNull(),
  status: text("status").notNull().default("uploading"),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
}, table => [
  primaryKey({ columns: [table.fleetId, table.id] }),
  check("restore_jobs_version_check", sql`${table.baseVersion} > 0`),
  check("restore_jobs_status_check", sql`${table.status} IN ('uploading','ready','complete','cancelled')`),
  uniqueIndex("restore_jobs_one_active").on(table.fleetId).where(sql`${table.status} IN ('uploading','ready')`),
  index("restore_jobs_expiry").on(table.expiresAt),
  index("restore_jobs_membership").on(table.membershipId),
  index("restore_jobs_user").on(table.userId),
]);

export const restoreChunks = sqliteTable("restore_chunks", {
  fleetId: text("fleet_id").notNull(),
  jobId: text("job_id").notNull(),
  ordinal: integer("ordinal").notNull(),
  hash: text("hash").notNull(),
  payload: text("payload").notNull(),
}, table => [
  primaryKey({ columns: [table.fleetId, table.jobId, table.ordinal] }),
  foreignKey({ columns: [table.fleetId, table.jobId], foreignColumns: [restoreJobs.fleetId, restoreJobs.id] }).onDelete("cascade"),
  check("restore_chunks_ordinal_check", sql`${table.ordinal} >= 0 AND ${table.ordinal} < 256`),
]);
