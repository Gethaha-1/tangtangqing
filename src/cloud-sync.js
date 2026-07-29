(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TTQCloudSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 2;
  const SETTINGS_ID = 'settings';
  const ORDER_FIELD = 'sortOrder';
  const RECORD_TYPES = [
    'fleet_settings',
    'category',
    'vehicle',
    'trip',
    'trip_expense',
    'trip_income',
    'maintenance'
  ];

  function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function snapshotFingerprint(value) {
    const text = canonical(value === undefined ? null : value);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16) + ':' + text.length;
  }

  function recordKey(type, id) {
    return String(type) + ':' + String(id);
  }

  function requireId(value, label) {
    const id = String(value || '');
    if (!id) throw new Error((label || '记录') + '缺少 id，不能安全同步');
    return id;
  }

  function withOrder(data, index) {
    return Object.assign({}, clone(data), { [ORDER_FIELD]: index });
  }

  function readVersion(versions, type, id) {
    if (!versions) return undefined;
    const key = recordKey(type, id);
    if (versions instanceof Map) {
      if (versions.has(key)) return versions.get(key);
      if (versions.has(type) && versions.get(type) instanceof Map)
        return versions.get(type).get(id);
      return undefined;
    }
    if (Array.isArray(versions)) {
      const match = versions.find(item =>
        item && item.type === type && String(item.id) === String(id)
      );
      return match ? match.version : undefined;
    }
    if (Object.prototype.hasOwnProperty.call(versions, key)) return versions[key];
    if (versions[type] && Object.prototype.hasOwnProperty.call(versions[type], id))
      return versions[type][id];
    return undefined;
  }

  function makeRecord(type, id, data, versions) {
    const record = { type, id: String(id), data: clone(data) };
    const version = readVersion(versions, type, id);
    if (version !== undefined) record.version = version;
    return record;
  }

  function normalizeState(state, versions) {
    if (!state || typeof state !== 'object')
      throw new TypeError('需要 schema v2 账本状态');

    const records = [];
    const settings = clone(state.settings || {});
    records.push(makeRecord('fleet_settings', SETTINGS_ID, settings, versions));

    const categories = state.categories || {};
    ['expense', 'income'].forEach(kind => {
      const list = Array.isArray(categories[kind]) ? categories[kind] : [];
      list.forEach((category, index) => {
        const originalId = requireId(category && category.id, kind + ' 科目');
        records.push(makeRecord(
          'category',
          kind + ':' + originalId,
          withOrder(Object.assign({}, category, { id: originalId, kind }), index),
          versions
        ));
      });
    });

    (Array.isArray(state.vehicles) ? state.vehicles : []).forEach((vehicle, index) => {
      const id = requireId(vehicle && vehicle.id, '车辆');
      records.push(makeRecord(
        'vehicle',
        id,
        withOrder(Object.assign({}, vehicle, { id }), index),
        versions
      ));
    });

    (Array.isArray(state.trips) ? state.trips : []).forEach((trip, tripIndex) => {
      const tripId = requireId(trip && trip.id, '趟次');
      const tripData = Object.assign({}, trip, { id: tripId });
      delete tripData.expenses;
      delete tripData.incomes;
      records.push(makeRecord('trip', tripId, withOrder(tripData, tripIndex), versions));

      (Array.isArray(trip.expenses) ? trip.expenses : []).forEach((entry, index) => {
        const id = requireId(entry && entry.id, '趟次支出');
        const data = Object.assign({}, entry, {
          id,
          tripId,
          categoryId: entry.catId
        });
        delete data.catId;
        records.push(makeRecord(
          'trip_expense',
          tripId + ':' + id,
          withOrder(data, index),
          versions
        ));
      });
      (Array.isArray(trip.incomes) ? trip.incomes : []).forEach((entry, index) => {
        const id = requireId(entry && entry.id, '趟次收入');
        const data = Object.assign({}, entry, {
          id,
          tripId,
          categoryId: entry.catId
        });
        delete data.catId;
        records.push(makeRecord(
          'trip_income',
          tripId + ':' + id,
          withOrder(data, index),
          versions
        ));
      });
    });

    (Array.isArray(state.maintenance) ? state.maintenance : []).forEach((item, index) => {
      const id = requireId(item && item.id, '维修记录');
      records.push(makeRecord(
        'maintenance',
        id,
        withOrder(Object.assign({}, item, { id }), index),
        versions
      ));
    });

    return records;
  }

  function asRecords(source) {
    if (!source) return [];
    if (Array.isArray(source)) return clone(source);
    if (Array.isArray(source.records)) return clone(source.records);
    if (source.schemaVersion || source.settings || source.categories ||
        source.vehicles || source.trips || source.maintenance)
      return normalizeState(source);
    return [];
  }

  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().map(key =>
        JSON.stringify(key) + ':' + canonical(value[key])
      ).join(',') + '}';
    }
    return JSON.stringify(value);
  }

  function indexRecords(records) {
    const index = new Map();
    records.forEach(item => {
      if (!item || !item.type || item.id === undefined || item.id === null)
        throw new Error('云记录缺少 type 或 id');
      const key = recordKey(item.type, item.id);
      if (index.has(key)) throw new Error('云记录重复：' + key);
      index.set(key, {
        type: String(item.type),
        id: String(item.id),
        data: clone(item.data !== undefined ? item.data : item.record),
        version: item.version
      });
    });
    return index;
  }

  function expectedVersion(baselineRecord, versions) {
    const explicit = readVersion(versions, baselineRecord.type, baselineRecord.id);
    if (explicit !== undefined) return explicit;
    return baselineRecord.version === undefined ? 0 : baselineRecord.version;
  }

  function planSync(state, baseline, versions) {
    const current = indexRecords(normalizeState(state));
    const before = indexRecords(asRecords(baseline));
    const keys = Array.from(new Set(
      Array.from(current.keys()).concat(Array.from(before.keys()))
    )).sort();
    const operations = [];

    keys.forEach(key => {
      const next = current.get(key);
      const previous = before.get(key);
      if (next && !previous) {
        operations.push({
          op: 'put',
          type: next.type,
          id: next.id,
          data: clone(next.data),
          expectedVersion: 0
        });
        return;
      }
      if (!next && previous) {
        operations.push({
          op: 'delete',
          type: previous.type,
          id: previous.id,
          expectedVersion: expectedVersion(previous, versions)
        });
        return;
      }
      if (canonical(next.data) !== canonical(previous.data)) {
        operations.push({
          op: 'put',
          type: next.type,
          id: next.id,
          data: clone(next.data),
          expectedVersion: expectedVersion(previous, versions)
        });
      }
    });

    const putOrder = {
      category: 0,
      vehicle: 1,
      trip: 2,
      trip_expense: 3,
      trip_income: 3,
      maintenance: 3,
      fleet_settings: 4
    };
    const deleteOrder = {
      trip_expense: 0,
      trip_income: 0,
      maintenance: 0,
      trip: 1,
      category: 2,
      vehicle: 3,
      fleet_settings: 4
    };
    operations.sort((a, b) => {
      if (a.op !== b.op) return a.op === 'delete' ? -1 : 1;
      const order = a.op === 'delete' ? deleteOrder : putOrder;
      const diff = (order[a.type] || 0) - (order[b.type] || 0);
      if (!diff && a.op === 'put' && a.type === 'vehicle' && b.type === 'vehicle') {
        const activeDiff = Number(b.data && b.data.active !== false) -
          Number(a.data && a.data.active !== false);
        if (activeDiff) return activeDiff;
      }
      return diff || recordKey(a.type, a.id).localeCompare(recordKey(b.type, b.id));
    });
    return operations;
  }

  function recordOrder(item) {
    const n = Number(item && item.data && item.data[ORDER_FIELD]);
    return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
  }

  function sortRecords(a, b) {
    return recordOrder(a) - recordOrder(b) ||
      String(a.id).localeCompare(String(b.id));
  }

  function cleanRecordData(item, fields) {
    const data = clone(item.data || {});
    delete data[ORDER_FIELD];
    (fields || []).forEach(field => { delete data[field]; });
    return data;
  }

  function recordsToState(source, fallback) {
    const records = asRecords(source);
    indexRecords(records);
    const known = new Set(RECORD_TYPES);
    records.forEach(item => {
      if (!known.has(item.type)) throw new Error('不支持的云记录类型：' + item.type);
    });

    const byType = {};
    RECORD_TYPES.forEach(type => { byType[type] = []; });
    records.forEach(item => { byType[item.type].push(item); });
    RECORD_TYPES.forEach(type => { byType[type].sort(sortRecords); });

    const fallbackSettings = fallback && fallback.settings ? clone(fallback.settings) : {};
    const settingRecord = byType.fleet_settings.find(item => item.id === SETTINGS_ID) ||
      byType.fleet_settings[0];
    const settingData = settingRecord ? cleanRecordData(settingRecord) : {};
    const schemaVersion = Number(settingData.schemaVersion) || SCHEMA_VERSION;
    delete settingData.schemaVersion;

    const state = {
      schemaVersion,
      settings: Object.assign(fallbackSettings, settingData),
      categories: { expense: [], income: [] },
      vehicles: byType.vehicle.map(item => {
        const data = cleanRecordData(item);
        data.id = String(data.id || item.id);
        return data;
      }),
      trips: byType.trip.map(item => {
        const data = cleanRecordData(item);
        data.id = String(data.id || item.id);
        data.expenses = [];
        data.incomes = [];
        return data;
      }),
      maintenance: byType.maintenance.map(item => {
        const data = cleanRecordData(item);
        data.id = String(data.id || item.id);
        return data;
      })
    };

    byType.category.forEach(item => {
      const data = cleanRecordData(item, ['kind']);
      const kind = item.data && item.data.kind;
      if (kind !== 'expense' && kind !== 'income')
        throw new Error('科目缺少 expense/income 类型：' + item.id);
      data.id = requireId(data.id, '科目');
      state.categories[kind].push(data);
    });

    const trips = new Map(state.trips.map(trip => [trip.id, trip]));
    ['trip_expense', 'trip_income'].forEach(type => {
      const target = type === 'trip_expense' ? 'expenses' : 'incomes';
      byType[type].forEach(item => {
        const tripId = String(item.data && item.data.tripId || '');
        const trip = trips.get(tripId);
        if (!trip) throw new Error(type + ' 找不到所属趟次：' + item.id);
        const data = cleanRecordData(item, ['tripId', 'categoryId']);
        data.id = requireId(data.id, type);
        data.catId = item.data && item.data.categoryId;
        trip[target].push(data);
      });
    });

    return state;
  }

  function hasStateSnapshot(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value) &&
      (value.schemaVersion !== undefined || value.settings || value.categories ||
       value.vehicles || value.trips || value.maintenance);
  }

  function hasBusinessRecords(source) {
    return asRecords(source).some(record => record.type !== 'fleet_settings');
  }

  function decideInitialMigration(localState, remote) {
    const localSnapshotFound = hasStateSnapshot(localState);
    const localHasData = localSnapshotFound && hasBusinessRecords(localState);
    const cloudEmpty = remote && typeof remote.cloudEmpty === 'boolean'
      ? remote.cloudEmpty
      : !hasBusinessRecords(remote);

    if (cloudEmpty && localSnapshotFound) {
      return {
        status: 'offer-upload',
        localSnapshotFound,
        localHasData,
        cloudEmpty: true,
        requiresExplicitAction: true
      };
    }
    if (cloudEmpty) {
      return {
        status: 'empty',
        localSnapshotFound: false,
        localHasData: false,
        cloudEmpty: true,
        requiresExplicitAction: false
      };
    }
    if (localHasData) {
      return {
        status: 'conflict',
        localSnapshotFound,
        localHasData,
        cloudEmpty: false,
        requiresExplicitAction: true
      };
    }
    return {
      status: 'use-cloud',
      localSnapshotFound,
      localHasData,
      cloudEmpty: false,
      requiresExplicitAction: false
    };
  }

  function amountInCents(value) {
    const amount = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
  }

  function summarizeState(source) {
    const records = hasStateSnapshot(source) ? normalizeState(source) : asRecords(source);
    const summary = {
      counts: {
        vehicles: 0,
        expenseCategories: 0,
        incomeCategories: 0,
        trips: 0,
        tripExpenses: 0,
        tripIncomes: 0,
        maintenance: 0
      },
      amounts: {
        tripExpenses: 0,
        tripIncomes: 0,
        maintenance: 0
      }
    };
    let expenseCents = 0;
    let incomeCents = 0;
    let maintenanceCents = 0;

    records.forEach(item => {
      if (item.type === 'vehicle') summary.counts.vehicles++;
      else if (item.type === 'category') {
        if (item.data && item.data.kind === 'expense') summary.counts.expenseCategories++;
        if (item.data && item.data.kind === 'income') summary.counts.incomeCategories++;
      } else if (item.type === 'trip') summary.counts.trips++;
      else if (item.type === 'trip_expense') {
        summary.counts.tripExpenses++;
        expenseCents += amountInCents(item.data && item.data.amount);
      } else if (item.type === 'trip_income') {
        summary.counts.tripIncomes++;
        incomeCents += amountInCents(item.data && item.data.amount);
      } else if (item.type === 'maintenance') {
        summary.counts.maintenance++;
        maintenanceCents += amountInCents(item.data && item.data.amount);
      }
    });
    summary.amounts.tripExpenses = expenseCents / 100;
    summary.amounts.tripIncomes = incomeCents / 100;
    summary.amounts.maintenance = maintenanceCents / 100;
    return summary;
  }

  function compareSummaries(before, after) {
    const left = before && before.counts && before.amounts
      ? clone(before)
      : summarizeState(before);
    const right = after && after.counts && after.amounts
      ? clone(after)
      : summarizeState(after);
    const differences = [];
    ['counts', 'amounts'].forEach(group => {
      const fields = new Set(
        Object.keys(left[group] || {}).concat(Object.keys(right[group] || {}))
      );
      fields.forEach(field => {
        const a = left[group] && left[group][field];
        const b = right[group] && right[group][field];
        if (a !== b) differences.push({ field: group + '.' + field, before: a, after: b });
      });
    });
    return { equal: differences.length === 0, differences, before: left, after: right };
  }

  function chunkOperations(operations, maxSize) {
    const size = maxSize == null ? 200 : Number(maxSize);
    if (!Number.isSafeInteger(size) || size < 1)
      throw new TypeError('同步分批大小必须是正整数');
    const source = Array.isArray(operations) ? operations : [];
    const chunks = [];
    for (let i = 0; i < source.length; i += size)
      chunks.push(source.slice(i, i + size));
    return chunks;
  }

  function inspectPendingCache(cache, remote) {
    if (!cache || !cache.state || !Array.isArray(cache.baselineRecords))
      return { status: 'none', operations: [], conflicts: [] };
    const operations = planSync(cache.state, cache.baselineRecords);
    if (!operations.length)
      return { status: 'none', operations: [], conflicts: [] };
    const remoteIndex = indexRecords(asRecords(remote));
    const conflicts = operations.filter(operation => {
      const current = remoteIndex.get(recordKey(operation.type, operation.id));
      if (
        operation.op === 'put' &&
        current &&
        canonical(current.data) === canonical(operation.data)
      ) return false;
      if (operation.op === 'delete' && !current) return false;
      const currentVersion = current && current.version !== undefined
        ? Number(current.version)
        : 0;
      return currentVersion !== operation.expectedVersion;
    }).map(operation => recordKey(operation.type, operation.id));
    return {
      status: conflicts.length ? 'conflict' : 'safe',
      operations,
      conflicts
    };
  }

  function applySyncResults(baseline, operations, results) {
    const sourceOperations = Array.isArray(operations) ? operations : [];
    const sourceResults = Array.isArray(results)
      ? results
      : (results && Array.isArray(results.results) ? results.results : []);
    if (sourceResults.length !== sourceOperations.length)
      throw new Error('云端返回的同步结果数量不完整');

    const resultIndex = new Map();
    sourceResults.forEach(result => {
      if (!result || !result.type || result.id === undefined || !result.op)
        throw new Error('云端返回了格式不完整的同步结果');
      const key = recordKey(result.type, result.id);
      if (resultIndex.has(key)) throw new Error('云端返回了重复的同步结果：' + key);
      resultIndex.set(key, result);
    });

    sourceOperations.forEach(operation => {
      const key = recordKey(operation.type, operation.id);
      const result = resultIndex.get(key);
      if (!result || result.op !== operation.op)
        throw new Error('云端没有确认本批记录：' + key);
      if (!['applied', 'conflict', 'rejected'].includes(result.status))
        throw new Error('云端返回了未知的同步状态：' + key);
      if (result.status === 'applied') {
        const expectedResultVersion = Number(operation.expectedVersion) + 1;
        if (!Number.isSafeInteger(result.version) ||
            Number(result.version) !== expectedResultVersion)
          throw new Error('云端返回的记录版本不连续：' + key);
        if (operation.op === 'put' &&
            (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)))
          throw new Error('云端没有回传已写入记录：' + key);
      }
    });

    const next = indexRecords(asRecords(baseline));
    sourceOperations.forEach(operation => {
      const key = recordKey(operation.type, operation.id);
      const result = resultIndex.get(key);
      if (result.status !== 'applied') return;
      if (operation.op === 'delete') {
        next.delete(key);
        return;
      }
      next.set(key, {
        type: operation.type,
        id: String(operation.id),
        data: clone(operation.data),
        version: Number(result.version)
      });
    });
    return Array.from(next.values()).sort((a, b) =>
      recordKey(a.type, a.id).localeCompare(recordKey(b.type, b.id))
    );
  }

  function mergeRemoteState(localState, baseline, remote, fallback) {
    const localRecords = indexRecords(normalizeState(localState));
    const remoteRecords = indexRecords(asRecords(remote));
    const changed = new Set(
      planSync(localState, baseline).map(operation =>
        recordKey(operation.type, operation.id)
      )
    );
    const merged = new Map(remoteRecords);
    changed.forEach(key => {
      const local = localRecords.get(key);
      if (local) merged.set(key, local);
      else merged.delete(key);
    });
    return recordsToState(Array.from(merged.values()), fallback);
  }

  function compareMigrationTarget(targetState, remote) {
    const target = indexRecords(normalizeState(targetState));
    const remoteIndex = indexRecords(asRecords(remote));
    const missing = [];
    const targetRemoteRecords = [];
    target.forEach((record, key) => {
      const remoteRecord = remoteIndex.get(key);
      if (!remoteRecord) missing.push(key);
      else targetRemoteRecords.push(remoteRecord);
    });
    const conservation = compareSummaries(
      Array.from(target.values()),
      targetRemoteRecords
    );
    return Object.assign({}, conservation, {
      equal: missing.length === 0 && conservation.equal,
      missing
    });
  }

  function saveFailureResult(error, deviceCached) {
    return {
      ok: false,
      conflict: !!(error && error.status === 409),
      deviceCached: deviceCached === true,
      error
    };
  }

  return {
    SCHEMA_VERSION,
    SETTINGS_ID,
    RECORD_TYPES,
    recordKey,
    normalizeState,
    recordsToState,
    hydrateState: recordsToState,
    planSync,
    buildSyncOperations: planSync,
    decideInitialMigration,
    summarizeState,
    compareSummaries,
    compareConservation: compareSummaries,
    chunkOperations,
    inspectPendingCache,
    applySyncResults,
    mergeRemoteState,
    compareMigrationTarget,
    saveFailureResult,
    snapshotFingerprint
  };
});
