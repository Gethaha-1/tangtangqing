import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/cloud-sync.js';

const Cloud = globalThis.TTQCloudSync;

function stateFixture() {
  return {
    schemaVersion: 2,
    settings: {
      theme: 'night',
      lastReportSeen: '2026-06',
      lastBackupAt: '2026-07-01',
      activeVehicleId: 'all',
      periodStartDate: '2026-03-15',
      periodEndDate: '2027-03-14'
    },
    categories: {
      expense: [
        { id: 'fuel', name: '油费', icon: '⛽', builtin: true, active: true },
        { id: 'other', name: '其他', icon: '📌', builtin: true, active: false }
      ],
      income: [
        { id: 'cargo', name: '拉菜收入', icon: '🥬', builtin: true, active: true }
      ]
    },
    vehicles: [
      { id: 'v1', name: '一号车', plateNo: '川A1', active: true, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'v2', name: '二号车', plateNo: '', active: true, createdAt: '2026-02-01T00:00:00.000Z' }
    ],
    trips: [
      {
        id: 't1',
        vehicleId: 'v1',
        startDate: '2026-07-01',
        endDate: '2026-07-03',
        status: 'closed',
        createdAt: '2026-07-01T01:00:00.000Z',
        closedAt: '2026-07-03T12:00:00.000Z',
        expenses: [
          { id: 'e1', catId: 'fuel', amount: 800.25, date: '2026-07-01', note: '加油' },
          { id: 'e2', catId: 'other', amount: 15, date: '2026-07-02', note: '' }
        ],
        incomes: [
          { id: 'i1', catId: 'cargo', amount: 2200.5, date: '2026-07-03' }
        ]
      },
      {
        id: 't2',
        vehicleId: 'v2',
        startDate: '2026-07-04',
        endDate: null,
        status: 'open',
        createdAt: '2026-07-04T01:00:00.000Z',
        expenses: [],
        incomes: []
      }
    ],
    maintenance: [
      { id: 'm1', vehicleId: 'v1', date: '2026-07-05', amount: 300, note: '补胎' }
    ]
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('schema v2 拆成独立记录并能无损重组现有状态', () => {
  const state = stateFixture();
  const records = Cloud.normalizeState(state);
  assert.deepEqual(
    records.reduce((counts, item) => {
      counts[item.type] = (counts[item.type] || 0) + 1;
      return counts;
    }, {}),
    {
      fleet_settings: 1,
      category: 3,
      vehicle: 2,
      trip: 2,
      trip_expense: 2,
      trip_income: 1,
      maintenance: 1
    }
  );
  assert.equal(records.find(item => item.type === 'category').id, 'expense:fuel');
  assert.equal(records.find(item => item.type === 'trip_expense').id, 't1:e1');
  assert.deepEqual(Cloud.recordsToState(records), state);
});

test('不同车辆和不同子账目只产生自己的 put，不覆盖整趟或其他车辆', () => {
  const before = stateFixture();
  const after = clone(before);
  after.vehicles[1].plateNo = '川B2';
  after.trips[0].expenses[1].amount = 25;

  const operations = Cloud.planSync(after, Cloud.normalizeState(before), {
    'vehicle:v2': 4,
    'trip_expense:t1:e2': 9
  });
  assert.deepEqual(
    operations.map(item => [item.op, item.type, item.id, item.expectedVersion]),
    [
      ['put', 'vehicle', 'v2', 4],
      ['put', 'trip_expense', 't1:e2', 9]
    ]
  );
  assert.equal(operations.some(item => item.type === 'trip'), false);
  assert.equal(operations.some(item => item.id === 'v1'), false);
});

test('删除生成显式 delete 操作且版本原样透传', () => {
  const before = stateFixture();
  const baseline = Cloud.normalizeState(before, {
    'trip_expense:t1:e2': 17,
    'maintenance:m1': 23
  });
  const after = clone(before);
  after.trips[0].expenses.splice(1, 1);
  after.maintenance = [];

  const operations = Cloud.planSync(after, baseline);
  assert.deepEqual(operations, [
    { op: 'delete', type: 'maintenance', id: 'm1', expectedVersion: 23 },
    { op: 'delete', type: 'trip_expense', id: 't1:e2', expectedVersion: 17 }
  ]);
});

test('独立 versions 参数优先于 baseline 版本', () => {
  const before = stateFixture();
  const baseline = Cloud.normalizeState(before, { 'vehicle:v1': 2 });
  const after = clone(before);
  after.vehicles[0].name = '主车';

  const operations = Cloud.planSync(after, baseline, { vehicle: { v1: 31 } });
  assert.equal(operations.length, 1);
  assert.deepEqual(operations[0], {
    op: 'put',
    type: 'vehicle',
    id: 'v1',
    data: Object.assign({}, after.vehicles[0], { sortOrder: 0 }),
    expectedVersion: 31
  });
});

test('旧 v2 数据上传再重组时数量和金额完全守恒', () => {
  const before = stateFixture();
  before.trips[0].expenses[0].amount = '800.25';
  before.maintenance[0].amount = '300.10';
  const records = Cloud.normalizeState(before);
  const restored = Cloud.recordsToState({ records });
  const comparison = Cloud.compareSummaries(before, restored);

  assert.equal(comparison.equal, true);
  assert.deepEqual(comparison.differences, []);
  assert.deepEqual(comparison.before, {
    counts: {
      vehicles: 2,
      expenseCategories: 2,
      incomeCategories: 1,
      trips: 2,
      tripExpenses: 2,
      tripIncomes: 1,
      maintenance: 1
    },
    amounts: {
      tripExpenses: 815.25,
      tripIncomes: 2200.5,
      maintenance: 300.1
    }
  });
  assert.equal(restored.trips[0].expenses[0].amount, '800.25');
  assert.equal(restored.maintenance[0].amount, '300.10');
  assert.deepEqual(Cloud.planSync(restored, records), []);
});

test('守恒比较会明确列出金额或数量差异', () => {
  const before = stateFixture();
  const after = clone(before);
  after.trips[0].incomes[0].amount = 2000;
  after.maintenance.push({
    id: 'm2',
    vehicleId: 'v2',
    date: '2026-07-06',
    amount: 80,
    note: ''
  });
  const comparison = Cloud.compareConservation(before, after);
  assert.equal(comparison.equal, false);
  assert.deepEqual(
    comparison.differences.map(item => item.field).sort(),
    ['amounts.maintenance', 'amounts.tripIncomes', 'counts.maintenance']
  );
});

test('首次迁移明确区分上传提示、使用云端和双方数据冲突', () => {
  const local = stateFixture();
  assert.deepEqual(
    Cloud.decideInitialMigration(local, { records: [], cloudEmpty: true }),
    {
      status: 'offer-upload',
      localSnapshotFound: true,
      localHasData: true,
      cloudEmpty: true,
      requiresExplicitAction: true
    }
  );
  assert.equal(
    Cloud.decideInitialMigration(null, {
      records: Cloud.normalizeState(stateFixture()),
      cloudEmpty: false
    }).status,
    'use-cloud'
  );
  const conflict = Cloud.decideInitialMigration(local, {
    records: Cloud.normalizeState(stateFixture()),
    cloudEmpty: false
  });
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.requiresExplicitAction, true);
});

test('重组遇到重复记录或孤儿子账目时拒绝静默丢数据', () => {
  const records = Cloud.normalizeState(stateFixture());
  assert.throws(
    () => Cloud.recordsToState(records.concat(clone(records[0]))),
    /云记录重复/
  );
  assert.throws(
    () => Cloud.recordsToState(records.filter(item => !(item.type === 'trip' && item.id === 't1'))),
    /找不到所属趟次/
  );
});

test('首次上传按外键依赖顺序写入，删除时反向清理', () => {
  const state = stateFixture();
  const puts = Cloud.planSync(state, []);
  assert.ok(
    puts.findIndex(item => item.type === 'vehicle') <
      puts.findIndex(item => item.type === 'trip')
  );
  assert.ok(
    puts.findIndex(item => item.type === 'trip') <
      puts.findIndex(item => item.type === 'trip_expense')
  );
  const deletes = Cloud.planSync({
    schemaVersion: 2,
    settings: state.settings,
    categories: { expense: [], income: [] },
    vehicles: [],
    trips: [],
    maintenance: []
  }, Cloud.normalizeState(state, Object.fromEntries(
    Cloud.normalizeState(state).map(item => [Cloud.recordKey(item.type, item.id), 1])
  )));
  assert.ok(
    deletes.findIndex(item => item.type === 'trip_expense') <
      deletes.findIndex(item => item.type === 'trip')
  );
  assert.ok(
    deletes.findIndex(item => item.type === 'trip') <
      deletes.findIndex(item => item.type === 'vehicle')
  );

  const withInactiveFirst = stateFixture();
  withInactiveFirst.vehicles[0].active = false;
  const vehiclePuts = Cloud.planSync(withInactiveFirst, [])
    .filter(item => item.op === 'put' && item.type === 'vehicle');
  assert.deepEqual(
    vehiclePuts.map(item => [item.id, item.data.active]),
    [['v2', true], ['v1', false]]
  );
});

test('大型旧账上传会稳定拆成可重试的小批次', () => {
  const operations = Array.from({ length: 501 }, (_, index) => ({ id: index }));
  const chunks = Cloud.chunkOperations(operations, 200);
  assert.deepEqual(chunks.map(items => items.length), [200, 200, 101]);
  assert.equal(chunks[2][100].id, 500);
  assert.throws(() => Cloud.chunkOperations(operations, 0), /正整数/);
});

test('设备待上传缓存只在云端版本未变化时安全续传', () => {
  const baseline = Cloud.normalizeState(stateFixture(), {
    'vehicle:v1': 3,
    'fleet_settings:settings': 4
  });
  const pending = clone(stateFixture());
  pending.vehicles[0].name = '离线改名';
  const cache = { state: pending, baselineRecords: baseline };

  assert.equal(
    Cloud.inspectPendingCache(cache, { records: baseline }).status,
    'safe'
  );
  const changedRemote = clone(baseline);
  changedRemote.find(item => item.type === 'vehicle' && item.id === 'v1').version = 4;
  const conflict = Cloud.inspectPendingCache(cache, { records: changedRemote });
  assert.equal(conflict.status, 'conflict');
  assert.deepEqual(conflict.conflicts, ['vehicle:v1']);
});

test('超过一批的混合同步仍全局先删除依赖，再写入新记录', () => {
  const before = stateFixture();
  before.trips = Array.from({ length: 205 }, (_, index) => ({
    id: 'old-' + index,
    vehicleId: 'v1',
    startDate: '2026-07-01',
    endDate: '2026-07-02',
    status: 'closed',
    createdAt: '2026-07-01T00:00:00.000Z',
    expenses: [{ id: 'expense-' + index, catId: 'fuel', amount: 1, date: '2026-07-01', note: '' }],
    incomes: []
  }));
  const after = stateFixture();
  after.trips = [{
    id: 'new-trip',
    vehicleId: 'v2',
    startDate: '2026-07-10',
    endDate: null,
    status: 'open',
    createdAt: '2026-07-10T00:00:00.000Z',
    expenses: [],
    incomes: []
  }];
  const baseline = Cloud.normalizeState(before, Object.fromEntries(
    Cloud.normalizeState(before).map(item => [Cloud.recordKey(item.type, item.id), 1])
  ));
  const operations = Cloud.planSync(after, baseline);
  const firstPut = operations.findIndex(item => item.op === 'put');
  assert.ok(firstPut > 200);
  assert.equal(operations.slice(0, firstPut).every(item => item.op === 'delete'), true);
  assert.equal(operations.slice(firstPut).every(item => item.op === 'put'), true);
  const chunks = Cloud.chunkOperations(operations, 200);
  assert.equal(chunks[0].every(item => item.op === 'delete'), true);
});

test('旧账处理标记对字段顺序稳定，内容变化时会改变', () => {
  const first = { a: 1, nested: { b: 2, c: 3 } };
  const reordered = { nested: { c: 3, b: 2 }, a: 1 };
  assert.equal(
    Cloud.snapshotFingerprint(first),
    Cloud.snapshotFingerprint(reordered)
  );
  assert.notEqual(
    Cloud.snapshotFingerprint(first),
    Cloud.snapshotFingerprint({ a: 2, nested: { b: 2, c: 3 } })
  );
});

test('本批成功只更新已写记录基线，不会把并发新增变成下次 delete', () => {
  const before = stateFixture();
  const versions = Object.fromEntries(
    Cloud.normalizeState(before).map(item => [Cloud.recordKey(item.type, item.id), 1])
  );
  const baseline = Cloud.normalizeState(before, versions);
  const pending = clone(before);
  pending.vehicles[0].name = '设备改名';
  const operations = Cloud.planSync(pending, baseline);
  assert.deepEqual(
    operations.map(item => Cloud.recordKey(item.type, item.id)),
    ['vehicle:v1']
  );

  const updatedBaseline = Cloud.applySyncResults(baseline, operations, [{
    op: 'put',
    type: 'vehicle',
    id: 'v1',
    status: 'applied',
    version: 2,
    data: operations[0].data
  }]);
  assert.deepEqual(Cloud.planSync(pending, updatedBaseline), []);

  const remoteState = clone(pending);
  remoteState.maintenance.push({
    id: 'm-concurrent',
    vehicleId: 'v2',
    date: '2026-07-07',
    amount: 88,
    note: '另一设备新增'
  });
  const concurrentRecord = Cloud.normalizeState(remoteState)
    .find(item => item.type === 'maintenance' && item.id === 'm-concurrent');
  concurrentRecord.version = 1;
  const fullRemote = updatedBaseline.concat(concurrentRecord);
  assert.equal(fullRemote.some(item => item.id === 'm-concurrent'), true);

  // 正常保存不把未参与本批的完整远端快照换成 baseline。
  assert.equal(
    updatedBaseline.some(item => item.id === 'm-concurrent'),
    false
  );
  assert.equal(
    Cloud.planSync(pending, updatedBaseline)
      .some(item => item.op === 'delete' && item.id === 'm-concurrent'),
    false
  );
});

test('重试拉取完整远端后合并非冲突新增，只续传本地改动', () => {
  const before = stateFixture();
  const versions = Object.fromEntries(
    Cloud.normalizeState(before).map(item => [Cloud.recordKey(item.type, item.id), 3])
  );
  const baseline = Cloud.normalizeState(before, versions);
  const pending = clone(before);
  pending.vehicles[0].name = '离线改名';

  const remoteState = clone(before);
  remoteState.maintenance.push({
    id: 'm-remote',
    vehicleId: 'v2',
    date: '2026-07-08',
    amount: 66,
    note: '远端新增'
  });
  const remote = Cloud.normalizeState(remoteState, Object.assign({}, versions, {
    'maintenance:m-remote': 1
  }));
  const merged = Cloud.mergeRemoteState(pending, baseline, { records: remote });
  assert.equal(merged.maintenance.some(item => item.id === 'm-remote'), true);
  assert.equal(merged.vehicles[0].name, '离线改名');

  const retryOperations = Cloud.planSync(merged, remote);
  assert.deepEqual(
    retryOperations.map(item => [item.op, item.type, item.id]),
    [['put', 'vehicle', 'v1']]
  );
});

test('首次迁移只核对目标 key，远端并发额外记录不破坏守恒', () => {
  const target = stateFixture();
  const remoteState = clone(target);
  remoteState.maintenance.push({
    id: 'm-extra',
    vehicleId: 'v2',
    date: '2026-07-09',
    amount: 120,
    note: '并发新增'
  });
  const remote = Cloud.normalizeState(remoteState);
  const comparison = Cloud.compareMigrationTarget(target, { records: remote });
  assert.equal(comparison.equal, true);
  assert.deepEqual(comparison.missing, []);
  assert.equal(Cloud.hydrateState(remote).maintenance.length, 2);
});

test('设备缓存写入失败时保存失败结果明确 deviceCached=false', () => {
  const error = new Error('云端暂时不可用');
  const failure = Cloud.saveFailureResult(error, false);
  assert.equal(failure.ok, false);
  assert.equal(failure.deviceCached, false);
  assert.equal(failure.error, error);
});
