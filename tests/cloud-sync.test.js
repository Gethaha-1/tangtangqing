import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/cloud-sync.js';

const Cloud = globalThis.TTQCloudSync;

function stateFixture() {
  return {
    schemaVersion: 5,
    settings: {
      theme: 'night',
      lastReportSeen: '2026-06',
      lastBackupAt: '2026-07-01',
      activeVehicleId: 'all',
      periodStartDate: '2026-03-15',
      periodEndDate: '2027-03-14',
      business: {
        shippers: [], shipperGroups: [], places: [],
        cargoCatalogs: {
          outbound: [{ id: 'produce', name: '拉菜', active: true, builtin: true, sortOrder: 0 }],
          return: [{ id: 'corn', name: '玉米', active: true, builtin: true, sortOrder: 0 }]
        }
      }
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
        ],
        business: {}
      },
      {
        id: 't2',
        vehicleId: 'v2',
        startDate: '2026-07-04',
        endDate: null,
        status: 'open',
        createdAt: '2026-07-04T01:00:00.000Z',
        expenses: [],
        incomes: [],
        business: {}
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

test('schema v5 拆成独立记录并能无损重组现有状态', () => {
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

test('货主设置、去程分摊和返程实收 0 在云记录中无损往返', () => {
  const state = stateFixture();
  state.settings.business = {
    shippers: [{ id: 's1', name: '王师傅', markets: [{ id: 'm1', name: '北市场', region: '济南' }] }],
    shipperGroups: [{ id: 'g1', name: '早市组', mainRef: { shipperId: 's1', marketId: 'm1' }, members: [{ shipperId: 's1', marketId: 'm1' }] }],
    places: [{ id: 'p1', name: '粮库', region: '德州', roadNote: '', handlingNote: '', note: '', placeId: '', updatedAt: '2026-09-08T00:00:00.000Z' }],
    cargoCatalogs: {
      outbound: [{ id: 'produce', name: '拉菜', active: true, builtin: true, sortOrder: 0 }],
      return: [{ id: 'corn', name: '玉米', active: true, builtin: true, sortOrder: 0 }]
    }
  };
  state.trips[0].business = {
    outbound: { cargoTypeId: 'produce', cargoTypeName: '拉菜', totalFreight: 6000, totalBoxSlots: '1', allocatedTotal: 6000, roundingTotal: 5, finalTotal: 5995,
      allocations: [{ id: 'a1', shipperId: 's1', shipperName: '王师傅', marketId: 'm1', marketName: '北市场', marketRegion: '济南', boxSlots: '1', allocatedAmount: 6000, roundingAmount: 5, finalAmount: 5995 }] },
    returnTrip: { cargoTypeId: 'corn', cargoTypeName: '玉米', loadedTons: '30', unitPrice: '240', receivableAmount: 7200, actualReceivedAmount: 0, effectiveAmount: 0,
      unloadedTons: '29.95', lossKg: '50', lossReferenceKg: '50', lossDeductionAmount: 40, weightGainConfirmed: false, pickupLocation: {}, deliveryLocation: {} }
  };
  const records = Cloud.normalizeState(state);
  assert.deepEqual(Cloud.recordsToState(records), state);
  const summary = Cloud.summarizeState(state);
  assert.deepEqual({ shippers: summary.business.shippers, markets: summary.business.markets, groups: summary.business.shipperGroups,
    places: summary.business.places, outboundCargo: summary.business.outboundCargoTypes, returnCargo: summary.business.returnCargoTypes,
    outbound: summary.business.outboundTrips, returns: summary.business.returnTrips },
  { shippers: 1, markets: 1, groups: 1, places: 1, outboundCargo: 1, returnCargo: 1, outbound: 1, returns: 1 });

  const changed = clone(state);
  changed.trips[0].business.returnTrip.actualReceivedAmount = null;
  changed.trips[0].business.returnTrip.effectiveAmount = 7200;
  assert.deepEqual(Cloud.planSync(changed, records).map(item => [item.type, item.id]), [['trip', 't1']]);
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

test('同一快记清单的多条支出会规划为同一批中的独立新增操作', () => {
  const before = stateFixture();
  const baseline = Cloud.normalizeState(before);
  const after = clone(before);
  after.trips[1].expenses.push(
    { id: 'batch-fuel', catId: 'fuel', amount: 300, date: '2026-07-04', note: '', fuel: { unitPrice: '7.5', liters: '40' } },
    { id: 'batch-toll', catId: 'other', amount: 25, date: '2026-07-04', note: '高速' },
    { id: 'batch-meal', catId: 'other', amount: 18.5, date: '2026-07-04', note: '午饭' }
  );

  const operations = Cloud.planSync(after, baseline);
  assert.deepEqual(
    operations.map(item => [item.op, item.type, item.id, item.expectedVersion]),
    [
      ['put', 'trip_expense', 't2:batch-fuel', 0],
      ['put', 'trip_expense', 't2:batch-meal', 0],
      ['put', 'trip_expense', 't2:batch-toll', 0]
    ]
  );
  assert.equal(operations.some(item => item.type === 'trip'), false);
});

test('司机裁剪视图只同步业务记录，不生成 owner-only 或本地兜底写入', () => {
  const driver = stateFixture();
  driver.settings._ownerRecordsWritable = false;
  driver.settings.activeVehicleId = 'all';
  driver.vehicles = [driver.vehicles[0]];
  driver.trips = [driver.trips[0]];
  driver.maintenance = driver.maintenance.filter(item => item.vehicleId === 'v1');
  const baseline = Cloud.normalizeState(driver, Object.fromEntries(
    Cloud.normalizeState(driver).map(item => [Cloud.recordKey(item.type, item.id), 2])
  ));
  const proposal = clone(driver);
  proposal.settings.activeVehicleId = 'hidden-owner-vehicle';
  proposal.settings.periodStartDate = '2026-04-01';
  proposal.categories.expense[0].name = '司机不应改科目';
  proposal.vehicles.push({
    id: 'vehicle_legacy', name: '不应上传的本地兜底', plateNo: '', active: true
  });
  proposal.trips[0].expenses[1].amount = 16;
  const operations = Cloud.planSync(proposal, baseline);
  assert.deepEqual(
    operations.map(item => [item.op, item.type, item.id]),
    [['put', 'trip_expense', 't1:e2']]
  );

  const zeroAssignment = clone(driver);
  zeroAssignment.vehicles = [];
  zeroAssignment.trips = [];
  zeroAssignment.maintenance = [];
  const emptyBaseline = Cloud.normalizeState(zeroAssignment);
  const hydrated = Cloud.hydrateState(emptyBaseline, stateFixture());
  assert.deepEqual(hydrated.vehicles, []);
  assert.deepEqual(Cloud.planSync(hydrated, emptyBaseline), []);

  const owner = stateFixture();
  const ownerBaseline = Cloud.normalizeState(owner);
  const ownerProposal = clone(owner);
  ownerProposal.settings.periodStartDate = '2026-04-01';
  ownerProposal.vehicles[0].name = '车主改名';
  assert.deepEqual(
    Cloud.planSync(ownerProposal, ownerBaseline).map(item => item.type).sort(),
    ['fleet_settings', 'vehicle']
  );
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
  before.schemaVersion = 2;
  delete before.settings.business.cargoCatalogs;
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
    },
    exactAmounts: {
      tripExpensesCents: '81525',
      tripIncomesCents: '220050',
      maintenanceCents: '30010'
    },
    fuel: {
      structuredRecords: 0,
      legacyRecords: 1,
      totalVolumeMl: 0,
      structuredCostCents: 0,
      fingerprint: Cloud.snapshotFingerprint([])
    },
    business: {
      shippers: 0,
      markets: 0,
      shipperGroups: 0,
      places: 0,
      outboundCargoTypes: 0,
      returnCargoTypes: 0,
      outboundTrips: 0,
      returnTrips: 0,
      fingerprint: Cloud.snapshotFingerprint([
        'fleet_settings|{"places":[],"shipperGroups":[],"shippers":[]}'
      ])
    }
  });
  assert.equal(restored.trips[0].expenses[0].amount, '800.25');
  assert.equal(restored.maintenance[0].amount, '300.10');
  assert.deepEqual(Cloud.planSync(restored, records), []);
});

test('v2 hydrate 升 v5 不回填 fuel，也不产生全量 put', () => {
  const v2 = stateFixture();
  v2.schemaVersion = 2;
  const records = Cloud.normalizeState(v2);
  const hydrated = Cloud.hydrateState(records);
  assert.equal(hydrated.schemaVersion, 5);
  assert.equal(
    Object.prototype.hasOwnProperty.call(hydrated.trips[0].expenses[0], 'fuel'),
    false
  );
  assert.deepEqual(Cloud.planSync(hydrated, records), []);
});

test('结构化 fuel 在 state/record/ack 往返中 canonical，且仅元数据变化会 put', () => {
  const before = stateFixture();
  before.trips[0].expenses[0].amount = 300;
  before.trips[0].expenses[0].fuel = { unitPrice: '7.5000', liters: '40.000' };
  const baseline = Cloud.normalizeState(before, { 'trip_expense:t1:e1': 4 });
  const fuelRecord = baseline.find(item => item.id === 't1:e1');
  assert.deepEqual(fuelRecord.data.fuel, { unitPrice: '7.5', liters: '40' });
  assert.deepEqual(Cloud.hydrateState(baseline).trips[0].expenses[0].fuel, {
    unitPrice: '7.5',
    liters: '40'
  });

  const changed = clone(before);
  changed.trips[0].expenses[0].fuel = { unitPrice: '6.0000', liters: '50.000' };
  const operations = Cloud.planSync(changed, baseline);
  assert.deepEqual(operations.map(item => [item.op, item.type, item.id]), [
    ['put', 'trip_expense', 't1:e1']
  ]);
  assert.deepEqual(operations[0].data.fuel, { unitPrice: '6', liters: '50' });

  const acknowledged = Cloud.applySyncResults(baseline, operations, [{
    op: 'put',
    type: 'trip_expense',
    id: 't1:e1',
    status: 'applied',
    version: 5,
    data: Object.assign({}, operations[0].data, {
      fuel: { unitPrice: 6, liters: 50 }
    })
  }]);
  assert.deepEqual(
    acknowledged.find(item => item.id === 't1:e1').data.fuel,
    { unitPrice: '6', liters: '50' }
  );
  assert.deepEqual(Cloud.planSync(changed, acknowledged), []);
});

test('conflict、远端合并和成功回执都不会丢失 fuel', () => {
  const before = stateFixture();
  before.trips[0].expenses[0].amount = 300;
  before.trips[0].expenses[0].fuel = { unitPrice: '7.5', liters: '40' };
  const baseline = Cloud.normalizeState(before, { 'trip_expense:t1:e1': 2 });
  const changed = clone(before);
  changed.trips[0].expenses[0].fuel = { unitPrice: '6', liters: '50' };
  const conflictRemote = clone(baseline);
  conflictRemote.find(item => item.id === 't1:e1').version = 3;
  const inspection = Cloud.inspectPendingCache(
    { state: changed, baselineRecords: baseline },
    { records: conflictRemote }
  );
  assert.equal(inspection.status, 'conflict');
  assert.deepEqual(inspection.operations[0].data.fuel, { unitPrice: '6', liters: '50' });

  const remoteState = clone(before);
  remoteState.maintenance.push({
    id: 'remote-fuel-peer', vehicleId: 'v2', date: '2026-07-09', amount: 1, note: ''
  });
  const merged = Cloud.mergeRemoteState(
    changed,
    baseline,
    { records: Cloud.normalizeState(remoteState) }
  );
  assert.deepEqual(merged.trips[0].expenses[0].fuel, { unitPrice: '6', liters: '50' });
  assert.equal(merged.maintenance.some(item => item.id === 'remote-fuel-peer'), true);
});

test('fuel 守恒 fingerprint 对顺序稳定，并检测丢失与逐记录互换', () => {
  const before = stateFixture();
  before.trips[0].expenses = [
    { id: 'fuel-a', catId: 'fuel', amount: 300, date: '2026-07-01', note: '', fuel: { unitPrice: '7.5', liters: '40' } },
    { id: 'fuel-b', catId: 'fuel', amount: 300, date: '2026-07-02', note: '', fuel: { unitPrice: '6', liters: '50' } }
  ];
  const reordered = clone(before);
  reordered.trips[0].expenses.reverse();
  assert.equal(Cloud.compareSummaries(before, reordered).equal, true);

  const lost = clone(before);
  delete lost.trips[0].expenses[0].fuel;
  const lossComparison = Cloud.compareSummaries(before, lost);
  assert.equal(lossComparison.equal, false);
  assert.ok(lossComparison.differences.some(item => item.field === 'fuel.fingerprint'));

  const swapped = clone(before);
  const firstFuel = swapped.trips[0].expenses[0].fuel;
  swapped.trips[0].expenses[0].fuel = swapped.trips[0].expenses[1].fuel;
  swapped.trips[0].expenses[1].fuel = firstFuel;
  const swapComparison = Cloud.compareMigrationTarget(
    before,
    { records: Cloud.normalizeState(swapped) }
  );
  assert.equal(swapComparison.equal, false);
  assert.ok(swapComparison.differences.some(item => item.field === 'fuel.fingerprint'));

  const malformed = clone(before);
  delete malformed.trips[0].expenses[0].fuel.unitPrice;
  assert.throws(() => Cloud.normalizeState(malformed), /fuel 元数据必须完整/);

  const toleranceSwap = clone(before);
  toleranceSwap.trips[0].expenses[1].amount = 300.01;
  const swappedAmounts = clone(toleranceSwap);
  swappedAmounts.trips[0].expenses[0].amount = 300.01;
  swappedAmounts.trips[0].expenses[1].amount = 300;
  const toleranceComparison = Cloud.compareSummaries(toleranceSwap, swappedAmounts);
  assert.equal(toleranceComparison.equal, false);
  assert.ok(toleranceComparison.differences.some(item => item.field === 'fuel.fingerprint'));

  const reassigned = Cloud.normalizeState(before);
  reassigned.find(item => item.id === 't1:fuel-a').data.tripId = 't2';
  const ownershipComparison = Cloud.compareMigrationTarget(before, { records: reassigned });
  assert.equal(ownershipComparison.equal, false);
  assert.ok(ownershipComparison.differences.some(item => item.field === 'fuel.fingerprint'));
});

test('成功 put 回执必须保留 operation 数据，允许 canonical fuel 与等价金额类型', () => {
  const before = stateFixture();
  before.trips[0].expenses[0].amount = 300;
  before.trips[0].expenses[0].fuel = { unitPrice: '7.5', liters: '40' };
  const baseline = Cloud.normalizeState(before, { 'trip_expense:t1:e1': 4 });
  const changed = clone(before);
  changed.trips[0].expenses[0].fuel = { unitPrice: '6', liters: '50' };
  const operation = Cloud.planSync(changed, baseline)[0];
  const baselineSnapshot = clone(baseline);
  const resultFor = data => [{
    op: 'put',
    type: operation.type,
    id: operation.id,
    status: 'applied',
    version: 5,
    data
  }];

  const mutations = [
    data => { delete data.fuel; },
    data => { data.fuel = { unitPrice: '7.5', liters: '40' }; },
    data => { data.amount = 300.01; },
    data => { data.categoryId = 'other'; delete data.fuel; },
    data => { data.tripId = 't2'; }
  ];
  mutations.forEach(mutate => {
    const data = clone(operation.data);
    mutate(data);
    assert.throws(
      () => Cloud.applySyncResults(baseline, [operation], resultFor(data)),
      /云端回执|非油费科目/
    );
    assert.deepEqual(baseline, baselineSnapshot);
  });

  const compatibleOperation = clone(operation);
  compatibleOperation.data.amount = '300.00';
  compatibleOperation.data.fuel = { unitPrice: '6.0000', liters: '50.000' };
  const compatibleData = Object.assign({}, clone(operation.data), {
    amount: 300,
    fuel: { unitPrice: 6, liters: 50 }
  });
  const accepted = Cloud.applySyncResults(
    baseline,
    [compatibleOperation],
    resultFor(compatibleData)
  );
  assert.deepEqual(accepted.find(item => item.id === operation.id).data.fuel, {
    unitPrice: '6',
    liters: '50'
  });

  const incomeOperation = {
    op: 'put',
    type: 'trip_income',
    id: 't1:income-exponent',
    expectedVersion: 0,
    data: {
      id: 'income-exponent', tripId: 't1', categoryId: 'cargo',
      amount: '8e2', date: '2026-07-03', sortOrder: 2
    }
  };
  assert.doesNotThrow(() => Cloud.applySyncResults([], [incomeOperation], [{
    op: 'put', type: 'trip_income', id: 't1:income-exponent',
    status: 'applied', version: 1,
    data: Object.assign({}, incomeOperation.data, { amount: 800 })
  }]));
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
    [
      'amounts.maintenance',
      'amounts.tripIncomes',
      'counts.maintenance',
      'exactAmounts.maintenanceCents',
      'exactAmounts.tripIncomesCents'
    ]
  );

  const malformed = clone(before);
  malformed.trips[0].expenses[0].amount = '12abc';
  assert.throws(() => Cloud.summarizeState(malformed), /金额无效/);
  const exponent = clone(before);
  exponent.trips[0].expenses[0].amount = '8e2';
  assert.equal(Cloud.summarizeState(exponent).amounts.tripExpenses, 815);
});

test('JSON 导入账期缺失或非法时明确保留当前有效账期', () => {
  const current = stateFixture();
  const missing = Cloud.inspectImportPeriod(
    { schemaVersion: 2, settings: {} },
    current
  );
  assert.deepEqual(missing, {
    backupPeriodValid: false,
    preservedCurrentPeriod: true,
    periodStartDate: current.settings.periodStartDate,
    periodEndDate: current.settings.periodEndDate
  });
  assert.equal(
    Cloud.inspectImportPeriod({
      settings: {
        periodStartDate: '2026-02-30',
        periodEndDate: '2026-03-10'
      }
    }, current).backupPeriodValid,
    false
  );
  assert.equal(
    Cloud.inspectImportPeriod({
      settings: {
        periodStartDate: '2026-01-01',
        periodEndDate: '2027-01-02'
      }
    }, current).backupPeriodValid,
    false
  );
  assert.deepEqual(
    Cloud.inspectImportPeriod({
      settings: {
        periodStartDate: '2026-04-01',
        periodEndDate: '2027-03-31'
      }
    }, current),
    {
      backupPeriodValid: true,
      preservedCurrentPeriod: false,
      periodStartDate: '2026-04-01',
      periodEndDate: '2027-03-31'
    }
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

test('大型混合同步仍全局先删除依赖，再写入新记录', () => {
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

test('严格模式检测旧待上传缓存只给显式处理结论，绝不自动续传', () => {
  const before = stateFixture();
  const baseline = Cloud.normalizeState(before, Object.fromEntries(
    Cloud.normalizeState(before).map(item => [Cloud.recordKey(item.type, item.id), 1])
  ));
  assert.deepEqual(
    Cloud.strictPendingCacheDecision(
      { state: before, baselineRecords: baseline },
      { records: baseline }
    ),
    {
      status: 'discard',
      requiresExplicitAction: false,
      operations: [],
      conflicts: []
    }
  );

  const pending = clone(before);
  pending.vehicles[0].name = '待确认改名';
  const decision = Cloud.strictPendingCacheDecision(
    { state: pending, baselineRecords: baseline },
    { records: baseline }
  );
  assert.equal(decision.status, 'confirm-upload');
  assert.equal(decision.requiresExplicitAction, true);
  assert.deepEqual(
    decision.operations.map(item => Cloud.recordKey(item.type, item.id)),
    ['vehicle:v1']
  );
});

test('在线提交器失败不改正式状态，显式重试复用 operationId 后才提交', async () => {
  const before = stateFixture();
  const baseline = Cloud.normalizeState(before, Object.fromEntries(
    Cloud.normalizeState(before).map(item => [Cloud.recordKey(item.type, item.id), 1])
  ));
  const proposal = clone(before);
  proposal.vehicles[0].name = '服务器确认后的名字';
  const calls = [];
  let fail = true;
  const committer = Cloud.createOnlineCommitter({
    state: before,
    baselineRecords: baseline,
    randomUUID: () => '11111111-2222-3333-4444-555555555555',
    bootstrap: async () => ({ records: baseline }),
    requestSync: async body => {
      calls.push(clone(body));
      if (fail) throw new Error('服务器不可达');
      return {
        operationId: body.operationId,
        results: body.operations.map(operation => ({
          op: operation.op,
          type: operation.type,
          id: operation.id,
          status: 'applied',
          version: operation.expectedVersion + 1,
          data: operation.data
        })),
        hasConflicts: false,
        hasRejected: false
      };
    }
  });

  const failed = await committer.commit(proposal);
  assert.equal(failed.ok, false);
  assert.equal(committer.status.phase, 'readonly');
  assert.equal(committer.state.vehicles[0].name, before.vehicles[0].name);
  assert.equal(calls[0].operationId, 'write-11111111-2222-3333-4444-555555555555');
  assert.equal(failed.retryToken.operationId, calls[0].operationId);

  fail = false;
  const saved = await committer.retry(failed.retryToken);
  assert.equal(saved.ok, true);
  assert.equal(committer.status.phase, 'online');
  assert.equal(committer.state.vehicles[0].name, '服务器确认后的名字');
  assert.equal(calls[1].operationId, calls[0].operationId);
  assert.deepEqual(calls[1].operations, calls[0].operations);
});

test('navigator 恢复在线不会解除只读，必须真实 bootstrap 成功', async () => {
  const before = stateFixture();
  const baseline = Cloud.normalizeState(before);
  let bootstraps = 0;
  const committer = Cloud.createOnlineCommitter({
    state: before,
    baselineRecords: baseline,
    online: false,
    requestSync: async () => {
      throw new Error('不应写入');
    },
    bootstrap: async () => {
      bootstraps++;
      return { records: baseline };
    }
  });
  assert.equal(committer.noteNavigatorOnline().writable, false);
  const blocked = await committer.commit(clone(before));
  assert.equal(blocked.readonly, true);
  assert.equal(bootstraps, 0);

  const recovered = await committer.recover();
  assert.equal(recovered.ok, true);
  assert.equal(bootstraps, 1);
  assert.equal(committer.status.writable, true);
});

test('theme 是设备偏好，单独切换不会生成业务云写入', async () => {
  const before = stateFixture();
  const baseline = Cloud.normalizeState(before, Object.fromEntries(
    Cloud.normalizeState(before).map(item => [Cloud.recordKey(item.type, item.id), 1])
  ));
  const proposal = clone(before);
  proposal.settings.theme = before.settings.theme === 'night' ? 'day' : 'night';
  let requests = 0;
  const committer = Cloud.createOnlineCommitter({
    state: before,
    baselineRecords: baseline,
    requestSync: async () => {
      requests++;
      throw new Error('不应上传 theme');
    },
    bootstrap: async () => ({ records: baseline })
  });
  const result = await committer.commit(proposal);
  assert.equal(result.ok, true);
  assert.equal(result.unchanged, true);
  assert.equal(requests, 0);
  assert.equal(committer.state.settings.theme, proposal.settings.theme);
});
