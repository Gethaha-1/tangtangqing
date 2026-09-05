import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import '../src/auth-client.js';

const Auth = globalThis.TTQAuthClient;
const authClientSource = readFileSync(new URL('../src/auth-client.js', import.meta.url), 'utf8');
const ledgerSource = readFileSync(new URL('../legacy/ledger.html', import.meta.url), 'utf8');
const storeStart = ledgerSource.indexOf('const Store = (() => {');
const storeEnd = ledgerSource.indexOf('\n})();', storeStart) + '\n})();'.length;
const storeSource = ledgerSource.slice(storeStart, storeEnd);

function memoryStorage(initial) {
  const values = new Map(Object.entries(initial || {}));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    snapshot() { return Object.fromEntries(values); }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function extractFunction(name) {
  const marker = `function ${name}(`;
  let start = ledgerSource.indexOf(marker);
  assert.notEqual(start, -1, `缺少 ${name}()`);
  const asyncStart = ledgerSource.lastIndexOf('async ', start);
  if (asyncStart >= 0 && ledgerSource.slice(asyncStart + 6, start) === '') start = asyncStart;
  const bodyStart = ledgerSource.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < ledgerSource.length; index += 1) {
    if (ledgerSource[index] === '{') depth++;
    if (ledgerSource[index] === '}' && --depth === 0)
      return ledgerSource.slice(start, index + 1);
  }
  throw new Error(`${name}() 没有闭合`);
}

test('浏览器直接加载时会把真实全局传入工厂并使用全局 fetch', async () => {
  const calls = [];
  const context = {
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    location: { origin: 'https://ledger.example' },
    fetch: async (path, init) => {
      calls.push({ path, init });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  };
  context.globalThis = context;
  vm.runInNewContext(authClientSource, context);

  await context.TTQAuthClient.createHttpClient().bootstrap();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/bootstrap');
  assert.equal(calls[0].init.method, 'POST');
});

test('认证客户端对 bootstrap/sync/logout 统一使用同源安全 POST 契约', async () => {
  const calls = [];
  const client = Auth.createHttpClient({
    origin: 'https://ledger.example',
    fetch: async (path, init) => {
      calls.push({ path, init });
      return new Response(JSON.stringify(path.includes('logout') ? { location: '/' } : { ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  await client.bootstrap();
  await client.sync({ operationId: 'op-1', operations: [] });
  await client.logout();

  assert.deepEqual(calls.map(call => call.path), [
    '/api/bootstrap',
    '/api/sync',
    '/auth/logout?return_to=%2F'
  ]);
  for (const call of calls) {
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.credentials, 'same-origin');
    assert.equal(call.init.cache, 'no-store');
    assert.equal(call.init.headers['Content-Type'], 'application/json');
    assert.equal(call.init.headers['X-TTQ-Request'], 'ledger-v1');
    assert.doesNotThrow(() => JSON.parse(call.init.body));
  }
  assert.equal(calls[0].init.body, '{}');
});

test('401 必须先锁定再向调用方失败', async () => {
  const order = [];
  const client = Auth.createHttpClient({
    origin: 'https://ledger.example',
    fetch: async () => new Response('{}', { status: 401 }),
    onUnauthorized: async () => { order.push('lock'); }
  });
  await assert.rejects(client.bootstrap(), error => {
    order.push('reject');
    return error.status === 401;
  });
  assert.deepEqual(order, ['lock', 'reject']);
});

test('超时覆盖回执读取，并与服务器错误及断网区分', async () => {
  let expire, deadline;
  const context = {
    URL, AbortController, TypeError,
    setTimeout(callback, ms) { expire = callback; deadline = ms; return 1; },
    clearTimeout() {},
    location: { origin: 'https://ledger.example' },
    fetch: async (_, init) => ({
      ok: true, status: 200,
      json: () => new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        expire();
      }),
    }),
  };
  vm.runInNewContext(authClientSource, context);
  await assert.rejects(context.TTQAuthClient.createHttpClient().sync({}), error => error.code === 'request_timeout');
  assert.equal(deadline, 45000);
  for (const status of [500, 504]) {
    const client = Auth.createHttpClient({ origin: 'https://ledger.example', fetch: async () => new Response('gateway error', { status }) });
    await assert.rejects(client.sync({}), error => error.status === status && !error.message.includes('检查网络'));
  }
  const offline = Auth.createHttpClient({ origin: 'https://ledger.example', fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(offline.sync({}), error => error.code === 'network_error');
});

test('账号存储严格按 fleet + membership 隔离，旧未归属键保持且不可见', () => {
  const old = {
    'tangtangqing-data': '{"private":"legacy"}',
    'tangtangqing-cloud-cache-v1': '{"private":"old-cache"}',
    'tangtangqing-conflict-backup-v1': '{"private":"old-conflict"}',
    'tangtangqing-cloud-migration-v2': '{"private":"old-marker"}'
  };
  const storage = memoryStorage(old);
  const accountA = Auth.createStorageScope(storage, { id: 'fleet-a' }, { id: 'member-a' });
  const accountB = Auth.createStorageScope(storage, { id: 'fleet-b' }, { id: 'member-b' });
  accountA.write('cache', { state: 'A' });
  accountA.write('conflict', { state: 'A-conflict' });
  accountA.write('migration', { fingerprint: 'A-only' });
  accountA.write('prefs', { activeVehicleId: 'vehicle-a' });

  assert.deepEqual(accountA.read('cache'), { state: 'A' });
  assert.equal(accountB.read('cache'), null);
  assert.equal(accountB.read('prefs'), null);
  accountA.clearSensitive();
  assert.equal(accountA.read('cache'), null);
  assert.equal(accountA.read('prefs'), null);
  for (const [key, value] of Object.entries(old))
    assert.equal(storage.getItem(key), value);

  assert.doesNotMatch(ledgerSource, /localStorage\.getItem\(['"]tangtangqing-data/);
  assert.doesNotMatch(ledgerSource, /localStorage\.clear\s*\(/);
  assert.doesNotMatch(ledgerSource, /opened\.legacy|Store\.legacy\b/);
});

test('BFCache 与多标签信号先锁定；epoch 不携带账号或车队数据', () => {
  const listeners = new Map();
  const storage = memoryStorage();
  class FakeChannel {
    static latest;
    constructor(name) { this.name = name; FakeChannel.latest = this; }
    postMessage(message) { this.sent = message; }
    close() {}
  }
  const fakeWindow = {
    localStorage: storage,
    BroadcastChannel: FakeChannel,
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener() {}
  };
  const events = [];
  const coordinator = Auth.createSessionCoordinator({
    window: fakeWindow,
    storage,
    BroadcastChannel: FakeChannel,
    onLock: reason => events.push('lock:' + reason),
    onRestore: () => events.push('reload'),
    onPeerSignal: action => events.push('peer:' + action)
  });

  listeners.get('pagehide')({ persisted: true });
  listeners.get('pageshow')({ persisted: true });
  assert.deepEqual(events, ['lock:bfcache', 'lock:bfcache', 'reload']);

  coordinator.broadcast('logout');
  const epoch = storage.getItem(Auth.EPOCH_KEY);
  assert.match(epoch, /"action":"logout"/);
  assert.doesNotMatch(epoch, /phone|token|fleet|member|@/i);
  FakeChannel.latest.onmessage({ data: { version: 1, action: 'session-invalid', epoch: 'x' } });
  assert.equal(events.at(-1), 'peer:session-invalid');
});

test('锁定多层 sheet 跳过 history，普通关闭仍保留原历史语义', () => {
  const source = extractFunction('closeAllSheets');
  let historyCalls = 0;
  const context = vm.createContext({
    sheetStack: ['sheet-a', 'sheet-b'],
    sheetTransitions: {},
    transitionTokens: { clear() {} },
    document: { body: { classList: { remove() {} } } },
    historyOK: true,
    expectPop: 0,
    history: { go(value) { historyCalls++; assert.equal(value, -2); } },
    $$: () => [],
    clearSheetVisualStyles() {},
    tapShield() {},
    syncSheetModality() {}
  });
  new vm.Script(`${source}; this.closeAllSheets = closeAllSheets;`).runInContext(context);
  context.closeAllSheets({ skipHistory: true });
  assert.equal(historyCalls, 0);

  context.sheetStack.push('sheet-a', 'sheet-b');
  context.closeAllSheets();
  assert.equal(historyCalls, 1);
  assert.match(extractFunction('clearSensitiveClientState'), /closeAllSheets\(\{ skipHistory: true \}\)/);
});

test('sync 迟到成功回执不能在锁定后恢复 baseline 或 online', async () => {
  assert.ok(storeStart >= 0 && storeEnd > storeStart);
  const syncResult = deferred();
  let applied = false;
  const scope = {
    id: 'scope', read() { return null; }, write() { return true; },
    remove() { return true; }, clearSensitive() {}
  };
  const context = vm.createContext({
    console,
    location: { origin: 'https://ledger.example' },
    localStorage: memoryStorage(),
    invalidateSession() {},
    defaultData: () => ({}),
    TTQAuthClient: {
      createHttpClient: () => ({
        bootstrap: async () => ({
          fleet: { id: 'fleet-a' }, membership: { id: 'member-a' }, records: []
        }),
        sync: () => syncResult.promise,
        logout: async () => ({ location: '/' }),
        abortAll() {}
      }),
      createStorageScope: () => scope
    },
    TTQCloudSync: {
      createOperationId: () => 'generated',
      cloudBusinessState: state => state,
      planSync: () => [{ op: 'put', type: 'vehicle', id: 'v1', expectedVersion: 0, data: {} }],
      applySyncResults() { applied = true; return []; },
      hydrateState: () => ({ confirmed: true }),
      snapshotFingerprint: () => 'fingerprint'
    }
  });
  new vm.Script(`${storeSource}; this.Store = Store;`).runInContext(context);
  const opened = await context.Store.open();
  const commit = context.Store.commit({ vehicles: [] }, { kind: 'test' });
  context.Store.lockSensitive({ clearScope: true });
  assert.throws(
    () => context.Store.useRemote(opened.remote, opened.generation),
    error => error.sessionLocked === true
  );
  syncResult.resolve({ operationId: 'test:generated', results: [] });
  const result = await commit;

  assert.equal(result.ok, false);
  assert.equal(result.unauthenticated, true);
  assert.equal(context.Store.state, 'locked');
  assert.equal(context.Store.online, false);
  assert.equal(applied, false);
  assert.match(
    ledgerSource,
    /const initialState = await chooseInitialState\(opened\);[\s\S]{0,160}opened\.generation !== Store\.generation[\s\S]{0,80}S = initialState;/
  );
});

test('退出等待在途保存失败时只 settle，不会把 click handler 提前 reject', async () => {
  const syncResult = deferred();
  const scope = {
    id: 'scope', read() { return null; }, write() { return true; },
    remove() { return true; }, clearSensitive() {}
  };
  const context = vm.createContext({
    console: { error() {} },
    location: { origin: 'https://ledger.example' },
    localStorage: memoryStorage(),
    invalidateSession() {},
    defaultData: () => ({}),
    TTQAuthClient: {
      createHttpClient: () => ({
        bootstrap: async () => ({
          fleet: { id: 'fleet-a' }, membership: { id: 'member-a' }, records: []
        }),
        sync: () => syncResult.promise,
        logout: async () => ({ location: '/' }),
        abortAll() {}
      }),
      createStorageScope: () => scope
    },
    TTQCloudSync: {
      createOperationId: () => 'generated',
      cloudBusinessState: state => state,
      planSync: () => [{ op: 'put', type: 'vehicle', id: 'v1', expectedVersion: 0, data: {} }],
      applySyncResults: () => [],
      hydrateState: () => ({}),
      snapshotFingerprint: () => 'fingerprint'
    }
  });
  new vm.Script(`${storeSource}; this.Store = Store;`).runInContext(context);
  await context.Store.open();
  const commit = context.Store.commit({ vehicles: [] }, { kind: 'test' });
  const idle = context.Store.whenIdle();
  const networkError = new Error('offline');
  networkError.status = 503;
  syncResult.reject(networkError);

  const settled = await idle;
  const result = await commit;
  assert.equal(settled.ok, false);
  assert.equal(result.ok, false);
  assert.equal(context.Store.hasPending, true);
  assert.match(ledgerSource, /await Store\.whenIdle\(\);[\s\S]{0,220}if \(Store\.hasPending\)/);
});

test('logout 请求失败后仍保持锁定，且只提供受保护的 POST 重试', async () => {
  let shown;
  let logoutCalls = 0;
  const context = vm.createContext({
    Store: { logout: async () => { logoutCalls++; throw new Error('offline'); } },
    URL,
    location: { origin: 'https://ledger.example', replace() { throw new Error('不应跳转'); } },
    console: { error() {} },
    showSessionLock(options) { shown = options; },
    safeLoginLocation: () => '/?reason=signed-out'
  });
  new vm.Script(`${extractFunction('requestLogout')}; this.requestLogout=requestLogout;`).runInContext(context);
  await context.requestLogout();
  assert.equal(shown.title, '账本仍已锁定');
  assert.equal(typeof shown.retry, 'function');
  assert.equal(shown.login, undefined);
  await shown.retry();
  assert.equal(logoutCalls, 2);
  assert.match(ledgerSource, /invalidateSession\('logout',[\s\S]*await requestLogout\(\)/);
  assert.match(ledgerSource, /if \(action === 'logout'\)[\s\S]{0,180}navigate: false[\s\S]{0,100}requestLogout\(\)/);
  assert.doesNotMatch(ledgerSource, /location\.(?:assign|href)\s*\(?['"]\/auth\/logout/);
});
