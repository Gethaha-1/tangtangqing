import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { startTestPostgres } from './helpers/postgres.mjs';
import { PostgresDatabase, postgresPoolOptions } from '../db/postgres.ts';
import { resolveOrCreateActor, loadBootstrap } from '../lib/server/bootstrap.ts';
import { applyAtomicSyncBatch, hashSyncPayload } from '../lib/server/sync-repository.ts';
import { canonicalSyncPayload, parseSyncRequest } from '../lib/server/sync-contract.ts';
import { startRestore, uploadRestoreChunk, commitRestore, cancelRestore, restoreStatus, cleanExpiredRestores, parseRestoreManifest } from '../lib/server/restore-repository.ts';
import '../src/domain.js';
import '../src/cloud-sync.js';
import '../src/recovery-client.js';

let fixture, pool, database;
const Cloud = globalThis.TTQCloudSync, Domain = globalThis.TTQDomain, Recovery = globalThis.TTQRecovery;
const defaults = () => ({ schemaVersion: 3, settings: { theme: 'day', activeVehicleId: 'all', periodStartDate: '2026-01-01', periodEndDate: '2026-12-31' }, categories: { expense: [{ id: 'fuel', name: '油费', active: true }, { id: 'toll', name: '路桥费', active: true }], income: [{ id: 'cargo', name: '运费', active: true }] }, vehicles: [{ id: 'v1', name: '测试车', active: true }], trips: [], maintenance: [] });
before(async () => { fixture = await startTestPostgres(); pool = new pg.Pool(postgresPoolOptions({ TTQ_DATABASE_URL: fixture.databaseUrl })); database = new PostgresDatabase(pool); });
after(async () => { await pool?.end(); await fixture?.stop(); });
async function actor() { return resolveOrCreateActor(database, { issuer: 'supabase', subject: randomUUID(), displayName: '隔离恢复测试' }); }
async function write(who, ops) {
  const parsed = parseSyncRequest({ operationId: randomUUID(), operations: ops, finalize: true });
  return applyAtomicSyncBatch(database, who, parsed.operationId, await hashSyncPayload(canonicalSyncPayload(parsed.operations, true)), parsed.operations, true);
}
async function prepare(who, target) {
  const before = await loadBootstrap(database, who), operations = Cloud.planSync(target, before.records);
  return { id: randomUUID(), baseVersion: before.fleet.version, ...await Recovery.prepare(operations) };
}
async function upload(who, task) {
  await startRestore(database, who, task.id, task.baseVersion, task.manifest);
  for (let i = 0; i < task.payloads.length; i++) await uploadRestoreChunk(database, who, task.id, i, task.payloads[i]);
}
function backup(count, version = 3) {
  const raw = defaults(); raw.schemaVersion = version;
  raw.trips = Array.from({ length: Math.ceil(count / 200) }, (_, i) => ({ id: 'trip-' + i, vehicleId: 'v1', status: 'closed', startDate: '2026-08-01', endDate: '2026-08-03',
    expenses: Array.from({ length: Math.min(200, count - i * 200) }, (_, j) => ({ id: 'e-' + i + '-' + j, catId: j % 2 ? 'toll' : 'fuel', amount: 80.25, date: '2026-08-02', note: '中文恢复测试', ...(version === 3 && j % 2 === 0 ? { fuel: { unitPrice: '8.025', liters: '10' } } : {}) })),
    incomes: [{ id: 'income-' + i, catId: 'cargo', amount: 20000.25, date: '2026-08-03' }] }));
  if (version === 1) { delete raw.vehicles; raw.trips.forEach(trip => { delete trip.vehicleId; }); }
  return Domain.migrate(raw, defaults());
}
test('restore: old v1/v2/v3 backups over 500 records survive chunk interruption and replay without partial writes', async () => {
  for (const version of [1, 2, 3]) {
    const who = await actor(), target = backup(514, version), task = await prepare(who, target);
    await startRestore(database, who, task.id, task.baseVersion, task.manifest);
    await uploadRestoreChunk(database, who, task.id, 0, task.payloads[0]);
    await uploadRestoreChunk(database, who, task.id, 0, task.payloads[0]);
    assert.equal((await loadBootstrap(database, who)).records.filter(row => row.type === 'trip').length, 0);
    await assert.rejects(commitRestore(database, who, task.id), /未上传/);
    assert.deepEqual((await restoreStatus(database, who, task.id)).received, [0]);
    await upload(who, task);
    assert.equal((await commitRestore(database, who, task.id)).status, 'complete');
    assert.equal((await commitRestore(database, who, task.id)).replayed, true);
    const confirmed = await loadBootstrap(database, who);
    assert.equal(Cloud.compareConservation(target, Cloud.hydrateState(confirmed.records, defaults())).equal, true);
    assert.equal((await restoreStatus(database, who, task.id)).received.length, 0);
  }
});
test('restore: manifest tampering, cross-account access and drivers are rejected without business writes', async () => {
  const a = await actor(), b = await actor(), task = await prepare(a, backup(501));
  await startRestore(database, a, task.id, task.baseVersion, task.manifest);
  await assert.rejects(uploadRestoreChunk(database, a, task.id, 0, task.payloads[0] + ' '), /不一致/);
  await assert.rejects(restoreStatus(database, b, task.id), /没有找到/);
  await assert.rejects(commitRestore(database, { ...a, role: 'driver' }, task.id), /车主/);
  assert.throws(() => parseRestoreManifest({ ...task.manifest, operationCount: 1 }), /超过/);
  assert.throws(() => parseRestoreManifest({ chunks: Array.from({ length: 256 }, () => ({ hash:'0'.repeat(64), bytes:131072, count:1 })), totalBytes:33554432, operationCount:256 }), /20 MiB/);
  await assert.rejects(startRestore(database, a, randomUUID(), task.baseVersion, task.manifest), /已有/);
  assert.equal((await loadBootstrap(database, a)).records.length, 1);
  await cancelRestore(database, a, task.id);
});
test('restore: a newly inserted record after preview invalidates full replacement even when absent from operations', async () => {
  const who = await actor();
  await write(who, Cloud.planSync(Domain.migrate(defaults(), defaults()), (await loadBootstrap(database, who)).records));
  const before = await loadBootstrap(database, who), task = await prepare(who, backup(514));
  await upload(who, task);
  await write(who, [{ op: 'put', type: 'maintenance', id: 'other-device', expectedVersion: 0, data: { id: 'other-device', vehicleId: 'v1', date: '2026-09-01', amount: 123, note: '' } }]);
  assert.ok((await loadBootstrap(database, who)).fleet.version > before.fleet.version);
  await assert.rejects(commitRestore(database, who, task.id), error => error.status === 409);
  assert.equal((await loadBootstrap(database, who)).records.filter(row => row.type === 'trip').length, 0);
  assert.equal((await loadBootstrap(database, who)).records.find(row => row.id === 'other-device').data.amount, 123);
  await cancelRestore(database, who, task.id);
});
test('restore: transaction-time constraint failure rolls back all 514 records; cancellation and expiry only clear staging', async () => {
  const who = await actor(), target = backup(514);
  target.trips[0].incomes.push({ ...target.trips[0].incomes[0], id: 'duplicate-category' });
  const task = await prepare(who, target);
  await upload(who, task);
  await assert.rejects(commitRestore(database, who, task.id), error => error.status === 422);
  assert.equal((await loadBootstrap(database, who)).records.length, 1);
  await fixture.admin.query('UPDATE ttq.restore_jobs SET expires_at=$1 WHERE fleet_id=$2', ['2000-01-01T00:00:00.000Z', who.fleetId]);
  await cleanExpiredRestores(database, who);
  assert.equal(await database.prepare('SELECT COUNT(*) AS count FROM restore_chunks WHERE fleet_id=?').bind(who.fleetId).first('count'), 0);
  assert.equal((await loadBootstrap(database, who)).records.length, 1);
});
test('restore: 10000 mixed expense records complete and read back with exact conservation', async t => {
  const who = await actor(), target = backup(10000), task = await prepare(who, target);
  const started = performance.now();
  await upload(who, task);
  const commitStarted = performance.now();
  await commitRestore(database, who, task.id);
  const after = await loadBootstrap(database, who);
  assert.equal(after.records.filter(row => row.type === 'trip_expense').length, 10000);
  assert.equal(Cloud.compareConservation(target, Cloud.hydrateState(after.records, defaults())).equal, true);
  t.diagnostic(`Loopback PostgreSQL only: ${task.manifest.operationCount} operations, ${task.manifest.totalBytes} bytes, upload+commit+read ${Math.round(performance.now() - started)}ms, commit+read ${Math.round(performance.now() - commitStarted)}ms. Not a production latency claim.`);
});
test('restore: new staging tables and revision function are private with RLS and least privilege', async () => {
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await fixture.admin.query(`SET ROLE ${role}`);
    try { await assert.rejects(fixture.admin.query('SELECT * FROM ttq.restore_chunks'), /permission denied/); }
    finally { await fixture.admin.query('RESET ROLE'); }
  }
  const result = await fixture.admin.query("SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'ttq'::regnamespace AND relname IN ('restore_jobs','restore_chunks')");
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every(row => row.relrowsecurity));
});

test('restore: completed identity survives staging expiry; changed manifest cannot reuse its receipt', async () => {
  const who = await actor(), task = await prepare(who, backup(514));
  await upload(who, task);
  await commitRestore(database, who, task.id);
  await fixture.admin.query('UPDATE ttq.restore_jobs SET expires_at=$1 WHERE fleet_id=$2', ['2000-01-01T00:00:00.000Z', who.fleetId]);
  await cleanExpiredRestores(database, who);
  assert.equal((await startRestore(database, who, task.id, task.baseVersion, task.manifest)).status, 'complete');
  const changed = structuredClone(task.manifest); changed.chunks[0].hash = '0'.repeat(64);
  await assert.rejects(startRestore(database, who, task.id, task.baseVersion, changed), error => error.status === 409);
  await assert.rejects(cancelRestore(database, who, task.id), error => error.status === 409);
  assert.equal((await loadBootstrap(database, who)).records.filter(row => row.type === 'trip_expense').length, 514);
});

test('restore: cancel before a delayed start creates a tombstone and leaves formal data untouched', async () => {
  const who = await actor(), task = await prepare(who, backup(514));
  assert.equal((await cancelRestore(database, who, task.id)).status, 'cancelled');
  await assert.rejects(startRestore(database, who, task.id, task.baseVersion, task.manifest), error => error.status === 409);
  await assert.rejects(uploadRestoreChunk(database, who, task.id, 0, task.payloads[0]), /结束/);
  assert.equal((await loadBootstrap(database, who)).records.length, 1);
});

test('restore: membership revoked between preflight and transaction aborts every business write', async () => {
  const who = await actor(), task = await prepare(who, backup(514));
  await upload(who, task);
  let revoked = false;
  const racing = {
    prepare: sql => database.prepare(sql),
    async batch(statements) {
      if (!revoked && statements.length > 100) {
        revoked = true;
        await fixture.admin.query('UPDATE ttq.fleet_members SET active=0, version=version+1 WHERE id=$1', [who.membershipId]);
      }
      return database.batch(statements);
    }
  };
  await assert.rejects(commitRestore(racing, who, task.id));
  assert.equal(revoked, true);
  assert.equal(await database.prepare('SELECT COUNT(*) AS count FROM trips WHERE fleet_id=?').bind(who.fleetId).first('count'), 0);
  assert.equal(await database.prepare('SELECT COUNT(*) AS count FROM sync_commits WHERE fleet_id=?').bind(who.fleetId).first('count'), 0);
});

test('restore: concurrent finalization resolves to one receipt and one ledger', async () => {
  const who = await actor(), task = await prepare(who, backup(514));
  await upload(who, task);
  const results = await Promise.allSettled([commitRestore(database, who, task.id), commitRestore(database, who, task.id)]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  assert.equal((await commitRestore(database, who, task.id)).status, 'complete');
  assert.equal(await database.prepare('SELECT COUNT(*) AS count FROM sync_commits WHERE fleet_id=?').bind(who.fleetId).first('count'), 1);
  assert.equal((await loadBootstrap(database, who)).records.filter(row => row.type === 'trip_expense').length, 514);
});
