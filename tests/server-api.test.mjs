import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { INVARIANT_SCHEMA_STATEMENTS } from "../db/invariants.ts";
import { authorizeBeforeExpose } from "../lib/server/authorization.ts";
import {
  amountToCents,
  canonicalSyncPayload,
  classifyVersion,
  dateValue,
  fuelDataFromScaled,
  normalizeFuelData,
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
  INTERNAL_AUTH_HEADERS,
  getTrustedIdentity,
} from "../lib/server/auth.ts";

test("业务身份只接受 worker 内部 Principal，外部 OAI 或正文不能越过边界", () => {
  const internalSecret = "test-only-internal-auth-secret-1234567890";
  const request = new Request("https://example.test/api/bootstrap", {
    method: "POST",
    headers: {
      [INTERNAL_AUTH_HEADERS.mode]: "sites",
      [INTERNAL_AUTH_HEADERS.proof]: internalSecret,
      [INTERNAL_AUTH_HEADERS.issuer]: "sites",
      [INTERNAL_AUTH_HEADERS.subject]: "usr_sites_123",
      [INTERNAL_AUTH_HEADERS.email]: " Owner@Example.COM ",
      [INTERNAL_AUTH_HEADERS.displayName]: "%E8%BD%A6%E4%B8%BB",
      [INTERNAL_AUTH_HEADERS.loginName]: "owner@example.com",
    },
    body: JSON.stringify({
      email: "attacker@example.com",
      fleetId: "another-fleet",
    }),
  });
  assert.deepEqual(getTrustedIdentity(request, {
    authMode: "sites",
    internalSecret,
  }), {
    issuer: "sites",
    subject: "usr_sites_123",
    email: "owner@example.com",
    displayName: "车主",
    loginName: "owner@example.com",
  });
  assert.throws(
    () =>
      getTrustedIdentity(
        new Request("https://example.test/api/bootstrap", {
          method: "POST",
          headers: {
            "oai-authenticated-user-id": "usr_attacker",
            "oai-authenticated-user-email": "attacker@example.com",
          },
          body: JSON.stringify({ email: "attacker@example.com" }),
        }),
        { authMode: "sites", internalSecret },
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
  assert.equal(amountToCents("999999999.99"), 99999999999);
  assert.equal(amountToCents("800.255"), 80026);
  assert.equal(amountToCents("8e2"), 80000);
  assert.throws(() => amountToCents(-0.01), /金额必须是非负数字/);
  assert.throws(() => amountToCents(Number.POSITIVE_INFINITY), /金额必须/);
  assert.throws(() => amountToCents("1000000000"), /不能超过/);
});

test("结构化油费使用定点整数校验，并从数据库列重建 canonical fuel", () => {
  assert.deepEqual(
    normalizeFuelData("fuel", "300.00", {
      unitPrice: "7.5000",
      liters: "40.000",
    }),
    { fuelUnitPriceX10000: 75000, fuelVolumeMl: 40000 },
  );
  assert.deepEqual(
    normalizeFuelData("fuel", "0.01", {
      unitPrice: "0.05",
      liters: "0.1",
    }),
    { fuelUnitPriceX10000: 500, fuelVolumeMl: 100 },
    "乘积恰好半分时使用 BigInt half-up 得到一分",
  );
  assert.deepEqual(fuelDataFromScaled(72356, 82417), {
    unitPrice: "7.2356",
    liters: "82.417",
  });
  assert.deepEqual(fuelDataFromScaled(75000, 40000), {
    unitPrice: "7.5",
    liters: "40",
  });
  assert.equal(fuelDataFromScaled(null, null), undefined);
  assert.throws(
    () => fuelDataFromScaled(75000, null),
    /定点字段不完整/,
  );
});

test("油费契约兼容旧记录，并拒绝越界、超精度、矛盾或错科目元数据", () => {
  assert.deepEqual(normalizeFuelData("fuel", "300", undefined), {
    fuelUnitPriceX10000: null,
    fuelVolumeMl: null,
  });
  assert.deepEqual(normalizeFuelData("toll", "10", undefined), {
    fuelUnitPriceX10000: null,
    fuelVolumeMl: null,
  });
  assert.doesNotThrow(() =>
    normalizeFuelData("fuel", "300.01", {
      unitPrice: "7.5",
      liters: "40",
    }),
  );
  assert.doesNotThrow(() =>
    normalizeFuelData("fuel", "99999990", {
      unitPrice: "999.9999",
      liters: "100000.000",
    }),
  );

  const invalid = [
    () => normalizeFuelData("fuel", "300.02", { unitPrice: "7.5", liters: "40" }),
    () => normalizeFuelData("fuel", "3e2", { unitPrice: "7.5", liters: "40" }),
    () => normalizeFuelData("fuel", "300.001", { unitPrice: "7.5", liters: "40" }),
    () => normalizeFuelData("fuel", "300", { unitPrice: "7.50000", liters: "40" }),
    () => normalizeFuelData("fuel", "300", { unitPrice: "7.5", liters: "40.0001" }),
    () => normalizeFuelData("fuel", "1000", { unitPrice: "1000", liters: "1" }),
    () => normalizeFuelData("fuel", "1", { unitPrice: "1", liters: "100000.001" }),
    () => normalizeFuelData("fuel", "1", { unitPrice: "1" }),
    () => normalizeFuelData("fuel", "1", { unitPrice: "1", liters: "1", extra: true }),
    () => normalizeFuelData("toll", "1", { unitPrice: "1", liters: "1" }),
  ];
  for (const vector of invalid) assert.throws(vector);
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
const runtimeSchemaSource = readFileSync(
  `${repositoryRoot}/db/runtime-schema.ts`,
  "utf8",
);
const bootstrapSource = readFileSync(
  `${repositoryRoot}/lib/server/bootstrap.ts`,
  "utf8",
);
const syncRepositorySource = readFileSync(
  `${repositoryRoot}/lib/server/sync-repository.ts`,
  "utf8",
);

function repositoryAuthorizationHelpersForTest() {
  const executable = stripTypeScriptTypes(syncRepositorySource, {
    mode: "transform",
  })
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace(/\bexport\s+/g, "");
  const sandbox = { RecordValidationError, requiredId };
  runInNewContext(
    `${executable}\nglobalThis.__authorizationHelpers = {
      authorizationVehicleFootprint,
      assignmentGuardVehicleIds,
      batchTripCreateIds,
      operationAuthorizationFootprint,
      parentTripGuardIds,
      prepareActorGuard,
      prepareAssignmentGuard,
      prepareParentTripAssignmentGuard,
      prepareVersionGuard,
    };`,
    sandbox,
  );
  return sandbox.__authorizationHelpers;
}

function runtimeEnsureFuelColumnsForTest() {
  const executable = stripTypeScriptTypes(runtimeSchemaSource, {
    mode: "transform",
  })
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace(/\bexport\s+/g, "");
  const sandbox = {
    INVARIANT_SCHEMA_STATEMENTS: [],
    getD1() {
      throw new Error("本测试不调用 ensureSchema");
    },
  };
  runInNewContext(
    `${executable}\nglobalThis.__ensureFuelColumns = ensureFuelColumns;`,
    sandbox,
  );
  return sandbox.__ensureFuelColumns;
}
const runtimeFuelAlterStatements = Array.from(
  runtimeSchemaSource.matchAll(
    /"(ALTER TABLE trip_expenses ADD COLUMN [^"]+)"/g,
  ),
  (match) => match[1],
);
const initialMigration = readFileSync(
  `${repositoryRoot}/drizzle/0000_public_wildside.sql`,
  "utf8",
).replaceAll("--> statement-breakpoint", "");
const atomicSyncMigration = readFileSync(
  `${repositoryRoot}/drizzle/0001_smart_the_twelve.sql`,
  "utf8",
).replaceAll("--> statement-breakpoint", "");
const fuelMigration = readFileSync(
  `${repositoryRoot}/drizzle/0002_lonely_shriek.sql`,
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

test("repository/bootstrap 接线覆盖 fuel 校验、持久化、回执与 fail-closed 重建", () => {
  assert.match(
    syncRepositorySource,
    /normalizeFuelData\(categoryId, data\.amount, data\.fuel\)/,
  );
  assert.match(
    syncRepositorySource,
    /INSERT INTO trip_expenses \([^)]+fuel_unit_price_x10000, fuel_volume_ml[^)]+\)/,
  );
  assert.match(
    syncRepositorySource,
    /UPDATE trip_expenses SET[^\n]+fuel_unit_price_x10000 = \?, fuel_volume_ml = \?/,
  );
  assert.match(
    syncRepositorySource,
    /fuelDataFromScaled\([\s\S]*fuelUnitPriceX10000,[\s\S]*fuelVolumeMl,[\s\S]*normalizeFuelData\(String\(data\.categoryId\), amount, fuel\)/,
  );
  assert.match(
    bootstrapSource,
    /const fuel = fuelDataFromScaled\([\s\S]*row\.fuel_unit_price_x10000,[\s\S]*row\.fuel_volume_ml,[\s\S]*normalizeFuelData\(categoryId, amount, fuel\)/,
  );
  assert.match(
    bootstrapSource,
    /\.\.\.\(fuel === undefined \? \{\} : \{ fuel \}\)/,
  );

  const fuel = fuelDataFromScaled(75000, 40000);
  assert.deepEqual(fuel, { unitPrice: "7.5", liters: "40" });
  assert.doesNotThrow(() => normalizeFuelData("fuel", 300, fuel));
  assert.throws(() => normalizeFuelData("toll", 300, fuel), /只有油费支出/);
  assert.throws(() => normalizeFuelData("fuel", 310, fuel), /不一致/);
  assert.equal(fuelDataFromScaled(null, null), undefined);
});

test("driver bootstrap 将 owner-only records 标为只读并隐藏全局 activeVehicleId", () => {
  assert.match(
    bootstrapSource,
    /activeVehicleId:\s*actor\.role === "driver" \? "all" : settings\.active_vehicle_id/,
  );
  assert.match(
    bootstrapSource,
    /actor\.role === "driver"[\s\S]*_ownerRecordsWritable: false/,
  );
});

test("bootstrap 不把 provider email 或 local 手机登录名写入业务数据库", () => {
  assert.match(bootstrapSource, /identity\.issuer/);
  assert.match(bootstrapSource, /identity\.subject/);
  assert.doesNotMatch(bootstrapSource, /\.bind\([\s\S]{0,200}identity\.email/);
  assert.doesNotMatch(bootstrapSource, /identity\.loginName/);
});

test("runtime 加列遇到另一 isolate 抢先成功会继续，真实失败且列仍缺失会重抛", async () => {
  const ensureFuelColumns = runtimeEnsureFuelColumnsForTest();
  const columns = new Set(["fleet_id", "id", "amount_cents"]);
  const alterCalls = [];
  let invariantBatches = 0;
  let raced = false;
  const racingD1 = {
    prepare(sql) {
      return {
        async all() {
          return {
            results: Array.from(columns, (name) => ({ name })),
          };
        },
        async run() {
          const match = /ADD COLUMN (\w+)/.exec(sql);
          if (!match) return { meta: { changes: 0 } };
          const column = match[1];
          alterCalls.push(column);
          if (column === "fuel_unit_price_x10000" && !raced) {
            raced = true;
            columns.add(column);
            throw new Error("duplicate column from competing isolate");
          }
          columns.add(column);
          return { meta: { changes: 0 } };
        },
      };
    },
    async batch() {
      invariantBatches++;
      return [];
    },
  };
  await ensureFuelColumns(racingD1);
  assert.deepEqual(alterCalls, [
    "fuel_unit_price_x10000",
    "fuel_volume_ml",
  ]);
  assert.equal(columns.has("fuel_volume_ml"), true);
  assert.equal(invariantBatches, 1);

  const sentinel = new Error("unrelated ALTER failure");
  const failedCalls = [];
  const failingD1 = {
    prepare(sql) {
      return {
        async all() {
          return {
            results: ["fleet_id", "id", "amount_cents"].map((name) => ({ name })),
          };
        },
        async run() {
          const column = /ADD COLUMN (\w+)/.exec(sql)?.[1];
          if (column) failedCalls.push(column);
          throw sentinel;
        },
      };
    },
    async batch() {
      throw new Error("缺列时不应创建约束 trigger");
    },
  };
  await assert.rejects(() => ensureFuelColumns(failingD1), sentinel);
  assert.deepEqual(failedCalls, ["fuel_unit_price_x10000"]);
});

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

  for (const check of [
    "role IN ('owner', 'driver')",
    "status IN ('open', 'closed')",
    "active IN (0, 1)",
    "sort_order >= 0",
    "amount_cents >= 0",
    "version > 0",
    "PRIMARY KEY (fleet_id, id)",
  ]) {
    assert.ok(runtimeSchemaSource.includes(check), check);
  }
  for (const trigger of INVARIANT_SCHEMA_STATEMENTS) {
    const name = trigger.match(/TRIGGER IF NOT EXISTS\s+(\w+)/)?.[1];
    assert.ok(name, trigger);
    assert.ok(initialMigration.includes(name), name);
  }
  assert.match(
    runtimeSchemaSource,
    /trip_expenses_fuel_metadata_check CHECK \([\s\S]*category_id = 'fuel'/,
  );
  for (const triggerName of [
    "trip_expenses_fuel_metadata_insert_check",
    "trip_expenses_fuel_metadata_update_check",
  ]) {
    assert.ok(runtimeSchemaSource.includes(triggerName), triggerName);
    assert.ok(fuelMigration.includes(triggerName), triggerName);
  }
  assert.match(
    runtimeSchemaSource,
    /BEFORE UPDATE OF category_id, fuel_unit_price_x10000, fuel_volume_ml/,
  );
  assert.match(
    fuelMigration,
    /BEFORE UPDATE OF `category_id`, `fuel_unit_price_x10000`, `fuel_volume_ml`/,
  );
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

test("fuel migration 升级旧库时不回填旧油费，并为新记录落下成对约束", () => {
  const database = hardenedDatabase();
  try {
    const rowCountBefore = database.prepare(
      "SELECT COUNT(*) AS count FROM trip_expenses",
    ).get().count;
    const legacyBefore = {
      ...database.prepare(
        `SELECT fleet_id, id, trip_id, category_id, amount_cents, date, note,
                sort_order, created_at, updated_at, version
           FROM trip_expenses WHERE id = 'e1'`,
      ).get(),
    };
    database.exec(fuelMigration);
    assert.deepEqual(
      database
        .prepare("PRAGMA table_info('trip_expenses')")
        .all()
        .filter((column) => column.name.startsWith("fuel_"))
        .map((column) => column.name),
      ["fuel_unit_price_x10000", "fuel_volume_ml"],
    );
    const legacyAfter = {
      ...database.prepare(
        `SELECT fleet_id, id, trip_id, category_id, amount_cents,
                fuel_unit_price_x10000, fuel_volume_ml, date, note,
                sort_order, created_at, updated_at, version
           FROM trip_expenses WHERE id = 'e1'`,
      ).get(),
    };
    assert.deepEqual(legacyAfter, {
      fleet_id: legacyBefore.fleet_id,
      id: legacyBefore.id,
      trip_id: legacyBefore.trip_id,
      category_id: legacyBefore.category_id,
      amount_cents: legacyBefore.amount_cents,
      fuel_unit_price_x10000: null,
      fuel_volume_ml: null,
      date: legacyBefore.date,
      note: legacyBefore.note,
      sort_order: legacyBefore.sort_order,
      created_at: legacyBefore.created_at,
      updated_at: legacyBefore.updated_at,
      version: legacyBefore.version,
    });
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM trip_expenses").get().count,
      rowCountBefore,
    );
    database.prepare(
      "UPDATE trip_expenses SET fuel_unit_price_x10000 = ?, fuel_volume_ml = ? WHERE id = 'e1'",
    ).run(75000, 13333);
    assert.throws(
      () => database.prepare(
        "UPDATE trip_expenses SET category_id = 'toll' WHERE id = 'e1'",
      ).run(),
      /trip_expenses_fuel_metadata_check/,
    );
    assert.throws(
      () => database.prepare(
        "UPDATE trip_expenses SET fuel_volume_ml = NULL WHERE id = 'e1'",
      ).run(),
      /trip_expenses_fuel_metadata_check/,
    );
    for (const [price, volume] of [
      [0, 1000],
      [10000000, 1000],
      [10000, 100000001],
    ]) {
      assert.throws(
        () => database.prepare(
          "UPDATE trip_expenses SET fuel_unit_price_x10000 = ?, fuel_volume_ml = ? WHERE id = 'e1'",
        ).run(price, volume),
        /trip_expenses_fuel_metadata_check/,
      );
    }
    assert.throws(
      () => database.prepare(
        `INSERT INTO trip_expenses (
           fleet_id, id, trip_id, category_id, amount_cents,
           fuel_unit_price_x10000, fuel_volume_ml, date
         ) VALUES ('f1', 'not-fuel', 't2', 'toll', 100, 10000, 1000, '2026-07-04')`,
      ).run(),
      /trip_expenses_fuel_metadata_check/,
    );
  } finally {
    database.close();
  }
});

test("fuel migration 可从空库顺序建库，runtime 只为旧表规划缺失列", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(initialMigration);
    database.exec(atomicSyncMigration);
    database.exec(fuelMigration);
    database.exec(seedLedger);
    assert.deepEqual(
      { ...database.prepare(
        "SELECT amount_cents, fuel_unit_price_x10000, fuel_volume_ml FROM trip_expenses WHERE id = 'e1'",
      ).get() },
      {
        amount_cents: 10000,
        fuel_unit_price_x10000: null,
        fuel_volume_ml: null,
      },
    );
  } finally {
    database.close();
  }

  assert.deepEqual(
    runtimeFuelAlterStatements,
    [
      "ALTER TABLE trip_expenses ADD COLUMN fuel_unit_price_x10000 INTEGER CHECK (fuel_unit_price_x10000 IS NULL OR fuel_unit_price_x10000 BETWEEN 1 AND 9999999)",
      "ALTER TABLE trip_expenses ADD COLUMN fuel_volume_ml INTEGER CHECK (fuel_volume_ml IS NULL OR fuel_volume_ml BETWEEN 1 AND 100000000)",
    ],
  );
  assert.match(runtimeSchemaSource, /PRAGMA table_info\('trip_expenses'\)/);
  assert.match(
    runtimeSchemaSource,
    /for \(const \[column, statement\] of Object\.entries\([\s\S]*await d1\.prepare\(statement\)\.run\(\);/,
  );
  assert.match(
    runtimeSchemaSource,
    /catch \(error: unknown\) \{[\s\S]*existing = await fuelColumnNames\(d1\);[\s\S]*if \(!existing\.has\(column\)\) throw error;/,
  );
  assert.doesNotMatch(
    runtimeSchemaSource,
    /batch\(statements\.map\(\(statement\) => d1\.prepare\(statement\)\)\)/,
  );
  assert.match(runtimeSchemaSource, /schemaPromise = null;\s*throw error;/);

  const runtimeUpgradeDatabase = hardenedDatabase();
  try {
    for (const statement of runtimeFuelAlterStatements) {
      runtimeUpgradeDatabase.exec(statement);
    }
    assert.deepEqual(
      { ...runtimeUpgradeDatabase.prepare(
        "SELECT fuel_unit_price_x10000, fuel_volume_ml FROM trip_expenses WHERE id = 'e1'",
      ).get() },
      { fuel_unit_price_x10000: null, fuel_volume_ml: null },
    );
  } finally {
    runtimeUpgradeDatabase.close();
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

test("严格同步授权 footprint 同时覆盖换车源/目标与同批子账目", async () => {
  const {
    authorizationVehicleFootprint,
    assignmentGuardVehicleIds,
    batchTripCreateIds,
    operationAuthorizationFootprint,
    parentTripGuardIds,
  } = repositoryAuthorizationHelpersForTest();
  const footprint = (...args) =>
    Array.from(authorizationVehicleFootprint(...args));

  assert.deepEqual(
    footprint(
      { op: "put", type: "trip" },
      { vehicle_id: "v1" },
      { vehicleId: "v2" },
    ),
    ["v1", "v2"],
  );
  assert.deepEqual(
    footprint(
      { op: "put", type: "maintenance" },
      { vehicle_id: "v1" },
      { vehicleId: "v2" },
    ),
    ["v1", "v2"],
  );
  assert.deepEqual(
    footprint(
      { op: "put", type: "trip" },
      null,
      { vehicleId: "v2" },
    ),
    ["v2"],
  );
  assert.deepEqual(
    footprint(
      { op: "delete", type: "trip" },
      { vehicle_id: "v1" },
      undefined,
    ),
    ["v1"],
  );
  for (const type of ["fleet_settings", "category", "vehicle"]) {
    assert.deepEqual(
      footprint(
        { op: "put", type },
        { vehicle_id: "v1" },
        { vehicleId: "v2" },
      ),
      [],
    );
  }
  assert.deepEqual(
    Array.from(
      batchTripCreateIds([
        { op: "put", type: "trip", id: "t-new", expectedVersion: 0 },
        { op: "put", type: "trip", id: "t-update", expectedVersion: 1 },
        {
          op: "put",
          type: "trip_expense",
          id: "t1:e-new",
          expectedVersion: 0,
        },
        { op: "delete", type: "trip", id: "t-delete", expectedVersion: 1 },
      ]),
    ),
    ["t-new"],
    "只有明确 expectedVersion=0 的 parent trip put 可跳过动态 guard",
  );

  const projectedMove = {
    puts: new Map([
      ["trip\u0000t1", { id: "t1", vehicleId: "v2" }],
    ]),
    deletes: new Set(),
    tripCreates: new Set(),
  };
  const d1 = {
    prepare(sql) {
      assert.match(sql, /FROM trips/);
      return {
        bind(fleetId, tripId) {
          assert.equal(fleetId, "f1");
          assert.equal(tripId, "t1");
          return {
            async first() {
              return { id: "t1", vehicle_id: "v1" };
            },
          };
        },
      };
    },
  };
  const childEntries = [];
  for (const type of ["trip_expense", "trip_income"]) {
    const authorization = await operationAuthorizationFootprint(
      d1,
      "f1",
      { op: "put", type, id: `t1:${type}` },
      { trip_id: "t1" },
      { tripId: "t1" },
      projectedMove,
    );
    const vehicleIds = Array.from(authorization.vehicleIds);
    assert.deepEqual(vehicleIds, ["v1", "v2"]);
    assert.deepEqual(Array.from(authorization.parentTripIds), ["t1"]);
    childEntries.push({
      vehicleIds,
      parentTripIds: Array.from(authorization.parentTripIds),
    });
  }

  const tripEntry = {
    vehicleIds: footprint(
      { op: "put", type: "trip" },
      { vehicle_id: "v1" },
      { vehicleId: "v2" },
    ),
    parentTripIds: [],
  };
  assert.deepEqual(
    Array.from(
      assignmentGuardVehicleIds("driver", [tripEntry, ...childEntries]),
    ),
    ["v1", "v2"],
    "重复车辆只能生成一个 assignment guard",
  );
  assert.deepEqual(
    Array.from(
      assignmentGuardVehicleIds("owner", [tripEntry, ...childEntries]),
    ),
    [],
    "owner 不生成 assignment guard",
  );
  assert.deepEqual(
    Array.from(
      parentTripGuardIds("driver", [tripEntry, ...childEntries]),
    ),
    ["t1"],
    "同一个 parent trip 只能生成一个动态 guard",
  );
  assert.deepEqual(
    Array.from(
      parentTripGuardIds("owner", [tripEntry, ...childEntries]),
    ),
    [],
    "owner 不生成 parent trip guard",
  );
});

test("源或目标 assignment 在预检后撤销会原子回滚整个严格同步批次", () => {
  const {
    assignmentGuardVehicleIds,
    prepareActorGuard,
    prepareAssignmentGuard,
    prepareVersionGuard,
  } = repositoryAuthorizationHelpersForTest();
  const actor = {
    fleetId: "f1",
    membershipId: "fm-driver",
    membershipVersion: 1,
    role: "driver",
    userId: "u-driver",
  };
  const operation = {
    op: "put",
    type: "trip",
    id: "t1",
    expectedVersion: 1,
    data: {},
  };
  const vehicleIds = Array.from(
    assignmentGuardVehicleIds("driver", [
      { vehicleIds: ["v1", "v2"] },
      { vehicleIds: ["v1", "v2"] },
    ]),
  );
  assert.deepEqual(vehicleIds, ["v1", "v2"]);

  function authorizationDatabase() {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE fleet_members (
        id TEXT PRIMARY KEY,
        fleet_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        active INTEGER NOT NULL,
        version INTEGER NOT NULL,
        role TEXT NOT NULL
      );
      CREATE TABLE vehicle_assignments (
        fleet_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        vehicle_id TEXT NOT NULL,
        active INTEGER NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT
      );
      CREATE TABLE trips (
        fleet_id TEXT NOT NULL,
        id TEXT NOT NULL,
        vehicle_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        PRIMARY KEY (fleet_id, id)
      );
      CREATE TABLE sync_assertions (
        fleet_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        ok INTEGER NOT NULL CONSTRAINT sync_assertions_ok_check CHECK (ok = 1),
        PRIMARY KEY (fleet_id, operation_id, ordinal)
      );
      CREATE TABLE sync_commits (
        fleet_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        PRIMARY KEY (fleet_id, operation_id)
      );
      INSERT INTO fleet_members
        (id, fleet_id, user_id, active, version, role)
      VALUES ('fm-driver', 'f1', 'u-driver', 1, 1, 'driver');
      INSERT INTO vehicle_assignments
        (fleet_id, user_id, vehicle_id, active, starts_at, ends_at)
      VALUES
        ('f1', 'u-driver', 'v1', 1, '2020-01-01', NULL),
        ('f1', 'u-driver', 'v2', 1, '2020-01-01', NULL);
      INSERT INTO trips (fleet_id, id, vehicle_id, version)
      VALUES ('f1', 't1', 'v1', 1);
    `);
    return database;
  }

  const binder = {
    prepare(sql) {
      return {
        bind(...values) {
          return { sql, values };
        },
      };
    },
  };
  const execute = (database, statement) =>
    database.prepare(statement.sql).run(...statement.values);
  const runBatch = (database, operationId) => {
    database.exec("BEGIN");
    try {
      execute(database, prepareActorGuard(binder, actor, operationId));
      vehicleIds.forEach((vehicleId, index) => {
        execute(
          database,
          prepareAssignmentGuard(
            binder,
            actor,
            operationId,
            -2 - index,
            vehicleId,
          ),
        );
      });
      execute(
        database,
        prepareVersionGuard(
          binder,
          "f1",
          operationId,
          0,
          operation,
        ),
      );
      database
        .prepare(
          "UPDATE trips SET vehicle_id = 'v2', version = 2 WHERE fleet_id = 'f1' AND id = 't1' AND version = 1",
        )
        .run();
      database
        .prepare(
          "DELETE FROM sync_assertions WHERE fleet_id = ? AND operation_id = ?",
        )
        .run("f1", operationId);
      database
        .prepare(
          "INSERT INTO sync_commits (fleet_id, operation_id, request_hash, response_json) VALUES (?, ?, ?, ?)",
        )
        .run("f1", operationId, "hash", "{}");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  for (const revokedVehicleId of ["v1", "v2"]) {
    const database = authorizationDatabase();
    try {
      assert.equal(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM vehicle_assignments WHERE active = 1",
          )
          .get().count,
        2,
        "模拟预检时两侧 assignment 都有效",
      );
      database
        .prepare(
          "UPDATE vehicle_assignments SET active = 0 WHERE vehicle_id = ?",
        )
        .run(revokedVehicleId);
      assert.throws(
        () => runBatch(database, `revoked-${revokedVehicleId}`),
        /sync_assertions_ok_check/,
      );
      assert.deepEqual(
        {
          ...database
            .prepare(
              `SELECT vehicle_id, version,
                 (SELECT COUNT(*) FROM sync_assertions) AS assertions,
                 (SELECT COUNT(*) FROM sync_commits) AS commits
               FROM trips WHERE fleet_id = 'f1' AND id = 't1'`,
            )
            .get(),
        },
        { vehicle_id: "v1", version: 1, assertions: 0, commits: 0 },
      );
    } finally {
      database.close();
    }
  }

  const successful = authorizationDatabase();
  try {
    assert.doesNotThrow(() => runBatch(successful, "both-active"));
    assert.deepEqual(
      {
        ...successful
          .prepare(
            `SELECT vehicle_id, version,
               (SELECT COUNT(*) FROM sync_assertions) AS assertions,
               (SELECT COUNT(*) FROM sync_commits) AS commits
             FROM trips WHERE fleet_id = 'f1' AND id = 't1'`,
          )
          .get(),
      },
      { vehicle_id: "v2", version: 2, assertions: 0, commits: 1 },
    );
  } finally {
    successful.close();
  }

  const actorGuard = syncRepositorySource.indexOf("prepareActorGuard(d1");
  const assignmentGuards = syncRepositorySource.indexOf(
    "const assignmentVehicleIds = assignmentGuardVehicleIds(",
    actorGuard,
  );
  const parentTripGuards = syncRepositorySource.indexOf(
    "parentTripGuardIds(actor.role, entries)",
    assignmentGuards,
  );
  const versionGuards = syncRepositorySource.indexOf(
    "entries.forEach((entry, ordinal)",
    parentTripGuards,
  );
  const cleanup = syncRepositorySource.indexOf(
    "DELETE FROM sync_assertions",
    versionGuards,
  );
  const commit = syncRepositorySource.indexOf(
    "INSERT INTO sync_commits",
    cleanup,
  );
  assert.equal(
    actorGuard < assignmentGuards &&
      assignmentGuards < parentTripGuards &&
      parentTripGuards < versionGuards &&
      versionGuards < cleanup &&
      cleanup < commit,
    true,
    "actor/assignment/parent/version/write/cleanup/commit 顺序保持在同一 batch",
  );
});

test("child 严格同步在事务内按 parent trip 当前车辆重新授权", async () => {
  const {
    assignmentGuardVehicleIds,
    operationAuthorizationFootprint,
    parentTripGuardIds,
    prepareActorGuard,
    prepareAssignmentGuard,
    prepareParentTripAssignmentGuard,
    prepareVersionGuard,
  } = repositoryAuthorizationHelpersForTest();
  const actor = {
    fleetId: "f1",
    membershipId: "fm-driver",
    membershipVersion: 1,
    role: "driver",
    userId: "u-driver",
  };
  const childSpecs = {
    trip_expense: { table: "trip_expenses", id: "e1" },
    trip_income: { table: "trip_incomes", id: "i1" },
  };

  function childGuardDatabase({
    assignedV2 = false,
    children = true,
    parent = true,
  } = {}) {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE fleet_members (
        id TEXT PRIMARY KEY,
        fleet_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        active INTEGER NOT NULL,
        version INTEGER NOT NULL,
        role TEXT NOT NULL
      );
      CREATE TABLE vehicle_assignments (
        fleet_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        vehicle_id TEXT NOT NULL,
        active INTEGER NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT
      );
      CREATE TABLE trips (
        fleet_id TEXT NOT NULL,
        id TEXT NOT NULL,
        vehicle_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        PRIMARY KEY (fleet_id, id)
      );
      CREATE TABLE trip_expenses (
        fleet_id TEXT NOT NULL,
        trip_id TEXT NOT NULL,
        id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        version INTEGER NOT NULL,
        PRIMARY KEY (fleet_id, trip_id, id)
      );
      CREATE TABLE trip_incomes (
        fleet_id TEXT NOT NULL,
        trip_id TEXT NOT NULL,
        id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        version INTEGER NOT NULL,
        PRIMARY KEY (fleet_id, trip_id, id)
      );
      CREATE TABLE sync_assertions (
        fleet_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        ok INTEGER NOT NULL CONSTRAINT sync_assertions_ok_check CHECK (ok = 1),
        PRIMARY KEY (fleet_id, operation_id, ordinal)
      );
      CREATE TABLE sync_commits (
        fleet_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        PRIMARY KEY (fleet_id, operation_id)
      );
      INSERT INTO fleet_members
        (id, fleet_id, user_id, active, version, role)
      VALUES ('fm-driver', 'f1', 'u-driver', 1, 1, 'driver');
      INSERT INTO vehicle_assignments
        (fleet_id, user_id, vehicle_id, active, starts_at, ends_at)
      VALUES ('f1', 'u-driver', 'v1', 1, '2020-01-01', NULL);
    `);
    if (assignedV2) {
      database
        .prepare(
          `INSERT INTO vehicle_assignments
             (fleet_id, user_id, vehicle_id, active, starts_at, ends_at)
           VALUES ('f1', 'u-driver', 'v2', 1, '2020-01-01', NULL)`,
        )
        .run();
    }
    if (parent) {
      database
        .prepare(
          "INSERT INTO trips (fleet_id, id, vehicle_id, version) VALUES ('f1', 't1', 'v1', 1)",
        )
        .run();
    }
    if (children) {
      database.exec(`
        INSERT INTO trip_expenses
          (fleet_id, trip_id, id, amount_cents, version)
        VALUES ('f1', 't1', 'e1', 100, 1);
        INSERT INTO trip_incomes
          (fleet_id, trip_id, id, amount_cents, version)
        VALUES ('f1', 't1', 'i1', 200, 1);
      `);
    }
    return database;
  }

  const projection = (puts = [], deletes = [], tripCreates = []) => ({
    puts: new Map(puts),
    deletes: new Set(deletes),
    tripCreates: new Set(tripCreates),
  });
  const queryD1 = (database) => ({
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              return database.prepare(sql).get(...values) ?? null;
            },
          };
        },
      };
    },
  });
  const binder = {
    prepare(sql) {
      return {
        bind(...values) {
          return { sql, values };
        },
      };
    },
  };
  const execute = (database, statement) =>
    database.prepare(statement.sql).run(...statement.values);
  const guardIds = (entries) => ({
    parentTripIds: Array.from(
      parentTripGuardIds(
        "driver",
        entries.map((entry) => entry.authorization),
      ),
    ),
    vehicleIds: Array.from(
      assignmentGuardVehicleIds(
        "driver",
        entries.map((entry) => entry.authorization),
      ),
    ),
  });
  const runGuardedBatch = (database, operationId, entries) => {
    const { parentTripIds, vehicleIds } = guardIds(entries);
    database.exec("BEGIN");
    try {
      execute(database, prepareActorGuard(binder, actor, operationId));
      vehicleIds.forEach((vehicleId, index) => {
        execute(
          database,
          prepareAssignmentGuard(
            binder,
            actor,
            operationId,
            -2 - index,
            vehicleId,
          ),
        );
      });
      parentTripIds.forEach((tripId, index) => {
        execute(
          database,
          prepareParentTripAssignmentGuard(
            binder,
            actor,
            operationId,
            -2 - vehicleIds.length - index,
            tripId,
          ),
        );
      });
      entries.forEach((entry, ordinal) => {
        execute(
          database,
          prepareVersionGuard(
            binder,
            "f1",
            operationId,
            ordinal,
            entry.operation,
          ),
        );
        entry.write(database);
      });
      database
        .prepare(
          "DELETE FROM sync_assertions WHERE fleet_id = ? AND operation_id = ?",
        )
        .run("f1", operationId);
      database
        .prepare(
          "INSERT INTO sync_commits (fleet_id, operation_id, request_hash, response_json) VALUES (?, ?, ?, ?)",
        )
        .run("f1", operationId, "hash", "{}");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };
  const childOperation = (
    type,
    op = "put",
    tripId = "t1",
    id,
    expectedVersion = op === "put" && tripId !== "t1" ? 0 : 1,
  ) => ({
    op,
    type,
    id: `${tripId}:${id ?? childSpecs[type].id}`,
    expectedVersion,
    ...(op === "put" ? { data: {} } : {}),
  });
  const preflightChild = async (
    database,
    operation,
    batchProjection = projection(),
    current = { trip_id: "t1" },
  ) =>
    operationAuthorizationFootprint(
      queryD1(database),
      "f1",
      operation,
      current,
      operation.op === "put"
        ? { tripId: operation.id.slice(0, operation.id.indexOf(":")) }
        : undefined,
      batchProjection,
    );
  const updateChild = (table, id) => (database) => {
    database
      .prepare(
        `UPDATE ${table} SET amount_cents = amount_cents + 1, version = 2
         WHERE fleet_id = 'f1' AND trip_id = 't1' AND id = ? AND version = 1`,
      )
      .run(id);
  };

  for (const type of ["trip_expense", "trip_income"]) {
    const database = childGuardDatabase();
    const spec = childSpecs[type];
    try {
      const operation = childOperation(type, "put");
      const authorization = await preflightChild(database, operation);
      assert.deepEqual(Array.from(authorization.vehicleIds), ["v1"]);
      assert.deepEqual(Array.from(authorization.parentTripIds), ["t1"]);
      database
        .prepare(
          "UPDATE trips SET vehicle_id = 'v2', version = 2 WHERE fleet_id = 'f1' AND id = 't1'",
        )
        .run();
      assert.throws(
        () =>
          runGuardedBatch(database, `unassigned-parent-${type}`, [
            {
              authorization,
              operation,
              write: updateChild(spec.table, spec.id),
            },
          ]),
        /sync_assertions_ok_check/,
      );
      assert.deepEqual(
        {
          ...database
            .prepare(
              `SELECT amount_cents, version,
                 (SELECT COUNT(*) FROM sync_assertions) AS assertions,
                 (SELECT COUNT(*) FROM sync_commits) AS commits
               FROM ${spec.table}
               WHERE fleet_id = 'f1' AND trip_id = 't1' AND id = ?`,
            )
            .get(spec.id),
        },
        {
          amount_cents: type === "trip_expense" ? 100 : 200,
          version: 1,
          assertions: 0,
          commits: 0,
        },
      );
    } finally {
      database.close();
    }
  }

  const recreatedParent = childGuardDatabase();
  try {
    const operation = childOperation(
      "trip_expense",
      "put",
      "t1",
      "e-recreated",
      0,
    );
    let parentReads = 0;
    const racingD1 = {
      prepare(sql) {
        assert.match(sql, /FROM trips/);
        return {
          bind() {
            return {
              async first() {
                parentReads++;
                return parentReads === 1
                  ? null
                  : { id: "t1", vehicle_id: "v1" };
              },
            };
          },
        };
      },
    };
    const authorization = await operationAuthorizationFootprint(
      racingD1,
      "f1",
      operation,
      null,
      { tripId: "t1" },
      projection(),
    );
    assert.equal(parentReads, 2, "模拟 parent delete/recreate 的双读窗口");
    assert.deepEqual(Array.from(authorization.vehicleIds), ["v1"]);
    assert.deepEqual(
      Array.from(authorization.parentTripIds),
      ["t1"],
      "DB 首次读到 null 也不能省略动态 parent guard",
    );
    recreatedParent
      .prepare(
        "UPDATE trips SET vehicle_id = 'v2', version = 2 WHERE fleet_id = 'f1' AND id = 't1'",
      )
      .run();
    assert.throws(
      () =>
        runGuardedBatch(recreatedParent, "parent-recreated-unassigned", [
          {
            authorization,
            operation,
            write(database) {
              database
                .prepare(
                  "INSERT INTO trip_expenses (fleet_id, trip_id, id, amount_cents, version) VALUES ('f1', 't1', 'e-recreated', 500, 1)",
                )
                .run();
            },
          },
        ]),
      /sync_assertions_ok_check/,
    );
    assert.deepEqual(
      {
        ...recreatedParent
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM trip_expenses WHERE id = 'e-recreated') AS children,
               (SELECT COUNT(*) FROM sync_assertions) AS assertions,
               (SELECT COUNT(*) FROM sync_commits) AS commits`,
          )
          .get(),
      },
      { children: 0, assertions: 0, commits: 0 },
    );
  } finally {
    recreatedParent.close();
  }

  const assignedMove = childGuardDatabase({ assignedV2: true });
  try {
    const operation = childOperation("trip_expense", "put");
    const authorization = await preflightChild(assignedMove, operation);
    assignedMove
      .prepare(
        "UPDATE trips SET vehicle_id = 'v2', version = 2 WHERE fleet_id = 'f1' AND id = 't1'",
      )
      .run();
    assert.doesNotThrow(() =>
      runGuardedBatch(assignedMove, "assigned-parent-move", [
        {
          authorization,
          operation,
          write: updateChild("trip_expenses", "e1"),
        },
      ]),
    );
    assert.deepEqual(
      {
        ...assignedMove
          .prepare(
            `SELECT amount_cents, version,
               (SELECT COUNT(*) FROM sync_commits) AS commits
             FROM trip_expenses
             WHERE fleet_id = 'f1' AND trip_id = 't1' AND id = 'e1'`,
          )
          .get(),
      },
      { amount_cents: 101, version: 2, commits: 1 },
    );
  } finally {
    assignedMove.close();
  }

  const deletedParent = childGuardDatabase();
  try {
    const operation = childOperation("trip_expense", "delete");
    const authorization = await preflightChild(deletedParent, operation);
    deletedParent
      .prepare("DELETE FROM trips WHERE fleet_id = 'f1' AND id = 't1'")
      .run();
    assert.throws(
      () =>
        runGuardedBatch(deletedParent, "parent-deleted", [
          {
            authorization,
            operation,
            write(database) {
              database
                .prepare(
                  "DELETE FROM trip_expenses WHERE fleet_id = 'f1' AND trip_id = 't1' AND id = 'e1' AND version = 1",
                )
                .run();
            },
          },
        ]),
      /sync_assertions_ok_check/,
    );
    assert.equal(
      deletedParent
        .prepare(
          "SELECT COUNT(*) AS count FROM trip_expenses WHERE fleet_id = 'f1' AND trip_id = 't1' AND id = 'e1'",
        )
        .get().count,
      1,
    );
    assert.equal(
      deletedParent.prepare("SELECT COUNT(*) AS count FROM sync_commits").get()
        .count,
      0,
    );
  } finally {
    deletedParent.close();
  }

  const sameBatchMove = childGuardDatabase({ assignedV2: true });
  try {
    const batchProjection = projection([
      ["trip\u0000t1", { id: "t1", vehicleId: "v2" }],
    ]);
    const tripOperation = {
      op: "put",
      type: "trip",
      id: "t1",
      expectedVersion: 1,
      data: {},
    };
    const child = childOperation("trip_income", "put");
    const tripAuthorization = await operationAuthorizationFootprint(
      queryD1(sameBatchMove),
      "f1",
      tripOperation,
      { vehicle_id: "v1" },
      { vehicleId: "v2" },
      batchProjection,
    );
    const childAuthorization = await preflightChild(
      sameBatchMove,
      child,
      batchProjection,
    );
    const entries = [
      {
        authorization: tripAuthorization,
        operation: tripOperation,
        write(database) {
          database
            .prepare(
              "UPDATE trips SET vehicle_id = 'v2', version = 2 WHERE fleet_id = 'f1' AND id = 't1' AND version = 1",
            )
            .run();
        },
      },
      {
        authorization: childAuthorization,
        operation: child,
        write: updateChild("trip_incomes", "i1"),
      },
    ];
    assert.deepEqual(guardIds(entries), {
      parentTripIds: ["t1"],
      vehicleIds: ["v1", "v2"],
    });
    assert.doesNotThrow(() =>
      runGuardedBatch(sameBatchMove, "same-batch-move", entries),
    );
    assert.deepEqual(
      {
        ...sameBatchMove
          .prepare(
            `SELECT vehicle_id, version,
               (SELECT amount_cents FROM trip_incomes WHERE id = 'i1') AS income,
               (SELECT COUNT(*) FROM sync_commits) AS commits
             FROM trips WHERE fleet_id = 'f1' AND id = 't1'`,
          )
          .get(),
      },
      { vehicle_id: "v2", version: 2, income: 201, commits: 1 },
    );
  } finally {
    sameBatchMove.close();
  }

  const sameBatchCreate = childGuardDatabase({
    assignedV2: true,
    children: false,
    parent: false,
  });
  try {
    const batchProjection = projection(
      [["trip\u0000t-new", { id: "t-new", vehicleId: "v2" }]],
      [],
      ["t-new"],
    );
    const tripOperation = {
      op: "put",
      type: "trip",
      id: "t-new",
      expectedVersion: 0,
      data: {},
    };
    const child = childOperation("trip_expense", "put", "t-new", "e-new");
    const tripAuthorization = await operationAuthorizationFootprint(
      queryD1(sameBatchCreate),
      "f1",
      tripOperation,
      null,
      { vehicleId: "v2" },
      batchProjection,
    );
    const childAuthorization = await preflightChild(
      sameBatchCreate,
      child,
      batchProjection,
      null,
    );
    const entries = [
      {
        authorization: tripAuthorization,
        operation: tripOperation,
        write(database) {
          database
            .prepare(
              "INSERT INTO trips (fleet_id, id, vehicle_id, version) VALUES ('f1', 't-new', 'v2', 1)",
            )
            .run();
        },
      },
      {
        authorization: childAuthorization,
        operation: child,
        write(database) {
          database
            .prepare(
              "INSERT INTO trip_expenses (fleet_id, trip_id, id, amount_cents, version) VALUES ('f1', 't-new', 'e-new', 300, 1)",
            )
            .run();
        },
      },
    ];
    assert.deepEqual(guardIds(entries), {
      parentTripIds: [],
      vehicleIds: ["v2"],
    });
    assert.doesNotThrow(() =>
      runGuardedBatch(sameBatchCreate, "same-batch-create", entries),
    );
    assert.equal(
      sameBatchCreate
        .prepare(
          "SELECT COUNT(*) AS count FROM trip_expenses WHERE trip_id = 't-new' AND id = 'e-new'",
        )
        .get().count,
      1,
    );
  } finally {
    sameBatchCreate.close();
  }

  const racedParentCreate = childGuardDatabase({
    assignedV2: true,
    children: false,
    parent: false,
  });
  try {
    const batchProjection = projection(
      [["trip\u0000t-new", { id: "t-new", vehicleId: "v2" }]],
      [],
      ["t-new"],
    );
    const tripOperation = {
      op: "put",
      type: "trip",
      id: "t-new",
      expectedVersion: 0,
      data: {},
    };
    const child = childOperation("trip_expense", "put", "t-new", "e-new");
    const tripAuthorization = await operationAuthorizationFootprint(
      queryD1(racedParentCreate),
      "f1",
      tripOperation,
      null,
      { vehicleId: "v2" },
      batchProjection,
    );
    const childAuthorization = await preflightChild(
      racedParentCreate,
      child,
      batchProjection,
      null,
    );
    assert.deepEqual(Array.from(childAuthorization.parentTripIds), []);
    racedParentCreate
      .prepare(
        "INSERT INTO trips (fleet_id, id, vehicle_id, version) VALUES ('f1', 't-new', 'v1', 1)",
      )
      .run();
    assert.throws(
      () =>
        runGuardedBatch(racedParentCreate, "parent-create-raced", [
          {
            authorization: tripAuthorization,
            operation: tripOperation,
            write(database) {
              database
                .prepare(
                  "INSERT INTO trips (fleet_id, id, vehicle_id, version) VALUES ('f1', 't-new', 'v2', 1)",
                )
                .run();
            },
          },
          {
            authorization: childAuthorization,
            operation: child,
            write(database) {
              database
                .prepare(
                  "INSERT INTO trip_expenses (fleet_id, trip_id, id, amount_cents, version) VALUES ('f1', 't-new', 'e-new', 300, 1)",
                )
                .run();
            },
          },
        ]),
      /sync_assertions_ok_check/,
    );
    assert.deepEqual(
      {
        ...racedParentCreate
          .prepare(
            `SELECT vehicle_id,
               (SELECT COUNT(*) FROM trip_expenses WHERE id = 'e-new') AS children,
               (SELECT COUNT(*) FROM sync_assertions) AS assertions,
               (SELECT COUNT(*) FROM sync_commits) AS commits
             FROM trips WHERE id = 't-new'`,
          )
          .get(),
      },
      { vehicle_id: "v1", children: 0, assertions: 0, commits: 0 },
    );
  } finally {
    racedParentCreate.close();
  }

  const sameBatchDelete = childGuardDatabase();
  try {
    const batchProjection = projection([], ["trip\u0000t1"]);
    const child = childOperation("trip_expense", "delete");
    const tripOperation = {
      op: "delete",
      type: "trip",
      id: "t1",
      expectedVersion: 1,
    };
    const childAuthorization = await preflightChild(
      sameBatchDelete,
      child,
      batchProjection,
    );
    const tripAuthorization = await operationAuthorizationFootprint(
      queryD1(sameBatchDelete),
      "f1",
      tripOperation,
      { vehicle_id: "v1" },
      undefined,
      batchProjection,
    );
    const entries = [
      {
        authorization: childAuthorization,
        operation: child,
        write(database) {
          database
            .prepare(
              "DELETE FROM trip_expenses WHERE fleet_id = 'f1' AND trip_id = 't1' AND id = 'e1' AND version = 1",
            )
            .run();
        },
      },
      {
        authorization: tripAuthorization,
        operation: tripOperation,
        write(database) {
          database
            .prepare(
              "DELETE FROM trips WHERE fleet_id = 'f1' AND id = 't1' AND version = 1",
            )
            .run();
        },
      },
    ];
    assert.deepEqual(guardIds(entries), {
      parentTripIds: ["t1"],
      vehicleIds: ["v1"],
    });
    assert.doesNotThrow(() =>
      runGuardedBatch(sameBatchDelete, "same-batch-delete", entries),
    );
    assert.deepEqual(
      {
        ...sameBatchDelete
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM trips WHERE id = 't1') AS trips,
               (SELECT COUNT(*) FROM trip_expenses WHERE id = 'e1') AS expenses,
               (SELECT COUNT(*) FROM sync_commits) AS commits`,
          )
          .get(),
      },
      { trips: 0, expenses: 0, commits: 1 },
    );
  } finally {
    sameBatchDelete.close();
  }
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
