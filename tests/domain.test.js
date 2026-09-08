import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/domain.js';

const D = globalThis.TTQDomain;

function baseData() {
  return {
    schemaVersion: 2,
    settings: {
      theme: 'day',
      lastReportSeen: '',
      lastBackupAt: '',
      activeVehicleId: 'all',
      periodStartDate: '2026-03-15',
      periodEndDate: '2027-03-14',
      business: { shippers: [], shipperGroups: [], places: [] }
    },
    categories: { expense: [], income: [] },
    vehicles: [D.legacyVehicle()],
    trips: [],
    maintenance: []
  };
}

function trip(id, vehicleId, startDate, endDate, income, expense) {
  return {
    id,
    vehicleId,
    startDate,
    endDate,
    status: endDate ? 'closed' : 'open',
    createdAt: id,
    expenses: expense ? [{ id: 'e_' + id, catId: 'fuel', amount: expense, date: endDate || startDate, note: '' }] : [],
    incomes: income ? [{ id: 'i_' + id, catId: 'cargo', amount: income, date: endDate || startDate }] : []
  };
}

test('v1 数据迁移后保留账目并自动归入原有车辆', () => {
  const legacy = {
    schemaVersion: 1,
    settings: { theme: 'night' },
    categories: { expense: [], income: [] },
    trips: [trip('a', undefined, '2026-07-01', '2026-07-03', '2000', '800')],
    maintenance: [{ id: 'm1', date: '2026-07-04', amount: '300', note: '补胎' }]
  };
  const migrated = D.migrate(legacy, baseData());
  assert.equal(migrated.schemaVersion, 4);
  assert.equal(migrated.vehicles.length, 1);
  assert.equal(migrated.trips[0].vehicleId, migrated.vehicles[0].id);
  assert.equal(migrated.maintenance[0].vehicleId, migrated.vehicles[0].id);
  assert.equal(migrated.trips[0].expenses[0].amount, 800);
  assert.equal(migrated.maintenance[0].amount, 300);
});

test('v2→v4 不回填旧油费，合法 fuel canonical 化且非法元数据拒绝', () => {
  const legacy = baseData();
  legacy.schemaVersion = 2;
  legacy.trips = [trip('legacy', D.LEGACY_VEHICLE_ID, '2026-07-01', '2026-07-02', 0, 300)];
  const migratedLegacy = D.migrate(legacy, baseData());
  assert.equal(migratedLegacy.schemaVersion, 4);
  assert.equal(Object.prototype.hasOwnProperty.call(migratedLegacy.trips[0].expenses[0], 'fuel'), false);

  const structured = baseData();
  structured.schemaVersion = 2;
  structured.trips = [trip('structured', D.LEGACY_VEHICLE_ID, '2026-07-01', '2026-07-02', 0, 300)];
  structured.trips[0].expenses[0].fuel = { unitPrice: '7.5000', liters: '40.000' };
  assert.deepEqual(D.migrate(structured, baseData()).trips[0].expenses[0].fuel, {
    unitPrice: '7.5',
    liters: '40'
  });

  const invalid = structured;
  invalid.trips[0].expenses[0].fuel = { unitPrice: '7.5', liters: '39' };
  assert.throws(() => D.migrate(invalid, baseData()), /无效 fuel 元数据/);
});

test('v1/v2/v3 升 v4 都补齐空业务资料，不改旧账金额', () => {
  for (const version of [1, 2, 3]) {
    const legacy = baseData();
    legacy.schemaVersion = version;
    delete legacy.settings.business;
    legacy.trips = [trip('legacy-' + version, D.LEGACY_VEHICLE_ID, '2026-07-01', '2026-07-02', 2400, 800)];
    const migrated = D.migrate(legacy, baseData());
    assert.equal(migrated.schemaVersion, 4);
    assert.deepEqual(migrated.settings.business, { shippers: [], shipperGroups: [], places: [] });
    assert.deepEqual(migrated.trips[0].business, {});
    assert.equal(D.tripTotals(migrated.trips[0]).profit, 1600);
  }
});

test('去程整车运费按箱位定点分摊，分尾差稳定且抹零单独扣减', () => {
  const exact = D.allocateOutboundFreight('6000', [
    { id: 'a', boxSlots: '1', roundingAmount: '0' },
    { id: 'b', boxSlots: '2', roundingAmount: '5.50' },
    { id: 'c', boxSlots: '3', roundingAmount: '0' },
  ]);
  assert.equal(exact.ok, true);
  assert.deepEqual(exact.allocations.map(item => [item.allocatedAmount, item.roundingAmount, item.finalAmount]), [
    [1000, 0, 1000], [2000, 5.5, 1994.5], [3000, 0, 3000],
  ]);
  assert.equal(exact.allocatedTotal, 6000);
  assert.equal(exact.roundingTotal, 5.5);
  assert.equal(exact.finalTotal, 5994.5);

  const tail = D.allocateOutboundFreight('100', [
    { id: 'first', boxSlots: '1' }, { id: 'second', boxSlots: '1' }, { id: 'third', boxSlots: '1' },
  ]);
  assert.deepEqual(tail.allocations.map(item => item.allocatedAmount), [33.34, 33.33, 33.33]);
  assert.throws(() => D.normalizeTripBusiness({ outbound: { totalFreight: 10, allocations: [
    { id: 'same', shipperId: 's1', shipperName: 'A', marketId: 'm1', marketName: 'M', boxSlots: 1 },
    { id: 'same', shipperId: 's2', shipperName: 'B', marketId: 'm2', marketName: 'N', boxSlots: 1 },
  ] } }), /标识重复/);
});

test('货主与市场复合引用不会被标识中的分隔符混淆', () => {
  const normalized = D.normalizeBusinessSettings({
    shippers: [
      { id: 'a:b', name: '甲', markets: [{ id: 'c', name: '一号市场' }] },
      { id: 'a', name: '乙', markets: [{ id: 'b:c', name: '二号市场' }] },
    ],
    shipperGroups: [{
      id: 'g|1', name: '同车组', mainRef: { shipperId: 'a:b', marketId: 'c' },
      members: [{ shipperId: 'a:b', marketId: 'c' }, { shipperId: 'a', marketId: 'b:c' }],
    }],
    places: [],
  });
  assert.equal(normalized.shipperGroups[0].members.length, 2);
});

test('返程应收为吨位乘单价，实收 null 回退应收而数字 0 明确覆盖', () => {
  const receivable = D.calculateReturnFreight({ loadedTons: '30.000', unitPrice: '240', actualReceivedAmount: '' });
  assert.equal(receivable.ok, true);
  assert.equal(receivable.receivableAmount, 7200);
  assert.equal(receivable.effectiveAmount, 7200);
  assert.equal(receivable.actualReceivedAmount, null);

  const zero = D.calculateReturnFreight({ loadedTons: '30', unitPrice: '240.00', actualReceivedAmount: '0' });
  assert.equal(zero.ok, true);
  assert.equal(zero.actualReceivedAmount, 0);
  assert.equal(zero.effectiveAmount, 0);
  assert.equal(D.calculateReturnFreight({ loadedTons: '30', unitPrice: '241', actualReceivedAmount: '' }).effectiveAmount, 7230);
  assert.equal(D.calculateReturnFreight({ loadedTons: '30', unitPrice: '240.001' }).ok, false);
});

test('称重只推导掉称参考，增重必须人工确认才能归一化', () => {
  assert.deepEqual(D.calculateWeightLoss({ loadedTons: '30', unloadedTons: '29.950' }), {
    ok: true, referenceLossKg: '50', confirmedLossKg: '50', usedReference: true,
  });
  const gain = { cargoType: 'corn', loadedTons: '30', unitPrice: '240', unloadedTons: '30.001', pickupLocation: {}, deliveryLocation: {} };
  assert.throws(() => D.normalizeTripBusiness({ returnTrip: gain }), /需先人工确认/);
  assert.equal(D.normalizeTripBusiness({ returnTrip: { ...gain, weightGainConfirmed: true } }).returnTrip.weightGainConfirmed, true);
});

test('结构化去返程是收入唯一口径，不与兼容收入重复累加', () => {
  const item = trip('business-income', D.LEGACY_VEHICLE_ID, '2026-07-01', '2026-07-02', 9999, 1000);
  item.incomes.push({ id: 'back-old', catId: 'back', amount: 8888, date: '2026-07-02' });
  item.business = {
    outbound: { finalTotal: 6000 },
    returnTrip: { effectiveAmount: 0 },
  };
  assert.deepEqual(D.tripTotals(item), { inc: 6000, exp: 1000, profit: 5000 });
});

test('迁移严格拒绝非法金额，普通旧金额保留指数与逐条四舍五入兼容', () => {
  const compatible = baseData();
  compatible.schemaVersion = 2;
  compatible.trips = [{
    id: 'amounts',
    vehicleId: D.LEGACY_VEHICLE_ID,
    startDate: '2026-07-01',
    endDate: '2026-07-02',
    status: 'closed',
    expenses: [{ id: 'e1', catId: 'road', amount: '1.005', date: '2026-07-01' }],
    incomes: [{ id: 'i1', catId: 'cargo', amount: '.8e3', date: '2026-07-02' }]
  }];
  compatible.maintenance = [{
    id: 'm1', vehicleId: D.LEGACY_VEHICLE_ID, date: '2026-07-03', amount: 300.109
  }];
  const migrated = D.migrate(compatible, baseData());
  assert.equal(migrated.trips[0].expenses[0].amount, 1.01);
  assert.equal(migrated.trips[0].incomes[0].amount, 800);
  assert.equal(migrated.maintenance[0].amount, 300.11);

  for (const [target, value] of [
    ['expense', 'not-a-number'],
    ['income', Number.POSITIVE_INFINITY],
    ['maintenance', '-0.01'],
    ['expense', '1000000000']
  ]) {
    const invalid = structuredClone(compatible);
    if (target === 'expense') invalid.trips[0].expenses[0].amount = value;
    if (target === 'income') invalid.trips[0].incomes[0].amount = value;
    if (target === 'maintenance') invalid.maintenance[0].amount = value;
    assert.throws(() => D.migrate(invalid, baseData()), /金额.*无效|金额.*超出/);
  }
});

test('结构化 fuel 使用迁移前原始总价，拒绝超精度或指数金额', () => {
  for (const amount of ['300.001', '3e2']) {
    const state = baseData();
    state.schemaVersion = 2;
    state.trips = [{
      id: 'strict-fuel',
      vehicleId: D.LEGACY_VEHICLE_ID,
      startDate: '2026-07-01',
      endDate: '2026-07-02',
      status: 'closed',
      expenses: [{
        id: 'e1', catId: 'fuel', amount, date: '2026-07-01',
        fuel: { unitPrice: '7.5', liters: '40' }
      }],
      incomes: []
    }];
    assert.throws(() => D.migrate(state, baseData()), /无效 fuel 元数据/);
  }
});

test('司机裁剪视图不补本地车辆、不保留不可见 activeVehicleId', () => {
  const zeroAssignment = baseData();
  zeroAssignment.settings._ownerRecordsWritable = false;
  zeroAssignment.settings.activeVehicleId = 'hidden-owner-vehicle';
  zeroAssignment.vehicles = [];
  const empty = D.migrate(zeroAssignment, baseData());
  assert.deepEqual(empty.vehicles, []);
  assert.equal(empty.settings.activeVehicleId, 'all');
  assert.equal(empty.settings._ownerRecordsWritable, false);

  const partial = baseData();
  partial.settings._ownerRecordsWritable = false;
  partial.settings.activeVehicleId = 'hidden-owner-vehicle';
  partial.vehicles = [{
    id: 'visible', name: '分配车辆', plateNo: '', active: true, createdAt: '1'
  }];
  partial.trips = [trip('visible-trip', 'visible', '2026-07-01', '2026-07-02', 100, 20)];
  const migrated = D.migrate(partial, baseData());
  assert.deepEqual(migrated.vehicles.map(item => item.id), ['visible']);
  assert.equal(migrated.trips[0].vehicleId, 'visible');
  assert.equal(migrated.settings.activeVehicleId, 'all');

  const invisible = structuredClone(partial);
  invisible.trips[0].vehicleId = 'hidden-owner-vehicle';
  assert.throws(() => D.migrate(invisible, baseData()), /不可见车辆/);
});

test('补录旧账按到家日期插入当前车辆趟号', () => {
  const state = baseData();
  state.vehicles = [
    { id: 'v1', name: '一号车', plateNo: '', active: true, createdAt: '1' },
    { id: 'v2', name: '二号车', plateNo: '', active: true, createdAt: '2' }
  ];
  state.trips = [
    trip('later', 'v1', '2026-04-08', '2026-04-10', 2000, 500),
    trip('old', 'v1', '2026-03-20', '2026-03-22', 1000, 200),
    trip('other-car', 'v2', '2026-03-18', '2026-03-21', 900, 100)
  ];
  assert.equal(D.tripSeq(state, state.trips[1], '2026-03-15', '2027-03-14'), 1);
  assert.equal(D.tripSeq(state, state.trips[0], '2026-03-15', '2027-03-14'), 2);
  assert.equal(D.tripSeq(state, state.trips[2], '2026-03-15', '2027-03-14'), 1);
  assert.deepEqual(
    state.trips.slice().sort(D.compareTripsDesc).map(item => item.id),
    ['later', 'old', 'other-car']
  );
});

test('同日收车后再次发车时，在途趟自动排到已收车趟之后', () => {
  const state = baseData();
  state.vehicles = [
    { id: 'v1', name: '一号车', plateNo: '', active: true, createdAt: '1' }
  ];
  const arrived = trip('arrived', 'v1', '2026-08-20', '2026-08-23', 2000, 500);
  arrived.createdAt = '2026-08-20T08:00:00.000Z';
  arrived.closedAt = '2026-08-23T09:00:00.000Z';
  const departed = trip('departed', 'v1', '2026-08-23', null, 0, 100);
  departed.createdAt = '2026-08-23T10:00:00.000Z';
  departed.closedAt = '';
  state.trips = [departed, arrived];

  assert.equal(D.tripSeq(state, arrived, '2025-10-01', '2026-09-30'), 1);
  assert.equal(D.tripSeq(state, departed, '2025-10-01', '2026-09-30'), 2);
  assert.deepEqual(
    state.trips.slice().sort(D.compareTripsDesc).map(item => item.id),
    ['departed', 'arrived']
  );
});

test('账期和车辆筛选共同控制统计范围', () => {
  const state = baseData();
  state.vehicles = [
    { id: 'v1', name: '一号车', plateNo: '', active: true, createdAt: '1' },
    { id: 'v2', name: '二号车', plateNo: '', active: true, createdAt: '2' }
  ];
  state.trips = [
    trip('cross-year', 'v1', '2026-03-10', '2026-03-16', 3000, 1000),
    trip('v2', 'v2', '2026-04-01', '2026-04-02', 1200, 200),
    trip('outside', 'v1', '2027-03-15', '2027-03-16', 9999, 0)
  ];
  state.maintenance = [
    { id: 'm1', vehicleId: 'v1', date: '2026-05-01', amount: 500, note: '' },
    { id: 'm2', vehicleId: 'v2', date: '2026-05-02', amount: 200, note: '' }
  ];
  assert.deepEqual(D.periodStats(state, '2026-03-15', '2027-03-14', 'all'), {
    count: 2,
    inc: 4200,
    exp: 1200,
    profit: 3000,
    maint: 700,
    tripProfit: 3000,
    maintenance: 700,
    netProfit: 2300
  });
  assert.deepEqual(D.periodStats(state, '2026-03-15', '2027-03-14', 'v1'), {
    count: 1,
    inc: 3000,
    exp: 1000,
    profit: 2000,
    maint: 500,
    tripProfit: 2000,
    maintenance: 500,
    netProfit: 1500
  });
});

test('自定义账期最多覆盖连续月份并按到家月统计', () => {
  const state = baseData();
  state.trips = [
    trip('march', D.LEGACY_VEHICLE_ID, '2026-03-14', '2026-03-15', 500, 100),
    trip('next-march', D.LEGACY_VEHICLE_ID, '2027-03-01', '2027-03-14', 800, 200)
  ];
  const result = D.monthProfits(state, '2026-03-15', '2027-03-14', 'all');
  assert.equal(result.keys.length, 13);
  assert.equal(result.values[0], 400);
  assert.equal(result.values[12], 600);
});

test('日期校验拒绝伪日期和超出支持范围的年份', () => {
  assert.equal(D.isDateString('2024-02-29'), true);
  assert.equal(D.isDateString('2026-02-29'), false);
  assert.equal(D.isDateString('2026-02-31'), false);
  assert.equal(D.isDateString('2026-00-01'), false);
  assert.equal(D.isDateString('0000-01-01'), false);
  assert.equal(D.isDateString('0999-12-31'), false);
  assert.equal(D.isDateString('1000-01-01'), true);
  assert.equal(D.periodDays('2026-02-31', '2026-03-01'), 0);
});

test('油费任意两项使用定点数联算并返回约定精度', () => {
  assert.deepEqual(D.calculateFuelFields({ unitPrice: '7.5000', liters: '40' }), {
    ok: true,
    totalAmount: '300',
    unitPrice: '7.5',
    liters: '40',
    formatted: { totalAmount: '300.00', unitPrice: '7.5000', liters: '40.000' },
    calculatedField: 'totalAmount',
    differenceCents: '0',
    toleranceCents: '1'
  });
  assert.deepEqual(D.calculateFuelFields({ totalAmount: '300', unitPrice: '7.5' }), {
    ok: true,
    totalAmount: '300',
    unitPrice: '7.5',
    liters: '40',
    formatted: { totalAmount: '300.00', unitPrice: '7.5000', liters: '40.000' },
    calculatedField: 'liters',
    differenceCents: '0',
    toleranceCents: '1'
  });
  assert.deepEqual(D.calculateFuelFields({ totalAmount: '300.00', liters: '40.000' }), {
    ok: true,
    totalAmount: '300',
    unitPrice: '7.5',
    liters: '40',
    formatted: { totalAmount: '300.00', unitPrice: '7.5000', liters: '40.000' },
    calculatedField: 'unitPrice',
    differenceCents: '0',
    toleranceCents: '1'
  });

  const driftProof = D.calculateFuelFields({ unitPrice: '0.1', liters: '0.2' });
  assert.equal(driftProof.ok, true);
  assert.equal(driftProof.totalAmount, '0.02');
  assert.equal(driftProof.unitPrice, '0.1');
  assert.equal(driftProof.liters, '0.2');

  const maximum = D.calculateFuelFields({ unitPrice: '999.9999', liters: '100000' });
  assert.equal(maximum.ok, true);
  assert.equal(maximum.totalAmount, '99999990');
  assert.equal(
    D.calculateFuelFields({ unitPrice: '1000', liters: '1' }).error.code,
    'out-of-range'
  );
  assert.equal(D.calculateFuelFields({ unitPrice: '1', liters: '100000.001' }).error.code, 'out-of-range');
});

test('油费三项冲突容差为一分并拒绝零数、负数和不完整输入', () => {
  assert.equal(D.calculateFuelFields({ totalAmount: '300.01', unitPrice: '7.5', liters: '40' }).ok, true);

  const conflict = D.calculateFuelFields({ totalAmount: '300.02', unitPrice: '7.5', liters: '40' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, 'inconsistent');
  assert.equal(conflict.error.differenceCents, '2');

  assert.equal(D.calculateFuelFields({ totalAmount: '0', liters: '40' }).error.code, 'must-be-positive');
  assert.equal(D.calculateFuelFields({ totalAmount: '-1', liters: '40' }).error.code, 'must-be-positive');
  assert.equal(D.calculateFuelFields({ totalAmount: '300' }).error.code, 'need-two-fields');
  assert.equal(D.calculateFuelFields({ totalAmount: '300', liters: 'abc' }).error.code, 'invalid-number');
  assert.equal(D.calculateFuelFields({ totalAmount: '300.001', liters: '40' }).error.code, 'too-many-decimals');
  assert.equal(D.calculateFuelFields({ totalAmount: '300', unitPrice: '7.50000' }).error.code, 'too-many-decimals');
  assert.equal(D.calculateFuelFields({ totalAmount: '300', liters: '40.0001' }).error.code, 'too-many-decimals');
  assert.equal(D.calculateFuelFields({ totalAmount: '3e2', liters: '40' }).error.code, 'exponent-not-allowed');
  assert.equal(D.calculateFuelFields({ totalAmount: 1e-7, liters: '40' }).error.code, 'exponent-not-allowed');
  assert.equal(D.calculateFuelFields({ totalAmount: '1000000000', liters: '1' }).error.code, 'out-of-range');
  assert.equal(D.calculateFuelFields({ totalAmount: '1', liters: '100000.001' }).error.code, 'out-of-range');
  assert.equal(D.calculateFuelFields({ totalAmount: '1000', liters: '1' }).error.field, 'unitPrice');
  assert.equal(D.calculateFuelFields({ totalAmount: '100000.01', unitPrice: '1' }).error.field, 'liters');
});

test('油费一致性固定一分容差且拒绝无法精确回算的两项组合', () => {
  assert.equal(D.fuelConsistencyToleranceCents('7.5', '40'), 1);
  assert.equal(D.fuelConsistencyToleranceCents('0.0002', '100000'), 1);
  assert.equal(D.fuelConsistencyToleranceCents('invalid', '40'), null);
  assert.equal(D.fuelConsistencyToleranceCents('7.5', '100000.001'), null);
  assert.equal(D.fuelConsistencyToleranceCents('7.50000', '40'), null);
  assert.equal(D.fuelConsistencyToleranceCents('7.5e0', '40'), null);

  const volumeQuantized = D.calculateFuelFields({ totalAmount: '15', liters: '100000' });
  assert.equal(volumeQuantized.ok, false);
  assert.equal(volumeQuantized.error.code, 'precision-loss');
  assert.equal(volumeQuantized.error.differenceCents, '500');
  assert.equal(volumeQuantized.error.toleranceCents, '1');

  const explicitQuantizationConflict = D.calculateFuelFields({
    totalAmount: '15', unitPrice: '0.0002', liters: '100000'
  });
  assert.equal(explicitQuantizationConflict.ok, false);
  assert.equal(explicitQuantizationConflict.error.code, 'inconsistent');

  const reviewCounterexample = D.calculateFuelFields({
    totalAmount: '749995', unitPrice: '7.5', liters: '100000'
  });
  assert.equal(reviewCounterexample.ok, false);
  assert.equal(reviewCounterexample.error.code, 'inconsistent');
  assert.equal(reviewCounterexample.error.differenceCents, '500');
});

test('迁移兼容没有 fuel 元数据的旧油费并保留已有结构化元数据', () => {
  const state = baseData();
  const oldTrip = trip('legacy-fuel', D.LEGACY_VEHICLE_ID, '2026-04-01', '2026-04-02', 1000, 300);
  const structuredTrip = trip('structured-fuel', D.LEGACY_VEHICLE_ID, '2026-04-03', '2026-04-04', 1000, 375);
  structuredTrip.expenses[0].fuel = { unitPrice: '7.5000', liters: '50.000' };
  state.trips = [oldTrip, structuredTrip];

  const migrated = D.migrate(state, baseData());
  assert.equal('fuel' in migrated.trips[0].expenses[0], false);
  assert.deepEqual(migrated.trips[1].expenses[0].fuel, { unitPrice: '7.5', liters: '50' });
});

test('报告摘要统一净利润与油费范围并明确旧数据覆盖缺口', () => {
  const state = baseData();
  state.vehicles = [
    { id: 'v1', name: '一号车', plateNo: '', active: true, createdAt: '1' },
    { id: 'v2', name: '二号车', plateNo: '', active: true, createdAt: '2' },
    { id: 'v3', name: '三号车', plateNo: '', active: true, createdAt: '3' }
  ];
  const aprilV1 = trip('april-v1', 'v1', '2026-03-28', '2026-04-02', 2000, 750);
  aprilV1.expenses[0].date = '2026-03-30';
  aprilV1.expenses[0].fuel = { unitPrice: '7.5000', liters: '100.000' };
  aprilV1.expenses.push({ id: 'road', catId: 'road', amount: 50, date: '2026-04-01', note: '' });
  const aprilV2 = trip('april-v2', 'v2', '2026-04-03', '2026-04-04', 1000, 200);
  const mayV1 = trip('may-v1', 'v1', '2026-05-01', '2026-05-02', 0, 400);
  mayV1.expenses[0].fuel = { unitPrice: '8.0000', liters: '50.000' };
  const outside = trip('outside', 'v1', '2026-06-01', '2026-06-02', 9999, 999);
  outside.expenses[0].fuel = { unitPrice: '9.9900', liters: '100.000' };
  const januaryV2 = trip('january-v2', 'v2', '2026-01-08', '2026-01-10', 500, 50);
  state.trips = [aprilV1, aprilV2, mayV1, outside, januaryV2];
  state.maintenance = [
    { id: 'm1', vehicleId: 'v1', date: '2026-04-15', amount: 100, note: '' },
    { id: 'm2', vehicleId: 'v2', date: '2026-06-15', amount: 999, note: '' }
  ];

  const summary = D.buildReportSummary(state, {
    start: '2026-04-01',
    end: '2026-05-31',
    vehicleId: 'all'
  });
  assert.deepEqual(summary.financial, {
    tripCount: 3,
    incomeCents: 300000,
    tripExpenseCents: 140000,
    tripProfitCents: 160000,
    maintenanceCents: 10000,
    netProfitCents: 150000,
    display: {
      income: 3000,
      tripExpenses: 1400,
      tripProfit: 1600,
      maintenance: 100,
      netProfit: 1500
    }
  });
  assert.equal(summary.fuel.totalCostCents, 135000);
  assert.equal(summary.fuel.structuredCostCents, 115000);
  assert.equal(summary.fuel.volumeMl, 150000);
  assert.equal(summary.fuel.weightedUnitPriceX10000, 76667);
  assert.equal(summary.fuel.minUnitPriceX10000, 75000);
  assert.equal(summary.fuel.maxUnitPriceX10000, 80000);
  assert.equal(summary.fuel.coverage.totalRecords, 3);
  assert.equal(summary.fuel.coverage.structuredRecords, 2);
  assert.equal(summary.fuel.coverage.legacyRecords, 1);
  assert.equal(summary.fuel.legacyCostCents, 20000);
  assert.equal(summary.fuel.coverage.legacyCostCents, 20000);
  assert.match(summary.fuel.legacyCoverageWarning, /1 条油费/);
  assert.deepEqual(summary.warnings.map(item => item.code), ['fuel-coverage-incomplete']);
  // Fuel is already part of trip expenses, while maintenance reduces net profit exactly once.
  assert.equal(summary.financial.tripExpenseCents, summary.fuel.totalCostCents + 5000);
  assert.equal(
    summary.financial.tripProfitCents,
    summary.financial.incomeCents - summary.financial.tripExpenseCents
  );
  assert.equal(
    summary.financial.netProfitCents,
    summary.financial.tripProfitCents - summary.financial.maintenanceCents
  );
  assert.deepEqual(summary.fuel.trend.map(item => ({
    period: item.period,
    totalCostCents: item.totalCostCents,
    volumeMl: item.volumeMl
  })), [
    { period: '2026-04', totalCostCents: 95000, volumeMl: 100000 },
    { period: '2026-05', totalCostCents: 40000, volumeMl: 50000 }
  ]);
  assert.deepEqual(summary.fuel.byVehicle.map(item => ({
    vehicleId: item.vehicleId,
    totalCostCents: item.totalCostCents,
    volumeMl: item.volumeMl,
    legacyRecords: item.coverage.legacyRecords
  })), [
    { vehicleId: 'v1', totalCostCents: 115000, volumeMl: 150000, legacyRecords: 0 },
    { vehicleId: 'v2', totalCostCents: 20000, volumeMl: 0, legacyRecords: 1 },
    { vehicleId: 'v3', totalCostCents: 0, volumeMl: 0, legacyRecords: 0 }
  ]);

  const v1April = D.buildReportSummary(state, { month: '2026-04', vehicleId: 'v1' });
  assert.equal(v1April.scope.kind, 'month');
  assert.equal(v1April.scope.start, '2026-04-01');
  assert.equal(v1April.scope.end, '2026-04-30');
  assert.deepEqual(v1April.scope.vehicle, { kind: 'single', vehicleId: 'v1' });
  assert.equal(v1April.scope.tripBasis, 'closed.endDate');
  assert.equal(v1April.scope.maintenanceBasis, 'maintenance.date');
  assert.equal(v1April.scope.fuelBasis, 'parentClosedTrip.endDate');
  assert.equal(v1April.fuel.totalCostCents, 75000);
  assert.equal(v1April.financial.netProfitCents, 110000);
  assert.deepEqual(v1April.fuel.byVehicle.map(item => item.vehicleId), ['v1']);

  const partialMarch = D.buildReportSummary(state, { month: '2026-03', vehicleId: 'all' });
  assert.equal(partialMarch.scope.start, '2026-03-15');
  assert.equal(partialMarch.scope.end, '2026-03-31');
  assert.equal(partialMarch.scope.empty, false);

  const v2Year = D.buildReportSummary(state, { year: 2026, vehicleId: 'v2' });
  assert.equal(v2Year.scope.kind, 'year');
  assert.equal(v2Year.scope.start, '2026-01-01');
  assert.equal(v2Year.scope.end, '2026-12-31');
  assert.equal(v2Year.scope.vehicleId, 'v2');
  assert.equal(v2Year.financial.tripCount, 2);
  assert.equal(v2Year.financial.incomeCents, 150000);
  assert.equal(v2Year.financial.tripExpenseCents, 25000);

  const outsideMonth = D.buildReportSummary(state, { month: '2026-02', vehicleId: 'all' });
  assert.equal(outsideMonth.scope.empty, true);
  assert.equal(outsideMonth.financial.tripCount, 0);
  assert.equal(outsideMonth.financial.incomeCents, 0);
  assert.equal(outsideMonth.financial.netProfitCents, 0);
  assert.equal(outsideMonth.fuel.totalCostCents, 0);
  assert.equal(outsideMonth.fuel.volumeMl, 0);

  for (const vehicleId of ['', 'unknown']) {
    const emptyVehicle = D.buildReportSummary(state, {
      start: '2026-04-01', end: '2026-05-31', vehicleId
    });
    assert.equal(emptyVehicle.financial.tripCount, 0);
    assert.equal(emptyVehicle.financial.incomeCents, 0);
    assert.deepEqual(emptyVehicle.fuel.byVehicle.map(item => item.vehicleId), [vehicleId]);
  }

  assert.throws(() => D.buildReportSummary(state, { month: '2026-13' }), /YYYY-MM/);
  assert.throws(() => D.buildReportSummary(state, { month: '0000-01' }), /1000-9999/);
  assert.throws(() => D.buildReportSummary(state, { year: '0000' }), /1000-9999/);
});

test('单条结构化油费的加权均价始终位于记录油价极值内', () => {
  const state = baseData();
  const one = trip('one-fuel', D.LEGACY_VEHICLE_ID, '2026-04-01', '2026-04-02', 0, 0.02);
  one.expenses[0].fuel = { unitPrice: '0.05', liters: '0.2' };
  state.trips = [one];

  const fuel = D.buildReportSummary(state, {
    start: '2026-04-01', end: '2026-04-30', vehicleId: 'all'
  }).fuel;
  assert.equal(fuel.weightedUnitPriceX10000, 1000);
  assert.equal(fuel.minUnitPriceX10000, 1000);
  assert.equal(fuel.maxUnitPriceX10000, 1000);
  assert.ok(fuel.weightedUnitPriceX10000 <= fuel.maxUnitPriceX10000);
  assert.ok(fuel.weightedUnitPriceX10000 >= fuel.minUnitPriceX10000);
});
