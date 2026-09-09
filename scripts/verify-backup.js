import fs from 'node:fs';
import assert from 'node:assert/strict';
import '../src/domain.js';
import '../src/cloud-sync.js';

const D = globalThis.TTQDomain;
const Cloud = globalThis.TTQCloudSync;

const backupPath = process.argv[2];
if (!backupPath) {
  console.error('用法：node scripts/verify-backup.js <备份文件.json>');
  process.exit(2);
}

const original = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
const period = D.defaultPeriod();
const base = {
  schemaVersion: D.SCHEMA_VERSION,
  settings: {
    theme: 'day',
    lastReportSeen: '',
    lastBackupAt: '',
    activeVehicleId: 'all',
    periodStartDate: period.start,
    periodEndDate: period.end,
    business: {
      shippers: [], shipperGroups: [], places: [],
      cargoCatalogs: structuredClone(D.DEFAULT_CARGO_CATALOGS)
    }
  },
  categories: { expense: [], income: [] },
  vehicles: [D.legacyVehicle()],
  trips: [],
  maintenance: []
};
const migrated = D.migrate(original, base);
const originalFuel = Cloud.summarizeState(original).fuel;
const migratedFuel = Cloud.summarizeState(migrated).fuel;
const originalBusiness = Cloud.summarizeState(original).business;
const migratedBusiness = Cloud.summarizeState(migrated).business;

function sumEntries(trips, field) {
  return trips.reduce((sum, trip) =>
    sum + (trip[field] || []).reduce((inner, entry) => inner + D.cleanAmount(entry.amount), 0), 0);
}
function sumMaintenance(items) {
  return items.reduce((sum, item) => sum + D.cleanAmount(item.amount), 0);
}

assert.equal(migrated.schemaVersion, D.SCHEMA_VERSION);
assert.equal(migrated.trips.length, original.trips.length);
assert.equal(migrated.maintenance.length, original.maintenance.length);
assert.equal(migrated.categories.expense.length, original.categories.expense.length);
assert.equal(migrated.categories.income.length, original.categories.income.length);
assert.equal(sumEntries(migrated.trips, 'expenses'), sumEntries(original.trips, 'expenses'));
assert.equal(sumEntries(migrated.trips, 'incomes'), sumEntries(original.trips, 'incomes'));
assert.equal(sumMaintenance(migrated.maintenance), sumMaintenance(original.maintenance));
assert.deepEqual(migratedFuel, originalFuel, 'fuel 元数据、升数、结构化金额或记录归属不守恒');
if (Number(original.schemaVersion) >= 4)
  assert.deepEqual(migratedBusiness, originalBusiness, '货主、去返程清单或常用地点不守恒');
assert.ok(migrated.trips.every(trip => trip.vehicleId));
assert.ok(migrated.maintenance.every(item => item.vehicleId));

console.log(JSON.stringify({
  ok: true,
  fromSchema: original.schemaVersion || 1,
  toSchema: migrated.schemaVersion,
  trips: migrated.trips.length,
  maintenance: migrated.maintenance.length,
  vehicles: migrated.vehicles.length,
  expenseTotal: sumEntries(migrated.trips, 'expenses'),
  incomeTotal: sumEntries(migrated.trips, 'incomes'),
  maintenanceTotal: sumMaintenance(migrated.maintenance),
  fuel: migratedFuel,
  business: migratedBusiness,
  periodStartDate: migrated.settings.periodStartDate,
  periodEndDate: migrated.settings.periodEndDate
}, null, 2));
