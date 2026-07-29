import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { INVARIANT_SCHEMA_STATEMENTS } from "../db/invariants.ts";
import { authorizeBeforeExpose } from "../lib/server/authorization.ts";
import {
  amountToCents,
  canonicalSyncPayload,
  classifyVersion,
  dateValue,
  orderSyncOperations,
  parseSyncOperations,
  parseSyncRequest,
  periodDays,
  RecordValidationError,
  rejectOwnershipFields,
  requiredId,
  roleCanWriteVehicle,
  shouldMarkFleetInitialized,
  summarizeSyncResults,
} from "../lib/server/sync-contract.ts";
import {
  AuthenticationError,
  getTrustedIdentity,
} from "../lib/server/auth.ts";

test("可信身份只从 Sites 转发头读取，并标准化 provider subject", () => {
  const request = new Request("https://example.test/api/bootstrap", {
    method: "POST",
    headers: {
      "oai-authenticated-user-email": " Owner@Example.COM ",
      "oai-authenticated-user-full-name": "%E8%BD%A6%E4%B8%BB",
      "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
    },
    body: JSON.stringify({
      email: "attacker@example.com",
      fleetId: "another-fleet",
    }),
  });
  assert.deepEqual(getTrustedIdentity(request), {
    provider: "chatgpt",
    providerSubject: "owner@example.com",
    email: "owner@example.com",
    displayName: "车主",
  });
  assert.throws(
    () =>
      getTrustedIdentity(
        new Request("https://example.test/api/bootstrap", {
          method: "POST",
          body: JSON.stringify({ email: "attacker@example.com" }),
        }),
      ),
    AuthenticationError,
  );
});

test("owner 可写全车队，driver 只有活动车辆分配时可写", () => {
  assert.equal(roleCanWriteVehicle("owner", false), true);
  assert.equal(roleCanWriteVehicle("driver", true), true);
  assert.equal(roleCanWriteVehicle("driver", false), false);
});

test("并发失败回读会按最新车辆分配重新授权，越权记录不进入 conflict", async () => {
  const actorFleetId = "f1";
  const assignedVehicles = new Set(["v-old", "v-new"]);
  let serialized = false;
  const authorize = async (record) => {
    if (record.fleet_id !== actorFleetId) {
      throw new RecordValidationError(
        "fleet_not_allowed",
        "不能读取其他车队",
      );
    }
    if (!assignedVehicles.has(record.vehicle_id)) {
      throw new RecordValidationError(
        "vehicle_not_assigned",
        "不能读取未分配车辆",
      );
    }
  };

  const allowed = await authorizeBeforeExpose(
    { id: "t1", fleet_id: "f1", vehicle_id: "v-new" },
    authorize,
    (record) => {
      serialized = true;
      return record.id;
    },
  );
  assert.equal(allowed, "t1");
  assert.equal(serialized, true);

  serialized = false;
  await assert.rejects(
    () =>
      authorizeBeforeExpose(
        // Simulates another writer moving the row after the caller's old,
        // authorized pre-read but before its version-checked UPDATE.
        { id: "t1", fleet_id: "f1", vehicle_id: "v-unassigned" },
        authorize,
        () => {
          serialized = true;
          return "leaked";
        },
      ),
    (error) =>
      error instanceof RecordValidationError &&
      error.code === "vehicle_not_assigned",
  );
  assert.equal(serialized, false);

  await assert.rejects(
    () =>
      authorizeBeforeExpose(
        { id: "t1", fleet_id: "f-other", vehicle_id: "v-old" },
        authorize,
        () => "leaked",
      ),
    /其他车队/,
  );
});

test("expectedVersion 明确区分创建、更新和并发冲突", () => {
  assert.equal(classifyVersion(0, null), "create");
  assert.equal(classifyVersion(3, 3), "update");
  assert.equal(classifyVersion(0, 1), "conflict");
  assert.equal(classifyVersion(2, 3), "conflict");
  assert.equal(classifyVersion(2, null), "conflict");
});

test("批量结果明确标记 conflict 与 rejected，同时保留逐条状态", () => {
  const conflict = {
    op: "put",
    type: "vehicle",
    id: "v1",
    status: "conflict",
    version: 3,
    current: { id: "v1" },
    error: { code: "version_conflict", message: "请刷新" },
  };
  const rejected = {
    op: "put",
    type: "trip",
    id: "t1",
    status: "rejected",
    error: { code: "vehicle_not_found", message: "车辆不存在" },
  };
  assert.deepEqual(summarizeSyncResults([conflict]), {
    hasConflicts: true,
    hasRejected: false,
  });
  assert.deepEqual(summarizeSyncResults([conflict, rejected]), {
    hasConflicts: true,
    hasRejected: true,
  });
  assert.equal(shouldMarkFleetInitialized([]), false);
  assert.equal(shouldMarkFleetInitialized([conflict]), false);
  assert.equal(
    shouldMarkFleetInitialized([
      {
        op: "put",
        type: "vehicle",
        id: "v1",
        status: "applied",
        version: 1,
      },
    ]),
    true,
  );
});

test("同步批次按外键依赖排序，删除时先删子账目", () => {
  const operations = parseSyncOperations({
    operations: [
      {
        op: "delete",
        type: "trip",
        id: "t1",
        expectedVersion: 2,
      },
      {
        op: "put",
        type: "trip",
        id: "t2",
        expectedVersion: 0,
        data: {},
      },
      {
        op: "put",
        type: "vehicle",
        id: "v1",
        expectedVersion: 0,
        data: {},
      },
      {
        op: "delete",
        type: "trip_expense",
        id: "t1:e1",
        expectedVersion: 1,
      },
    ],
  });
  assert.deepEqual(
    orderSyncOperations(operations).map((item) => [
      item.op,
      item.type,
      item.id,
    ]),
    [
      ["delete", "trip_expense", "t1:e1"],
      ["delete", "trip", "t1"],
      ["put", "vehicle", "v1"],
      ["put", "trip", "t2"],
    ],
  );
  assert.throws(
    () => orderSyncOperations([operations[1], operations[1]]),
    /不能重复同步/,
  );
  const orderedVehicles = orderSyncOperations(
    parseSyncOperations({
      operations: [
        {
          op: "put",
          type: "vehicle",
          id: "inactive-first",
          expectedVersion: 0,
          data: { id: "inactive-first", active: false },
        },
        {
          op: "put",
          type: "vehicle",
          id: "active-second",
          expectedVersion: 0,
          data: { id: "active-second", active: true },
        },
      ],
    }),
  );
  assert.deepEqual(
    orderedVehicles.map((item) => item.id),
    ["active-second", "inactive-first"],
  );
});

test("金额以分守恒，负数与越界金额在服务端拒绝", () => {
  assert.equal(amountToCents("800.25"), 80025);
  assert.equal(amountToCents(300.1), 30010);
  assert.throws(() => amountToCents(-0.01), /金额必须是非负数字/);
  assert.throws(() => amountToCents(Number.POSITIVE_INFINITY), /金额必须/);
});

test("日期、账期和 id 输入按业务边界校验", () => {
  assert.equal(dateValue("2026-02-28", "date"), "2026-02-28");
  assert.throws(() => dateValue("2026-02-30", "date"), /不是有效日期/);
  assert.equal(periodDays("2026-03-15", "2027-03-14"), 365);
  assert.equal(periodDays("2026-01-01", "2027-01-01"), 366);
  assert.throws(() => requiredId("", "vehicle.id"), /不能为空/);
  assert.throws(() => requiredId("a".repeat(161), "vehicle.id"), /160/);
});

test("同步外层契约拒绝客户端自造类型与无效版本", () => {
  assert.throws(
    () =>
      parseSyncOperations({
        operations: [
          {
            op: "put",
            type: "fleet_member",
            id: "owner",
            expectedVersion: 0,
            data: { fleetId: "foreign-fleet", role: "owner" },
          },
        ],
      }),
    (error) =>
      error instanceof RecordValidationError &&
      error.code === "invalid_type",
  );
  assert.throws(
    () =>
      parseSyncOperations({
        operations: [
          {
            op: "delete",
            type: "trip",
            id: "t1",
            expectedVersion: -1,
          },
        ],
      }),
    /expectedVersion/,
  );
});

test("严格同步要求稳定 operationId，且相同语义生成稳定哈希输入", () => {
  const first = parseSyncRequest({
    operationId: "write-12345678",
    operations: [
      {
        op: "put",
        type: "vehicle",
        id: "v1",
        expectedVersion: 1,
        data: { name: "一号车", id: "v1" },
      },
    ],
  });
  const second = parseSyncRequest({
    operations: [
      {
        data: { id: "v1", name: "一号车" },
        expectedVersion: 1,
        id: "v1",
        type: "vehicle",
        op: "put",
      },
    ],
    operationId: "write-12345678",
  });
  assert.equal(
    canonicalSyncPayload(first.operations, first.finalize),
    canonicalSyncPayload(second.operations, second.finalize),
  );
  assert.throws(
    () => parseSyncRequest({ operations: [] }),
    (error) =>
      error instanceof RecordValidationError &&
      error.code === "invalid_operation_id",
  );
  assert.throws(
    () =>
      parseSyncRequest({
        operationId: "new id with spaces",
        operations: [],
      }),
    /operationId/,
  );
});

test("服务端拒绝客户端指定车队、身份、成员、角色或车辆分配", () => {
  for (const field of [
    "fleetId",
    "fleet_id",
    "userId",
    "created_by_user_id",
    "role",
    "permissions",
    "membershipId",
    "fleet_member_id",
    "identity",
    "provider_subject",
    "assignmentId",
    "vehicle_assignments",
  ]) {
    assert.throws(
      () =>
        rejectOwnershipFields({
          id: "v1",
          name: "一号车",
          [field]: "attacker-controlled",
        }),
      (error) =>
        error instanceof RecordValidationError &&
        error.code === "ownership_field_forbidden",
      field,
    );
  }
  assert.doesNotThrow(() =>
    rejectOwnershipFields({
      id: "v1",
      vehicleId: "v1",
      name: "一号车",
    }),
  );
  assert.throws(
    () =>
      parseSyncOperations({
        fleetId: "foreign-fleet",
        operations: [],
      }),
    (error) =>
      error instanceof RecordValidationError &&
      error.code === "ownership_field_forbidden",
  );
  assert.throws(
    () =>
      parseSyncOperations({
        operations: [
          {
            op: "put",
            type: "vehicle",
            id: "v1",
            expectedVersion: 0,
            role: "owner",
            data: { id: "v1", name: "一号车" },
          },
        ],
      }),
    (error) =>
      error instanceof RecordValidationError &&
      error.code === "ownership_field_forbidden",
  );
});

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const initialMigration = readFileSync(
  `${repositoryRoot}/drizzle/0000_public_wildside.sql`,
  "utf8",
).replaceAll("--> statement-breakpoint", "");
const atomicSyncMigration = readFileSync(
  `${repositoryRoot}/drizzle/0001_smart_the_twelve.sql`,
  "utf8",
).replaceAll("--> statement-breakpoint", "");
const seedLedger = `
PRAGMA foreign_keys=ON;
INSERT INTO users (id, display_name) VALUES ('u1', '车主');
INSERT INTO fleets (id, name, created_by_user_id) VALUES ('f1', '车队', 'u1');
INSERT INTO fleet_members (id, fleet_id, user_id, role) VALUES ('fm1', 'f1', 'u1', 'owner');
INSERT INTO fleet_settings (
  fleet_id, period_start_date, period_end_date
) VALUES ('f1', '2026-01-01', '2026-12-31');
INSERT INTO vehicles (fleet_id, id, name, active) VALUES
  ('f1', 'v1', '一号车', 1),
  ('f1', 'v2', '二号车', 1);
INSERT INTO categories (fleet_id, id, kind, name) VALUES
  ('f1', 'fuel', 'expense', '油费'),
  ('f1', 'cargo', 'income', '运费');
INSERT INTO trips (
  fleet_id, id, vehicle_id, start_date, end_date, status
) VALUES
  ('f1', 't1', 'v1', '2026-07-01', '2026-07-02', 'closed'),
  ('f1', 't2', 'v2', '2026-07-03', '2026-07-04', 'closed');
INSERT INTO trip_expenses (
  fleet_id, id, trip_id, category_id, amount_cents, date
) VALUES ('f1', 'e1', 't1', 'fuel', 10000, '2026-07-01');
INSERT INTO trip_incomes (
  fleet_id, id, trip_id, category_id, amount_cents, date
) VALUES ('f1', 'i1', 't1', 'cargo', 20000, '2026-07-02');
`;
const hardenedLedger = `${initialMigration}\n${seedLedger}`;

function hardenedDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(hardenedLedger);
  return database;
}

function assertSqlFails(sql, pattern) {
  const database = hardenedDatabase();
  try {
    assert.throws(() => database.exec(sql), pattern);
  } finally {
    database.close();
  }
}

test("正式初始 migration 与 runtime 一致落下 CHECK、主键和触发器", () => {
  const database = hardenedDatabase();
  try {
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM vehicles) AS vehicles,
               (SELECT COUNT(*) FROM trips) AS trips,
               (SELECT SUM(amount_cents) FROM trip_expenses) AS expenses,
               (SELECT SUM(amount_cents) FROM trip_incomes) AS incomes`,
          )
          .get(),
      },
      { vehicles: 2, trips: 2, expenses: 10000, incomes: 20000 },
    );
  } finally {
    database.close();
  }

  const runtimeSource = readFileSync(
    `${repositoryRoot}/db/runtime-schema.ts`,
    "utf8",
  );
  for (const check of [
    "role IN ('owner', 'driver')",
    "status IN ('open', 'closed')",
    "active IN (0, 1)",
    "sort_order >= 0",
    "amount_cents >= 0",
    "version > 0",
    "PRIMARY KEY (fleet_id, id)",
  ]) {
    assert.ok(runtimeSource.includes(check), check);
  }
  for (const trigger of INVARIANT_SCHEMA_STATEMENTS) {
    const name = trigger.match(/TRIGGER IF NOT EXISTS\s+(\w+)/)?.[1];
    assert.ok(name, trigger);
    assert.ok(initialMigration.includes(name), name);
  }
});

test("正式 schema CHECK 拒绝越权角色、非法状态/布尔/版本/排序/金额", () => {
  assertSqlFails(
    "UPDATE fleet_members SET role = 'admin' WHERE id = 'fm1';",
    /fleet_members_role_check/,
  );
  assertSqlFails(
    "UPDATE trips SET status = 'unknown' WHERE id = 't2';",
    /trips_status_check/,
  );
  assertSqlFails(
    "UPDATE vehicles SET active = 2 WHERE id = 'v1';",
    /vehicles_active_check/,
  );
  assertSqlFails(
    "UPDATE vehicles SET version = 0 WHERE id = 'v1';",
    /vehicles_version_check/,
  );
  assertSqlFails(
    "UPDATE categories SET sort_order = -1 WHERE id = 'fuel';",
    /categories_sort_order_check/,
  );
  assertSqlFails(
    "UPDATE trip_expenses SET amount_cents = -1 WHERE id = 'e1';",
    /trip_expenses_amount_check/,
  );
});

test("严格同步 migration 可升级既有 D1，并落下幂等回执与版本守卫", () => {
  const database = hardenedDatabase();
  try {
    database.exec(atomicSyncMigration);
    assert.deepEqual(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sync_assertions', 'sync_commits') ORDER BY name",
        )
        .all()
        .map((row) => row.name),
      ["sync_assertions", "sync_commits"],
    );
    database
      .prepare(
        "INSERT INTO sync_commits (fleet_id, operation_id, request_hash, response_json) VALUES (?, ?, ?, ?)",
      )
      .run("f1", "write-migration-1", "hash-a", "{}");
    assert.throws(
      () =>
        database
          .prepare(
            "INSERT INTO sync_commits (fleet_id, operation_id, request_hash, response_json) VALUES (?, ?, ?, ?)",
          )
          .run("f1", "write-migration-1", "hash-b", "{}"),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () =>
        database
          .prepare(
            "INSERT INTO sync_assertions (fleet_id, operation_id, ordinal, ok) VALUES (?, ?, ?, ?)",
          )
          .run("f1", "write-migration-1", 0, 0),
      /sync_assertions_ok_check/,
    );
  } finally {
    database.close();
  }
});

test("原子触发器封住最后启用车辆与发车/停用交错竞态", () => {
  assertSqlFails(
    `
UPDATE vehicles SET active = 0 WHERE fleet_id = 'f1' AND id = 'v1';
UPDATE vehicles SET active = 0 WHERE fleet_id = 'f1' AND id = 'v2';
`,
    /last_active_vehicle/,
  );
  assertSqlFails(
    `
INSERT INTO trips (
  fleet_id, id, vehicle_id, start_date, status
) VALUES ('f1', 'open-first', 'v1', '2026-07-05', 'open');
UPDATE vehicles SET active = 0 WHERE fleet_id = 'f1' AND id = 'v1';
`,
    /vehicle_has_open_trip/,
  );
  assertSqlFails(
    `
UPDATE vehicles SET active = 0 WHERE fleet_id = 'f1' AND id = 'v1';
INSERT INTO trips (
  fleet_id, id, vehicle_id, start_date, status
) VALUES ('f1', 'disable-first', 'v1', '2026-07-05', 'open');
`,
    /vehicle_inactive/,
  );
  assertSqlFails(
    `
UPDATE vehicles SET active = 0 WHERE fleet_id = 'f1' AND id = 'v1';
INSERT INTO trips (
  fleet_id, id, vehicle_id, start_date, status
) VALUES ('f1', 'move-open', 'v2', '2026-07-05', 'open');
UPDATE trips SET vehicle_id = 'v1' WHERE id = 'move-open';
`,
    /vehicle_inactive/,
  );
});

test("删除趟次前数据库原子确认没有并发新增的收入或支出", () => {
  assertSqlFails(
    "DELETE FROM trips WHERE fleet_id = 'f1' AND id = 't1';",
    /trip_has_entries/,
  );
  assertSqlFails(
    `
INSERT INTO trip_expenses (
  fleet_id, id, trip_id, category_id, amount_cents, date
) VALUES ('f1', 'late-entry', 't2', 'fuel', 500, '2026-07-04');
DELETE FROM trips WHERE fleet_id = 'f1' AND id = 't2';
`,
    /trip_has_entries/,
  );
});

test("严格同步的 version guard 与业务写在同一事务失败时全部回滚", () => {
  const database = hardenedDatabase();
  try {
    database.exec(`
      CREATE TABLE sync_commits (
        fleet_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (fleet_id, operation_id)
      );
      CREATE TABLE sync_assertions (
        fleet_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        ok INTEGER NOT NULL CONSTRAINT sync_assertions_ok_check CHECK (ok = 1),
        PRIMARY KEY (fleet_id, operation_id, ordinal)
      );
    `);
    assert.throws(() => {
      database.exec("BEGIN");
      try {
        database
          .prepare(
            `INSERT INTO sync_assertions (fleet_id, operation_id, ordinal, ok)
             VALUES (?, ?, ?, CASE WHEN EXISTS (
               SELECT 1 FROM vehicles WHERE fleet_id = ? AND id = ? AND version = ?
             ) THEN 1 ELSE 0 END)`,
          )
          .run("f1", "write-atomic-1", 0, "f1", "v2", 1);
        database
          .prepare(
            "UPDATE vehicles SET name = ?, version = 2 WHERE fleet_id = ? AND id = ? AND version = 1",
          )
          .run("不应部分保存", "f1", "v2");
        database.exec(`
          INSERT INTO trip_incomes (
            fleet_id, id, trip_id, category_id, amount_cents, date
          ) VALUES ('f1', 'i-first', 't2', 'cargo', 30000, '2026-07-04');
          INSERT INTO trip_incomes (
            fleet_id, id, trip_id, category_id, amount_cents, date
          ) VALUES ('f1', 'i-second', 't2', 'cargo', 40000, '2026-07-04');
        `);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }, /UNIQUE constraint failed/);
    assert.deepEqual(
      {
        ...database
          .prepare(
            `SELECT
               (SELECT name FROM vehicles WHERE fleet_id = 'f1' AND id = 'v2') AS vehicle_name,
               (SELECT COUNT(*) FROM trip_incomes WHERE fleet_id = 'f1' AND trip_id = 't2') AS incomes,
               (SELECT COUNT(*) FROM sync_assertions) AS assertions,
               (SELECT COUNT(*) FROM sync_commits) AS commits`,
          )
          .get(),
      },
      {
        vehicle_name: "二号车",
        incomes: 0,
        assertions: 0,
        commits: 0,
      },
    );
  } finally {
    database.close();
  }
});

test("version guard 在预检后发生并发变化时用 CHECK 中止批次", () => {
  const database = hardenedDatabase();
  try {
    database.exec(`
      CREATE TABLE sync_assertions (
        fleet_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        ok INTEGER NOT NULL CONSTRAINT sync_assertions_ok_check CHECK (ok = 1),
        PRIMARY KEY (fleet_id, operation_id, ordinal)
      );
      UPDATE vehicles SET version = 2 WHERE fleet_id = 'f1' AND id = 'v2';
    `);
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO sync_assertions (fleet_id, operation_id, ordinal, ok)
             VALUES (?, ?, ?, CASE WHEN EXISTS (
               SELECT 1 FROM vehicles WHERE fleet_id = ? AND id = ? AND version = ?
             ) THEN 1 ELSE 0 END)`,
          )
          .run("f1", "write-raced-1", 0, "f1", "v2", 1),
      /sync_assertions_ok_check/,
    );
    assert.equal(
      database
        .prepare(
          "SELECT name FROM vehicles WHERE fleet_id = 'f1' AND id = 'v2'",
        )
        .get().name,
      "二号车",
    );
  } finally {
    database.close();
  }
});
