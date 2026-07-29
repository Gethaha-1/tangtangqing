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
      periodEndDate: '2027-03-14'
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
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.vehicles.length, 1);
  assert.equal(migrated.trips[0].vehicleId, migrated.vehicles[0].id);
  assert.equal(migrated.maintenance[0].vehicleId, migrated.vehicles[0].id);
  assert.equal(migrated.trips[0].expenses[0].amount, 800);
  assert.equal(migrated.maintenance[0].amount, 300);
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
    count: 2, inc: 4200, exp: 1200, profit: 3000, maint: 700
  });
  assert.deepEqual(D.periodStats(state, '2026-03-15', '2027-03-14', 'v1'), {
    count: 1, inc: 3000, exp: 1000, profit: 2000, maint: 500
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
