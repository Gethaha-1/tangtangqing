import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { startTestPostgres } from './helpers/postgres.mjs';
import { PostgresDatabase, postgresPoolOptions } from '../db/postgres.ts';
import { resolveOrCreateActor, loadBootstrap } from '../lib/server/bootstrap.ts';
import { applyAtomicSyncBatch, hashSyncPayload } from '../lib/server/sync-repository.ts';
import { canonicalSyncPayload, parseSyncRequest } from '../lib/server/sync-contract.ts';

let fixture, pool, database;
before(async () => {
  fixture = await startTestPostgres();
  pool = new pg.Pool(postgresPoolOptions({ TTQ_DATABASE_URL: fixture.databaseUrl }));
  database = new PostgresDatabase(pool);
});
after(async () => { await pool?.end(); await fixture?.stop(); });
const identity = (name = '测试车主') => ({ issuer: 'supabase', subject: randomUUID(), displayName: name, email: 'test@example.com', loginName: 'test@example.com' });
const vehicle = (id = 'v1', name = '测试车辆', expectedVersion = 0) => ({ op: 'put', type: 'vehicle', id, expectedVersion, data: { id, name, plateNo: '', active: true, sortOrder: 0 } });
async function sync(actor, operations, operationId = randomUUID()) {
  const parsed = parseSyncRequest({ operationId, operations, finalize: true });
  const hash = await hashSyncPayload(canonicalSyncPayload(parsed.operations, parsed.finalize));
  return applyAtomicSyncBatch(database, actor, parsed.operationId, hash, parsed.operations, parsed.finalize);
}

test('real PostgreSQL: first-login race creates exactly one account and fleet', async () => {
  const person = identity();
  const actors = await Promise.all(Array.from({ length: 4 }, () => resolveOrCreateActor(database, person)));
  assert.equal(new Set(actors.map(actor => actor.fleetId)).size, 1);
  const count = await database.prepare('SELECT COUNT(*) AS count FROM identities WHERE provider_subject = ?').bind(person.subject).first('count');
  assert.equal(count, 1);
});

test('real PostgreSQL: bootstrap, strict save, replay and account isolation', async () => {
  const a = await resolveOrCreateActor(database, identity('甲'));
  const b = await resolveOrCreateActor(database, identity('乙'));
  const id = randomUUID();
  assert.equal((await loadBootstrap(database, a)).cloudEmpty, true);
  const saved = await sync(a, [vehicle()], id);
  assert.equal(saved.results[0].version, 1);
  assert.equal((await sync(a, [vehicle()], id)).replayed, true);
  await assert.rejects(sync(a, [vehicle('v2')], id), error => error.code === 'operation_id_reused');
  assert.equal((await loadBootstrap(database, a)).records.filter(row => row.type === 'vehicle').length, 1);
  assert.equal((await loadBootstrap(database, b)).records.filter(row => row.type === 'vehicle').length, 0);
  await assert.rejects(sync(b, [vehicle('v1', '越权', 1)]), error => error.status === 409);
});

test('real PostgreSQL: concurrent updates allow one winner and never overwrite silently', async () => {
  const actor = await resolveOrCreateActor(database, identity());
  await sync(actor, [vehicle()]);
  const results = await Promise.allSettled([sync(actor, [vehicle('v1', '甲', 1)]), sync(actor, [vehicle('v1', '乙', 1)])]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  const failure = results.find(item => item.status === 'rejected');
  assert.equal(failure.reason.status, 409);
  assert.equal((await loadBootstrap(database, actor)).records.find(row => row.type === 'vehicle').version, 2);
});

test('real PostgreSQL: later constraint failure rolls back preceding writes', async () => {
  const actor = await resolveOrCreateActor(database, identity());
  await assert.rejects(database.batch([
    database.prepare("INSERT INTO vehicles (fleet_id,id,name,active) VALUES (?,?,?,1)").bind(actor.fleetId, 'rollback-v', '回滚'),
    database.prepare("INSERT INTO maintenance (fleet_id,id,vehicle_id,date,amount_cents) VALUES (?,?,?,?,?)").bind(actor.fleetId, 'm1', 'rollback-v', '2026-08-27', -1),
  ]));
  assert.equal(await database.prepare('SELECT id FROM vehicles WHERE fleet_id = ?').bind(actor.fleetId).first(), null);
});

test('real PostgreSQL: max amount precision, vehicle/trip and fuel constraints survive migration', async () => {
  const actor = await resolveOrCreateActor(database, identity());
  await sync(actor, [vehicle()]);
  await database.prepare('INSERT INTO maintenance (fleet_id,id,vehicle_id,date,amount_cents) VALUES (?,?,?,?,?)').bind(actor.fleetId, 'max', 'v1', '2026-08-27', 99999999999).run();
  assert.equal((await loadBootstrap(database, actor)).records.find(row => row.type === 'maintenance').data.amount, 999999999.99);
  await assert.rejects(database.prepare('UPDATE vehicles SET active = 0 WHERE fleet_id = ?').bind(actor.fleetId).run(), /last_active_vehicle/);
  await database.prepare("INSERT INTO trips (fleet_id,id,vehicle_id,start_date,status) VALUES (?,?,?,?,'open')").bind(actor.fleetId, 't1', 'v1', '2026-08-27').run();
  await assert.rejects(database.prepare("INSERT INTO trips (fleet_id,id,vehicle_id,start_date,status) VALUES (?,?,?,?,'open')").bind(actor.fleetId, 't2', 'v1', '2026-08-27').run(), /trips_one_open_per_vehicle/);
  await assert.rejects(database.prepare('INSERT INTO trip_expenses (fleet_id,id,trip_id,category_id,amount_cents,date,fuel_unit_price_x10000) VALUES (?,?,?,?,?,?,?)').bind(actor.fleetId, 'fuel1', 't1', 'fuel', 100, '2026-08-27', 80000).run(), /fuel_metadata_check/);
});

test('real PostgreSQL: anonymous/authenticated API roles cannot access private business data', async () => {
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await fixture.admin.query(`SET ROLE ${role}`);
    try { await assert.rejects(fixture.admin.query('SELECT * FROM ttq.users'), /permission denied/); }
    finally { await fixture.admin.query('RESET ROLE'); }
  }
  await assert.rejects(pool.query('CREATE TABLE ttq.forbidden (id INTEGER)'), /permission denied/);
  await assert.rejects(pool.query('SELECT * FROM auth.users'), /does not exist|permission denied/);
});

test('real PostgreSQL: driver assignment filtering and transaction-time revocation guards', async () => {
  const owner = await resolveOrCreateActor(database, identity());
  await sync(owner, [vehicle('allowed'), vehicle('hidden')]);
  const person = identity('司机');
  const userId = randomUUID(), memberId = randomUUID();
  await database.batch([
    database.prepare('INSERT INTO users (id,display_name) VALUES (?,?)').bind(userId, '司机'),
    database.prepare('INSERT INTO identities (id,user_id,provider,provider_subject) VALUES (?,?,?,?)').bind(randomUUID(), userId, 'supabase', person.subject),
    database.prepare("INSERT INTO fleet_members (id,fleet_id,user_id,role) VALUES (?,?,?,'driver')").bind(memberId, owner.fleetId, userId),
    database.prepare('INSERT INTO vehicle_assignments (id,fleet_id,vehicle_id,user_id,starts_at) VALUES (?,?,?,?,?)').bind(randomUUID(), owner.fleetId, 'allowed', userId, '2020-01-01T00:00:00Z'),
  ]);
  const driver = await resolveOrCreateActor(database, person);
  assert.equal(driver.role, 'driver');
  const snapshot = await loadBootstrap(database, driver);
  assert.deepEqual(snapshot.records.filter(row => row.type === 'vehicle').map(row => row.id), ['allowed']);
  const maintenance = id => ({ op: 'put', type: 'maintenance', id, expectedVersion: 0, data: { id, vehicleId: 'hidden', date: '2026-08-27', amount: 20, note: '' } });
  await assert.rejects(sync(driver, [maintenance('denied')]), error => error.status === 422);
  const operation = maintenance('revoked'); operation.data.vehicleId = 'allowed';
  const batch = parseSyncRequest({ operationId: randomUUID(), operations: [operation], finalize: false });
  const guardedDb = {
    prepare: database.prepare.bind(database),
    async batch(statements) {
      await fixture.admin.query('UPDATE ttq.fleet_members SET active=0, version=version+1 WHERE id=$1', [memberId]);
      return database.batch(statements);
    },
  };
  await assert.rejects(applyAtomicSyncBatch(guardedDb, driver, batch.operationId, await hashSyncPayload(canonicalSyncPayload(batch.operations, false)), batch.operations, false), error => error.status === 409);
  assert.equal(await database.prepare('SELECT id FROM maintenance WHERE fleet_id=? AND id=?').bind(owner.fleetId, 'revoked').first(), null);
});

test('real PostgreSQL: concurrent last-vehicle removals preserve an active vehicle', async () => {
  const actor = await resolveOrCreateActor(database, identity());
  await sync(actor, [vehicle('one'), vehicle('two')]);
  const results = await Promise.allSettled(['one', 'two'].map(id => sync(actor, [{ op: 'delete', type: 'vehicle', id, expectedVersion: 1 }])));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(await database.prepare('SELECT COUNT(*) AS count FROM vehicles WHERE fleet_id=? AND active=1').bind(actor.fleetId).first('count'), 1);
});

test('real PostgreSQL: the existing 500-operation atomic import boundary still works', async t => {
  const actor=await resolveOrCreateActor(database, identity());
  const operations=Array.from({length:500},(_,index)=>vehicle(`bulk-${index}`,`批量测试${index}`));
  const start=performance.now();
  const response=await sync(actor,operations);
  assert.equal(response.results.length,500);
  assert.equal(await database.prepare('SELECT COUNT(*) AS count FROM vehicles WHERE fleet_id=?').bind(actor.fleetId).first('count'),500);
  t.diagnostic(`Local 500-operation batch: ${Math.round(performance.now()-start)}ms; not a cloud/network benchmark.`);
});
