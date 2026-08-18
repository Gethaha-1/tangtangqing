(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TTQCloudSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 3;
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

  function scaledDecimal(value, scale, maximum, field, allowZero) {
    let text;
    if (typeof value === 'number' && Number.isFinite(value)) text = String(value);
    else if (typeof value === 'string') text = value.trim();
    else text = '';
    if (/[eE]/.test(text))
      throw new Error(field + ' 必须使用普通十进制，不能使用指数形式');
    const match = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(text);
    const fraction = match && ((match[2] !== undefined ? match[2] : match[3]) || '');
    if (!match || fraction.length > scale)
      throw new Error(field + ' 不是支持精度内的普通十进制数');
    const factor = 10n ** BigInt(scale);
    const units = BigInt(match[1] || '0') * factor +
      BigInt((fraction + '0'.repeat(scale)).slice(0, scale) || '0');
    if ((!allowZero && units === 0n) || units > maximum)
      throw new Error(field + ' 超出支持范围');
    return units;
  }

  function canonicalScaled(units, scale) {
    const factor = 10n ** BigInt(scale);
    const fixed = String(units / factor) + '.' +
      String(units % factor).padStart(scale, '0');
    return fixed.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  }

  function normalizeExpenseFuel(data, label) {
    const normalized = clone(data || {});
    if (!Object.prototype.hasOwnProperty.call(normalized, 'fuel')) return normalized;
    if (normalized.categoryId !== 'fuel')
      throw new Error((label || '油费记录') + ' 的非油费科目不能携带 fuel 元数据');
    const fuel = normalized.fuel;
    if (!fuel || typeof fuel !== 'object' || Array.isArray(fuel) ||
        !Object.prototype.hasOwnProperty.call(fuel, 'unitPrice') ||
        !Object.prototype.hasOwnProperty.call(fuel, 'liters') ||
        Object.keys(fuel).some(key => key !== 'unitPrice' && key !== 'liters'))
      throw new Error((label || '油费记录') + ' 的 fuel 元数据必须完整');
    const amountCents = scaledDecimal(
      normalized.amount, 2, 99999999999n, 'fuel.totalAmount', true
    );
    const price = scaledDecimal(fuel.unitPrice, 4, 9999999n, 'fuel.unitPrice', false);
    const volume = scaledDecimal(fuel.liters, 3, 100000000n, 'fuel.liters', false);
    const expected = (price * volume + 50000n) / 100000n;
    const difference = amountCents >= expected
      ? amountCents - expected
      : expected - amountCents;
    if (amountCents === 0n || difference > 1n)
      throw new Error((label || '油费记录') + ' 的总价与单价、升数不一致');
    normalized.fuel = {
      unitPrice: canonicalScaled(price, 4),
      liters: canonicalScaled(volume, 3)
    };
    return normalized;
  }

  function normalizeRecordData(type, id, data) {
    return type === 'trip_expense'
      ? normalizeExpenseFuel(data, recordKey(type, id))
      : clone(data);
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
      throw new TypeError('需要 schema v3 账本状态');

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
        const data = normalizeExpenseFuel(Object.assign({}, entry, {
          id,
          tripId,
          categoryId: entry.catId
        }), 'trip_expense:' + tripId + ':' + id);
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
        data: normalizeRecordData(
          String(item.type),
          String(item.id),
          item.data !== undefined ? item.data : item.record
        ),
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
    const ownerRecordsWritable = [current, before].every(index => {
      const settings = index.get(recordKey('fleet_settings', SETTINGS_ID));
      return !settings || !settings.data || settings.data._ownerRecordsWritable !== false;
    });
    const keys = Array.from(new Set(
      Array.from(current.keys()).concat(Array.from(before.keys()))
    )).sort();
    const operations = [];

    keys.forEach(key => {
      const next = current.get(key);
      const previous = before.get(key);
      const type = (next || previous) && (next || previous).type;
      if (!ownerRecordsWritable &&
          ['fleet_settings', 'category', 'vehicle'].includes(type)) return;
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
    const records = Array.from(indexRecords(asRecords(source)).values());
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
    const amount = typeof value === 'number'
      ? value
      : (typeof value === 'string' && value.trim() ? Number(value) : Number.NaN);
    if (!Number.isFinite(amount) || amount < 0 || amount > 999999999.99)
      throw new Error('金额无效或超出支持范围');
    return Math.round(amount * 100);
  }

  function exactAmountCents(value) {
    const cents = amountInCents(value);
    if (!Number.isSafeInteger(cents))
      throw new Error('金额超出守恒校验支持范围');
    return BigInt(cents);
  }

  function validCalendarDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const parsed = new Date(String(value) + 'T00:00:00Z');
    return !Number.isNaN(parsed.valueOf()) &&
      parsed.toISOString().slice(0, 10) === value;
  }

  function inspectImportPeriod(backup, current) {
    const backupSettings = backup && backup.settings || {};
    const currentSettings = current && current.settings || {};
    const start = backupSettings.periodStartDate;
    const end = backupSettings.periodEndDate;
    const days = validCalendarDate(start) && validCalendarDate(end)
      ? Math.round(
          (new Date(end + 'T00:00:00Z') -
            new Date(start + 'T00:00:00Z')) / 86400000
        ) + 1
      : 0;
    const backupPeriodValid = days >= 1 && days <= 366;
    return {
      backupPeriodValid,
      preservedCurrentPeriod: !backupPeriodValid,
      periodStartDate: backupPeriodValid
        ? start
        : currentSettings.periodStartDate,
      periodEndDate: backupPeriodValid
        ? end
        : currentSettings.periodEndDate
    };
  }

  function summarizeState(source) {
    const records = hasStateSnapshot(source)
      ? normalizeState(source)
      : Array.from(indexRecords(asRecords(source)).values());
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
      },
      exactAmounts: {
        tripExpensesCents: '0',
        tripIncomesCents: '0',
        maintenanceCents: '0'
      },
      fuel: {
        structuredRecords: 0,
        legacyRecords: 0,
        totalVolumeMl: 0,
        structuredCostCents: 0,
        fingerprint: ''
      }
    };
    let expenseCents = 0;
    let incomeCents = 0;
    let maintenanceCents = 0;
    let exactExpenseCents = 0n;
    let exactIncomeCents = 0n;
    let exactMaintenanceCents = 0n;
    let fuelVolumeMl = 0;
    let structuredFuelCostCents = 0;
    const fuelFingerprints = [];

    records.forEach(item => {
      if (item.type === 'vehicle') summary.counts.vehicles++;
      else if (item.type === 'category') {
        if (item.data && item.data.kind === 'expense') summary.counts.expenseCategories++;
        if (item.data && item.data.kind === 'income') summary.counts.incomeCategories++;
      } else if (item.type === 'trip') summary.counts.trips++;
      else if (item.type === 'trip_expense') {
        summary.counts.tripExpenses++;
        const amountCents = amountInCents(item.data && item.data.amount);
        const amountCentsExact = exactAmountCents(item.data && item.data.amount);
        expenseCents += amountCents;
        exactExpenseCents += amountCentsExact;
        if (item.data && item.data.categoryId === 'fuel') {
          if (item.data.fuel === undefined) {
            summary.fuel.legacyRecords++;
          } else {
            const normalized = normalizeExpenseFuel(item.data, recordKey(item.type, item.id));
            const volumeMl = Number(scaledDecimal(
              normalized.fuel.liters, 3, 100000000n, 'fuel.liters', false
            ));
            summary.fuel.structuredRecords++;
            fuelVolumeMl += volumeMl;
            structuredFuelCostCents += amountCents;
            fuelFingerprints.push(
              recordKey(item.type, item.id) + '|' +
              String(normalized.tripId || '') + '|' +
              amountCentsExact.toString() + '|' +
              normalized.fuel.unitPrice + '|' + normalized.fuel.liters
            );
          }
        }
      } else if (item.type === 'trip_income') {
        summary.counts.tripIncomes++;
        const amountCents = amountInCents(item.data && item.data.amount);
        incomeCents += amountCents;
        exactIncomeCents += exactAmountCents(item.data && item.data.amount);
      } else if (item.type === 'maintenance') {
        summary.counts.maintenance++;
        const amountCents = amountInCents(item.data && item.data.amount);
        maintenanceCents += amountCents;
        exactMaintenanceCents += exactAmountCents(item.data && item.data.amount);
      }
    });
    summary.amounts.tripExpenses = expenseCents / 100;
    summary.amounts.tripIncomes = incomeCents / 100;
    summary.amounts.maintenance = maintenanceCents / 100;
    summary.exactAmounts.tripExpensesCents = exactExpenseCents.toString();
    summary.exactAmounts.tripIncomesCents = exactIncomeCents.toString();
    summary.exactAmounts.maintenanceCents = exactMaintenanceCents.toString();
    summary.fuel.totalVolumeMl = fuelVolumeMl;
    summary.fuel.structuredCostCents = structuredFuelCostCents;
    summary.fuel.fingerprint = snapshotFingerprint(fuelFingerprints.sort());
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
    ['counts', 'amounts', 'exactAmounts', 'fuel'].forEach(group => {
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

  function acknowledgementAmountCents(value, key) {
    const amount = typeof value === 'number'
      ? value
      : (typeof value === 'string' && value.trim() ? Number(value) : Number.NaN);
    const cents = Math.round(amount * 100);
    if (!Number.isFinite(amount) || amount < 0 || amount > 999999999.99 ||
        !Number.isSafeInteger(cents))
      throw new Error('云端回执金额无效：' + key);
    return cents;
  }

  function assertAppliedPutData(operation, resultData, key) {
    const expected = normalizeRecordData(operation.type, operation.id, operation.data);
    const actual = normalizeRecordData(operation.type, operation.id, resultData);
    if (operation.type === 'trip_expense' &&
        Object.prototype.hasOwnProperty.call(expected, 'fuel') !==
          Object.prototype.hasOwnProperty.call(actual, 'fuel'))
      throw new Error('云端回执改变了 fuel 是否存在：' + key);
    Object.keys(expected).forEach(field => {
      if (!Object.prototype.hasOwnProperty.call(actual, field))
        throw new Error('云端回执缺少已写入字段 ' + field + '：' + key);
      const equal = field === 'amount' &&
        ['trip_expense', 'trip_income', 'maintenance'].includes(operation.type)
        ? acknowledgementAmountCents(expected[field], key) ===
          acknowledgementAmountCents(actual[field], key)
        : canonical(expected[field]) === canonical(actual[field]);
      if (!equal)
        throw new Error('云端回执篡改了已写入字段 ' + field + '：' + key);
    });
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
        if (operation.op === 'put')
          assertAppliedPutData(operation, result.data, key);
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
        data: normalizeRecordData(operation.type, operation.id, result.data),
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

  function createOperationId(randomUUID) {
    const uuid = typeof randomUUID === 'function'
      ? randomUUID()
      : (typeof crypto !== 'undefined' && crypto &&
          typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : '');
    if (uuid) return 'write-' + String(uuid);
    const random = Math.random().toString(36).slice(2);
    return 'write-' + Date.now().toString(36) + '-' + random;
  }

  function strictPendingCacheDecision(cache, remote) {
    const inspection = inspectPendingCache(cache, remote);
    if (inspection.status === 'none') {
      return {
        status: 'discard',
        requiresExplicitAction: false,
        operations: [],
        conflicts: []
      };
    }
    if (inspection.status === 'safe') {
      return {
        status: 'confirm-upload',
        requiresExplicitAction: true,
        operations: inspection.operations,
        conflicts: []
      };
    }
    return {
      status: 'export-conflict',
      requiresExplicitAction: true,
      operations: inspection.operations,
      conflicts: inspection.conflicts
    };
  }

  function baselineSetting(baseline, field) {
    const setting = asRecords(baseline).find(item =>
      item.type === 'fleet_settings' && item.id === SETTINGS_ID
    );
    return setting && setting.data ? setting.data[field] : undefined;
  }

  function cloudBusinessState(state, baseline) {
    const result = clone(state);
    if (!result || !result.settings) return result;
    const remoteTheme = baselineSetting(baseline, 'theme');
    if (remoteTheme !== undefined) result.settings.theme = remoteTheme;
    return result;
  }

  function createOnlineCommitter(options) {
    const config = options || {};
    if (typeof config.requestSync !== 'function')
      throw new TypeError('在线提交器需要 requestSync');
    if (typeof config.bootstrap !== 'function')
      throw new TypeError('在线提交器需要 bootstrap');

    let committedState = clone(config.state);
    let baselineRecords = clone(asRecords(config.baselineRecords));
    let phase = config.online === false ? 'readonly' : 'online';
    let lastError = null;

    function status() {
      return {
        phase,
        writable: phase === 'online',
        saving: phase === 'saving',
        error: lastError
      };
    }

    function setPhase(next, error) {
      phase = next;
      lastError = error || null;
      if (typeof config.onStatus === 'function') config.onStatus(status());
    }

    function serverError(body, fallback) {
      const message = body && body.error && body.error.message
        ? body.error.message
        : fallback;
      const error = new Error(message || '云端没有确认这次保存');
      if (body && body.status) error.status = body.status;
      error.details = body;
      return error;
    }

    function validateAcknowledgement(operations, response) {
      if (!response || response.hasConflicts || response.hasRejected)
        throw serverError(response, '云端没有接受这次保存');
      return applySyncResults(
        baselineRecords,
        operations,
        response.results
      );
    }

    async function sendToken(token) {
      setPhase('saving');
      try {
        const response = await config.requestSync({
          operationId: token.operationId,
          operations: clone(token.operations),
          finalize: true
        });
        const nextBaseline = validateAcknowledgement(
          token.operations,
          response
        );
        baselineRecords = nextBaseline;
        committedState = clone(token.proposal);
        setPhase('online');
        return {
          ok: true,
          operationId: token.operationId,
          state: clone(committedState),
          baselineRecords: clone(baselineRecords),
          replayed: response.replayed === true
        };
      } catch (error) {
        const statusCode = Number(error && error.status);
        setPhase(
          statusCode === 401
            ? 'unauthenticated'
            : (statusCode === 409 ? 'conflict' : 'readonly'),
          error
        );
        return {
          ok: false,
          conflict: statusCode === 409,
          unauthenticated: statusCode === 401,
          readonly: statusCode !== 401,
          error,
          retryToken: clone(token)
        };
      }
    }

    return {
      get state() { return clone(committedState); },
      get baselineRecords() { return clone(baselineRecords); },
      get status() { return status(); },
      noteNavigatorOffline() {
        if (phase !== 'unauthenticated') setPhase('readonly');
        return status();
      },
      noteNavigatorOnline() {
        // navigator.onLine is only a hint. A real bootstrap is required before
        // write controls may be enabled again.
        return status();
      },
      async commit(proposal, operationId) {
        if (phase !== 'online') {
          return {
            ok: false,
            readonly: true,
            error: new Error('当前未连接云端，账本为只读')
          };
        }
        const cloudState = cloudBusinessState(proposal, baselineRecords);
        const operations = planSync(cloudState, baselineRecords);
        if (!operations.length) {
          committedState = clone(proposal);
          return {
            ok: true,
            unchanged: true,
            state: clone(committedState),
            baselineRecords: clone(baselineRecords)
          };
        }
        return sendToken({
          operationId: operationId || createOperationId(config.randomUUID),
          operations,
          proposal: clone(proposal)
        });
      },
      async retry(retryToken) {
        if (!retryToken || !retryToken.operationId ||
            !Array.isArray(retryToken.operations) || !retryToken.proposal)
          throw new TypeError('缺少完整的显式重试令牌');
        if (phase === 'saving')
          return { ok: false, busy: true, error: new Error('正在保存') };
        return sendToken(clone(retryToken));
      },
      async recover() {
        if (phase === 'saving')
          return { ok: false, busy: true, error: new Error('正在保存') };
        setPhase('checking');
        try {
          const remote = await config.bootstrap();
          const records = clone(asRecords(remote));
          const state = recordsToState(
            records,
            typeof config.fallbackState === 'function'
              ? config.fallbackState()
              : config.fallbackState
          );
          baselineRecords = records;
          committedState = state;
          setPhase('online');
          return {
            ok: true,
            state: clone(committedState),
            baselineRecords: clone(baselineRecords)
          };
        } catch (error) {
          const statusCode = Number(error && error.status);
          setPhase(
            statusCode === 401 ? 'unauthenticated' : 'readonly',
            error
          );
          return {
            ok: false,
            unauthenticated: statusCode === 401,
            readonly: statusCode !== 401,
            error
          };
        }
      }
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
    inspectImportPeriod,
    compareSummaries,
    compareConservation: compareSummaries,
    inspectPendingCache,
    applySyncResults,
    mergeRemoteState,
    compareMigrationTarget,
    snapshotFingerprint,
    createOperationId,
    strictPendingCacheDecision,
    cloudBusinessState,
    createOnlineCommitter
  };
});
