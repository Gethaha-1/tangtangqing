(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TTQDraftStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const NAME = 'tangtangqing-drafts-v1';
  const clone = value => JSON.parse(JSON.stringify(value));
  function storageError(message, code) { const error = new Error(message); error.code = code || 'draft_storage_failed'; return error; }

  function indexedAdapter(indexedDB) {
    let opening;
    function open() {
      if (!indexedDB) return Promise.reject(storageError('本机不支持草稿暂存，请勿关闭页面'));
      if (!opening) opening = new Promise((resolve, reject) => {
        const request = indexedDB.open(NAME, 1);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore('drafts', { keyPath: 'key' });
          store.createIndex('scope', 'scope');
        };
        request.onerror = () => reject(storageError('本机草稿存储不可用，请勿关闭页面'));
        request.onblocked = () => reject(storageError('请关闭旧页面后重新开启草稿存储'));
        request.onsuccess = () => {
          request.result.onversionchange = () => { request.result.close(); opening = null; };
          resolve(request.result);
        };
      }).catch(error => { opening = null; throw error; });
      return opening;
    }
    async function transaction(mode, callback) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('drafts', mode), store = tx.objectStore('drafts');
        let result, failure;
        const done = value => { result = value; };
        const abort = error => { failure = error; tx.abort(); };
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => reject(failure || storageError('草稿未能暂存，请检查浏览器空间并勿关闭页面'));
        try { callback(store, done, abort); } catch (error) { abort(error); }
      });
    }
    return {
      list(scope) { return transaction('readonly', (store, done) => {
        const request = store.index('scope').getAll(scope);
        request.onsuccess = () => done(request.result);
      }); },
      mutate(key, callback) { return transaction('readwrite', (store, done, abort) => {
        const request = store.get(key);
        request.onsuccess = () => {
          try {
            const next = callback(request.result || null);
            if (next) store.put(next); else store.delete(key);
            done(next);
          } catch (error) { abort(error); }
        };
      }); },
      clear(scope) { return transaction('readwrite', (store, done) => {
        const request = store.index('scope').openCursor(scope);
        request.onsuccess = () => { const cursor = request.result; if (cursor) { cursor.delete(); cursor.continue(); } else done(true); };
      }); }
    };
  }

  function createVault(scope, options) {
    if (typeof scope !== 'string' || !scope || scope.length > 1800) throw storageError('必须先核对账号和车队归属');
    const adapter = options && options.adapter || indexedAdapter(root.indexedDB);
    let queue = Promise.resolve(), locked = false;
    const enqueue = task => {
      if (locked) return Promise.reject(storageError('会话已锁定', 'draft_locked'));
      const result = queue.then(task);
      queue = result.catch(() => {});
      return result;
    };
    const key = id => {
      if (typeof id !== 'string' || !id || id.length > 200) throw storageError('草稿标识无效');
      return JSON.stringify([scope, id]);
    };
    return Object.freeze({
      scope,
      list() { return enqueue(async () => clone(await adapter.list(scope))); },
      save(id, kind, value, expectedRevision = 0) {
        const data = clone(value);
        return enqueue(() => adapter.mutate(key(id), previous => {
          if ((previous && previous.revision || 0) !== expectedRevision)
            throw storageError('这份草稿已在另一个页面变化，请重新打开核对；本页内容没有覆盖它', 'draft_conflict');
          return { key: key(id), scope, id, kind, value: data, revision: expectedRevision + 1, updatedAt: new Date().toISOString() };
        }));
      },
      remove(id, expectedRevision) { return enqueue(() => adapter.mutate(key(id), previous => {
        if (previous && previous.revision !== expectedRevision)
          throw storageError('草稿已在其他页面变化，未删除', 'draft_conflict');
        return null;
      })); },
      clear() { return enqueue(() => adapter.clear(scope)); },
      flush() { return queue; },
      lock() { locked = true; }
    });
  }
  return { createVault };
});
