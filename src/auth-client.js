(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TTQAuthClient = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const REQUEST_HEADER = 'X-TTQ-Request';
  const REQUEST_MARKER = 'ledger-v1';
  const EPOCH_KEY = 'tangtangqing-session-epoch-v1';
  const CHANNEL_NAME = 'tangtangqing-session-v1';
  const SCOPE_PREFIX = 'tangtangqing-scope-v1';
  const SCOPE_SLOTS = new Set(['cache', 'conflict', 'migration', 'prefs']);
  const SESSION_ACTIONS = new Set(['logout', 'session-invalid']);

  function requireInternalId(value, label) {
    const id = String(value || '');
    if (!id || id.length > 200) throw new TypeError((label || '内部标识') + '无效');
    return id;
  }

  function scopeToken(fleetId, membershipId) {
    const fleet = requireInternalId(fleetId, '车队标识');
    const membership = requireInternalId(membershipId, '成员标识');
    return fleet.length + ':' + encodeURIComponent(fleet) + ':' +
      membership.length + ':' + encodeURIComponent(membership);
  }

  function safeStorage(storage) {
    return storage && typeof storage.getItem === 'function' ? storage : null;
  }

  function createStorageScope(storage, fleet, membership) {
    const target = safeStorage(storage);
    const token = scopeToken(fleet && fleet.id, membership && membership.id);
    const key = slot => {
      if (!SCOPE_SLOTS.has(slot)) throw new TypeError('未知的会话存储槽');
      return SCOPE_PREFIX + ':' + token + ':' + slot;
    };
    return Object.freeze({
      id: token,
      key,
      read(slot) {
        if (!target) return null;
        try {
          const raw = target.getItem(key(slot));
          return raw ? JSON.parse(raw) : null;
        } catch { return null; }
      },
      write(slot, value) {
        if (!target) return false;
        try {
          target.setItem(key(slot), JSON.stringify(value));
          return true;
        } catch { return false; }
      },
      remove(slot) {
        if (!target) return false;
        try { target.removeItem(key(slot)); return true; }
        catch { return false; }
      },
      clearSensitive() {
        // These slots can contain business state or a fingerprint derived from it.
        ['cache', 'conflict', 'migration', 'prefs'].forEach(slot => this.remove(slot));
      }
    });
  }

  function createHttpClient(options) {
    const config = options || {};
    const fetchImpl = config.fetch || (typeof fetch === 'function' ? fetch.bind(root) : null);
    const base = String(config.origin || (root.location && root.location.origin) || '');
    const activeControllers = new Set();
    if (!fetchImpl) throw new TypeError('缺少 fetch 实现');
    if (!base) throw new TypeError('缺少当前页面来源');

    async function requestJSON(path, payload) {
      const url = new URL(String(path || ''), base);
      if (url.origin !== new URL(base).origin)
        throw new TypeError('认证请求必须保持同源');
      const controller = new AbortController();
      activeControllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 20000);
      let response;
      try {
        response = await fetchImpl(url.pathname + url.search, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            [REQUEST_HEADER]: REQUEST_MARKER
          },
          body: JSON.stringify(payload === undefined ? {} : payload),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
        activeControllers.delete(controller);
      }

      if (response.status === 401) {
        if (typeof config.onUnauthorized === 'function')
          await config.onUnauthorized();
        const error = new Error('登录已失效，请重新登录');
        error.status = 401;
        throw error;
      }

      let body = {};
      try { body = await response.json(); } catch {}
      if (!response.ok) {
        const message = body && body.error && typeof body.error === 'object'
          ? body.error.message
          : body && body.error;
        const error = new Error(message || (response.status === 409
          ? '云端记录有新改动'
          : '云端请求失败'));
        error.status = response.status;
        error.details = body;
        throw error;
      }
      return body;
    }

    return Object.freeze({
      requestJSON,
      abortAll() { activeControllers.forEach(controller => controller.abort()); },
      bootstrap() { return requestJSON('/api/bootstrap', {}); },
      sync(payload) { return requestJSON('/api/sync', payload); },
      logout() { return requestJSON('/auth/logout?return_to=%2F', {}); }
    });
  }

  function createSessionCoordinator(options) {
    const config = options || {};
    const windowLike = config.window || root;
    const storage = safeStorage(config.storage || windowLike.localStorage);
    const Channel = config.BroadcastChannel || windowLike.BroadcastChannel;
    let channel = null;
    let stopped = false;

    function notifyPeer(action) {
      if (!SESSION_ACTIONS.has(action) || stopped) return;
      if (typeof config.onPeerSignal === 'function') config.onPeerSignal(action);
    }

    function parseSignal(value) {
      try {
        const parsed = JSON.parse(String(value || ''));
        return parsed && SESSION_ACTIONS.has(parsed.action) ? parsed.action : null;
      } catch { return null; }
    }

    function onStorage(event) {
      if (event && event.key === EPOCH_KEY) notifyPeer(parseSignal(event.newValue));
    }
    function onPageHide(event) {
      if (event && event.persisted && typeof config.onLock === 'function')
        config.onLock('bfcache');
    }
    function onPageShow(event) {
      if (!event || !event.persisted) return;
      if (typeof config.onLock === 'function') config.onLock('bfcache');
      if (typeof config.onRestore === 'function') config.onRestore();
    }

    if (typeof Channel === 'function') {
      try {
        channel = new Channel(CHANNEL_NAME);
        channel.onmessage = event => notifyPeer(parseSignal(JSON.stringify(event.data)));
      } catch { channel = null; }
    }
    if (typeof windowLike.addEventListener === 'function') {
      windowLike.addEventListener('storage', onStorage);
      windowLike.addEventListener('pagehide', onPageHide);
      windowLike.addEventListener('pageshow', onPageShow);
    }

    return Object.freeze({
      broadcast(action) {
        if (!SESSION_ACTIONS.has(action)) throw new TypeError('未知的会话广播类型');
        const message = {
          version: 1,
          action,
          epoch: Date.now() + ':' + Math.random().toString(36).slice(2)
        };
        if (channel) {
          try { channel.postMessage(message); } catch {}
        }
        if (storage) {
          try { storage.setItem(EPOCH_KEY, JSON.stringify(message)); } catch {}
        }
      },
      destroy() {
        stopped = true;
        if (channel) channel.close();
        if (typeof windowLike.removeEventListener === 'function') {
          windowLike.removeEventListener('storage', onStorage);
          windowLike.removeEventListener('pagehide', onPageHide);
          windowLike.removeEventListener('pageshow', onPageShow);
        }
      }
    });
  }

  return Object.freeze({
    REQUEST_HEADER,
    REQUEST_MARKER,
    EPOCH_KEY,
    CHANNEL_NAME,
    createHttpClient,
    createStorageScope,
    createSessionCoordinator
  });
});
