import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/draft-store.js';
import '../src/recovery-client.js';
const { createVault } = globalThis.TTQDraftStore;
const Recovery = globalThis.TTQRecovery;

function memory() {
  const rows = new Map();
  return {
    rows,
    async list(scope) { return [...rows.values()].filter(row => row.scope === scope); },
    async mutate(key, change) { const next = change(rows.get(key) || null); if (next) rows.set(key, next); else rows.delete(key); return next; },
    async clear(scope) { for (const [key, row] of rows) if (row.scope === scope) rows.delete(key); }
  };
}
test('draft vault: reload preserves unfinished fields and stable IDs; account scope never crosses', async () => {
  const adapter = memory(), a = createVault('fleet-a:member-a', { adapter }), b = createVault('fleet-b:member-b', { adapter });
  const value = { tripId: 't1', entries: [{ id: 'stable', amount: 1 }], expression: '30+2', date: '2026-09-06', note: '未加入', fuel: { unitPrice: '7.8', liters: '' } };
  const row = await a.save('quick-1', 'quick', value);
  value.entries[0].amount = 999;
  assert.equal((await b.list()).length, 0);
  a.lock();
  await assert.rejects(a.list(), /锁定/);
  const reloaded = createVault('fleet-a:member-a', { adapter });
  assert.equal((await reloaded.list())[0].value.expression, '30+2');
  assert.equal((await reloaded.list())[0].value.entries[0].amount, 1);
  await reloaded.remove(row.id, row.revision);
  assert.equal((await reloaded.list()).length, 0);
});
test('draft vault: two tabs cannot overwrite or delete a newer revision', async () => {
  const adapter = memory(), a = createVault('scope', { adapter }), b = createVault('scope', { adapter });
  const row = await a.save('quick-1', 'quick', { note: '原稿' });
  await b.save(row.id, 'quick', { note: '另一个页面修改' }, row.revision);
  await assert.rejects(a.save(row.id, 'quick', { note: '旧页面' }, row.revision), error => error.code === 'draft_conflict');
  await assert.rejects(a.remove(row.id, row.revision), error => error.code === 'draft_conflict');
  assert.equal((await b.list())[0].value.note, '另一个页面修改');
});
test('draft vault: queued edits survive session locking; failed persistence never acknowledges', async () => {
  const adapter = memory(), vault = createVault('scope', { adapter });
  const saving = vault.save('quick-1', 'quick', { note: '最后一次输入' });
  vault.lock();
  await saving;
  assert.equal(adapter.rows.size, 1);
  const broken = createVault('scope', { adapter: { ...adapter, mutate() { throw new Error('quota'); } } });
  await assert.rejects(broken.save('quick-2', 'quick', {}), /quota/);
  assert.equal(adapter.rows.size, 1);
});
test('draft vault: pending request and quick input share one durable record until receipt cleanup', async () => {
  const adapter = memory(), vault = createVault('scope', { adapter });
  const saved = await vault.save('quick-1', 'quick', { entries: [{ id: 'expense-1' }] });
  const pending = await vault.save(saved.id, 'quick', { ...saved.value, pending: { request: { operationId: 'one-stable-id', operations: [] } } }, saved.revision);
  const afterCrash = createVault('scope', { adapter });
  assert.equal((await afterCrash.list())[0].value.pending.request.operationId, 'one-stable-id');
  await afterCrash.remove(pending.id, pending.revision);
  assert.equal((await afterCrash.list()).length, 0);
});
test('restore client: UTF-8 bytes and operation caps split uploads without splitting the final commit', async () => {
  const operations = Array.from({ length: 514 }, (_, i) => ({ op: 'put', type: 'maintenance', id: String(i), expectedVersion: 0, data: { note: '中文'.repeat(200) } }));
  const prepared = await Recovery.prepare(operations);
  assert.equal(prepared.manifest.operationCount, 514);
  assert.ok(prepared.payloads.every(value => Buffer.byteLength(value) <= Recovery.LIMITS.chunkBytes));
  assert.deepEqual(prepared.payloads.flatMap(value => JSON.parse(value)), operations);
  const calls = [];
  const task = { id: 'restore-stable', baseVersion: 5, ...prepared };
  const request = async (path, input) => {
    calls.push(input);
    if (input.action === 'start') return { id: task.id, status: 'uploading', received: [0] };
    if (input.action === 'commit') return { id: task.id, status: 'complete' };
    return {};
  };
  await Recovery.resume(request, task);
  assert.equal(calls.filter(call => call.action === 'commit').length, 1);
  assert.equal(calls.filter(call => call.action === 'chunk').length, prepared.payloads.length - 1);
  assert.ok(calls.every(call => call.id === task.id));
});
test('restore client: lost acknowledgement retries the same task; locked session stops continuation', async () => {
  const task = { id: 'restore-stable', baseVersion: 5, ...await Recovery.prepare([{ op: 'delete', type: 'trip', id: 't1', expectedVersion: 1 }]) };
  await assert.rejects(Recovery.resume(async () => ({ status: 'complete' }), task, null, () => { throw new Error('locked'); }), /locked/);
  await assert.rejects(Recovery.prepare([{ data: { note: 'x'.repeat(Recovery.LIMITS.chunkBytes) } }]), /单条/);
  await assert.rejects(Recovery.prepare(Array.from({ length: 30001 }, () => ({}))), /30000/);
});
