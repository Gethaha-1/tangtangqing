import fs from 'node:fs';
import assert from 'node:assert/strict';
import '../src/domain.js';

const D = globalThis.TTQDomain;

const backupPath = process.argv[2];
if (!backupPath) {
  console.error('用法：node scripts/verify-backup.js <备份文件.json>');
  process.exit(2);
}

const original = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
const period = D.defaultPeriod();
const base = {
  schemaVersion: 2,
  settings: {
    theme: 'day',
    lastReportSeen: '',
    lastBackupAt: '',
    activeVehicleId: 'all',
    periodStartDate: period.start,
    periodEndDate: period.end
  },
  categories: { expense: [], income: [] },
  vehicles: [D.legacyVehicle()],
  trips: [],
  maintenance: []
};
const migrated = D.migrate(original, base);

function sumEntries(trips, field) {
  return trips.reduce((sum, trip) =>
    sum + (trip[field] || []).reduce((inner, entry) => inner + D.cleanAmount(entry.amount), 0), 0);
}
function sumMaintenance(items) {
  return items.reduce((sum, item) => sum + D.cleanAmount(item.amount), 0);
}

assert.equal(migrated.schemaVersion, 2);
assert.equal(migrated.trips.length, original.trips.length);
assert.equal(migrated.maintenance.length, original.maintenance.length);
assert.equal(migrated.categories.expense.length, original.categories.expense.length);
assert.equal(migrated.categories.income.length, original.categories.income.length);
assert.equal(sumEntries(migrated.trips, 'expenses'), sumEntries(original.trips, 'expenses'));
assert.equal(sumEntries(migrated.trips, 'incomes'), sumEntries(original.trips, 'incomes'));
assert.equal(sumMaintenance(migrated.maintenance), sumMaintenance(original.maintenance));
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
  periodStartDate: migrated.settings.periodStartDate,
  periodEndDate: migrated.settings.periodEndDate
}, null, 2));
