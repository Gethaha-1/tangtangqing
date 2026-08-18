(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TTQDomain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 3;
  const LEGACY_VEHICLE_ID = 'vehicle_legacy';
  const MAX_AMOUNT_CENTS = 99999999999n;
  const MAX_UNIT_PRICE_X10000 = 9999999n;
  const MAX_VOLUME_ML = 100000000n;

  function localDateString(date) {
    const d = date || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function defaultPeriod(now) {
    const d = now || new Date();
    const y = d.getFullYear();
    return { start: y + '-01-01', end: y + '-12-31' };
  }

  function isDateString(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1000 || month < 1 || month > 12 || day < 1) return false;
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day;
  }

  function isInRange(date, start, end) {
    return !!date && !!start && !!end && date >= start && date <= end;
  }

  function periodDays(start, end) {
    if (!isDateString(start) || !isDateString(end) || end < start) return 0;
    return Math.round((new Date(end + 'T00:00:00') - new Date(start + 'T00:00:00')) / 86400000) + 1;
  }

  function legacyVehicle() {
    return {
      id: LEGACY_VEHICLE_ID,
      name: '原有车辆',
      plateNo: '',
      active: true,
      createdAt: '2026-01-01T00:00:00.000Z'
    };
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function decimalText(value) {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null;
      value = String(value);
    } else if (typeof value !== 'string') {
      return null;
    }

    const text = value.trim();
    const exponential = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))[eE]([+-]?\d+)$/.exec(text);
    if (!exponential) return text;

    const sign = exponential[1];
    const integer = exponential[2] || '0';
    const fraction = (exponential[3] !== undefined ? exponential[3] : exponential[4]) || '';
    const exponent = Number(exponential[5]);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;

    const digits = integer + fraction;
    const point = integer.length + exponent;
    if (point <= 0) return sign + '0.' + '0'.repeat(-point) + digits;
    if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length);
    return sign + digits.slice(0, point) + '.' + digits.slice(point);
  }

  function decimalToUnits(value, scale) {
    const text = decimalText(value);
    const match = text && /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(text);
    if (!match) return null;

    const negative = match[1] === '-';
    const integer = match[2] || '0';
    const fraction = (match[3] !== undefined ? match[3] : match[4]) || '';
    const kept = (fraction.slice(0, scale) + '0'.repeat(scale)).slice(0, scale);
    let units = BigInt(integer) * (10n ** BigInt(scale)) + BigInt(kept || '0');
    if (fraction.length > scale && Number(fraction[scale]) >= 5) units += 1n;
    return negative ? -units : units;
  }

  function unitsToFixed(units, scale) {
    const negative = units < 0n;
    const absolute = negative ? -units : units;
    const factor = 10n ** BigInt(scale);
    const integer = absolute / factor;
    const fraction = String(absolute % factor).padStart(scale, '0');
    return (negative ? '-' : '') + integer + (scale ? '.' + fraction : '');
  }

  function unitsToNumber(units, scale) {
    return Number(unitsToFixed(units, scale));
  }

  function unitsToCanonical(units, scale) {
    const fixed = unitsToFixed(units, scale);
    if (!scale) return fixed;
    return fixed.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  }

  function amountUnits(value) {
    return decimalToUnits(value, 2) || 0n;
  }

  function cleanAmount(value) {
    return unitsToNumber(amountUnits(value), 2);
  }

  function migrationAmount(value, field) {
    const units = decimalToUnits(value, 2);
    if (units === null || units < 0n || units > MAX_AMOUNT_CENTS) {
      throw new Error((field || '金额') + ' 无效或超出支持范围');
    }
    return unitsToNumber(units, 2);
  }

  function roundQuotient(numerator, denominator) {
    if (denominator <= 0n) return null;
    return (numerator + denominator / 2n) / denominator;
  }

  function strictFuelUnits(value, scale) {
    let text;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return { error: 'invalid-number' };
      text = String(value);
    } else if (typeof value === 'string') {
      text = value.trim();
    } else {
      return { error: 'invalid-number' };
    }
    if (/[eE]/.test(text)) return { error: 'exponent-not-allowed' };
    const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(text);
    if (!match) return { error: 'invalid-number' };
    const fraction = (match[3] !== undefined ? match[3] : match[4]) || '';
    if (fraction.length > scale) return { error: 'too-many-decimals' };
    return { units: decimalToUnits(text, scale) };
  }

  function fuelConsistencyToleranceCents(unitPrice, liters) {
    const price = strictFuelUnits(unitPrice, 4);
    const volume = strictFuelUnits(liters, 3);
    if (price.error || volume.error ||
        price.units <= 0n || volume.units <= 0n ||
        price.units > MAX_UNIT_PRICE_X10000 || volume.units > MAX_VOLUME_ML) return null;
    return 1;
  }

  function fuelFailure(code, field) {
    const messages = {
      'need-two-fields': '请至少填写油费总价、油品单价、加油升数中的任意两项',
      'invalid-number': '请输入整数或普通十进制数',
      'exponent-not-allowed': '油费数值不接受指数形式',
      'too-many-decimals': '油费数值的小数位超过支持精度',
      'must-be-positive': '油费数值必须大于零',
      'out-of-range': '油费数值超出支持范围',
      'inconsistent': '油费总价、单价和升数不一致',
      'precision-loss': '这组数在当前精度下无法保持一致，请调整输入组合',
      'calculated-too-small': '根据已填数值计算出的结果低于支持的最小精度'
    };
    return { ok: false, error: { code, field: field || null, message: messages[code] } };
  }

  /**
   * Resolve any two of totalAmount (yuan), unitPrice (yuan/litre), and liters.
   * Fixed-point strings are returned so callers can persist or display the result
   * without introducing binary floating-point multiplication drift.
   */
  function calculateFuelFields(fields) {
    const input = fields || {};
    const raw = {
      totalAmount: input.totalAmount,
      unitPrice: input.unitPrice,
      liters: input.liters
    };
    const scales = { totalAmount: 2, unitPrice: 4, liters: 3 };
    const present = Object.keys(raw).filter(key => raw[key] !== '' && raw[key] !== null && raw[key] !== undefined);
    if (present.length < 2) return fuelFailure('need-two-fields');

    const values = {};
    for (const key of present) {
      const parsed = strictFuelUnits(raw[key], scales[key]);
      if (parsed.error) return fuelFailure(parsed.error, key);
      const units = parsed.units;
      if (units <= 0n) return fuelFailure('must-be-positive', key);
      const maximum = key === 'totalAmount'
        ? MAX_AMOUNT_CENTS
        : key === 'unitPrice' ? MAX_UNIT_PRICE_X10000 : MAX_VOLUME_ML;
      if (units > maximum) return fuelFailure('out-of-range', key);
      values[key] = units;
    }

    const missing = Object.keys(raw).find(key => !present.includes(key)) || null;
    if (missing === 'totalAmount') {
      values.totalAmount = roundQuotient(values.unitPrice * values.liters, 100000n);
    } else if (missing === 'liters') {
      values.liters = roundQuotient(values.totalAmount * 100000n, values.unitPrice);
    } else if (missing === 'unitPrice') {
      values.unitPrice = roundQuotient(values.totalAmount * 100000n, values.liters);
    }

    if (missing && values[missing] <= 0n) return fuelFailure('calculated-too-small', missing);
    const calculatedMaximum = missing === 'totalAmount'
      ? MAX_AMOUNT_CENTS
      : missing === 'unitPrice' ? MAX_UNIT_PRICE_X10000 : MAX_VOLUME_ML;
    if (missing && values[missing] > calculatedMaximum) return fuelFailure('out-of-range', missing);

    const expectedTotal = roundQuotient(values.unitPrice * values.liters, 100000n);
    const difference = values.totalAmount > expectedTotal
      ? values.totalAmount - expectedTotal
      : expectedTotal - values.totalAmount;
    const tolerance = 1n;
    if (difference > tolerance) {
      const failure = fuelFailure(missing ? 'precision-loss' : 'inconsistent', missing || 'totalAmount');
      failure.error.differenceCents = difference.toString();
      failure.error.toleranceCents = tolerance.toString();
      return failure;
    }

    return {
      ok: true,
      // Canonical values are for storage/sync; formatted values are for editing UI.
      totalAmount: unitsToCanonical(values.totalAmount, 2),
      unitPrice: unitsToCanonical(values.unitPrice, 4),
      liters: unitsToCanonical(values.liters, 3),
      formatted: {
        totalAmount: unitsToFixed(values.totalAmount, 2),
        unitPrice: unitsToFixed(values.unitPrice, 4),
        liters: unitsToFixed(values.liters, 3)
      },
      calculatedField: missing,
      differenceCents: difference.toString(),
      toleranceCents: tolerance.toString()
    };
  }

  function migrate(input, base) {
    if (!input || typeof input !== 'object') return clone(base);
    const d = clone(input);
    const fallback = clone(base);
    const oldVersion = d.schemaVersion || 1;

    d.settings = Object.assign({}, fallback.settings, d.settings || {});
    const ownerRecordsWritable = d.settings._ownerRecordsWritable !== false;
    d.categories = d.categories || fallback.categories;
    d.trips = Array.isArray(d.trips) ? d.trips : [];
    d.maintenance = Array.isArray(d.maintenance) ? d.maintenance : [];
    d.vehicles = (Array.isArray(d.vehicles) && d.vehicles.length
      ? d.vehicles
      : (ownerRecordsWritable ? [legacyVehicle()] : []))
      .map((v, index) => ({
        id: String(v.id || ('vehicle_' + index)),
        name: String(v.name || ('车辆 ' + (index + 1))),
        plateNo: String(v.plateNo || ''),
        active: v.active !== false,
        createdAt: v.createdAt || new Date().toISOString()
      }));

    if (oldVersion < 2) {
      d.trips.forEach(t => {
        if (!t.vehicleId && ownerRecordsWritable) t.vehicleId = LEGACY_VEHICLE_ID;
      });
      d.maintenance.forEach(m => {
        if (!m.vehicleId && ownerRecordsWritable) m.vehicleId = LEGACY_VEHICLE_ID;
      });
    }

    const validVehicleIds = new Set(d.vehicles.map(v => v.id));
    const fallbackVehicleId = d.vehicles[0] && d.vehicles[0].id;
    d.trips.forEach(t => {
      if (!validVehicleIds.has(t.vehicleId)) {
        if (!ownerRecordsWritable)
          throw new Error('司机同步数据包含不可见车辆');
        t.vehicleId = fallbackVehicleId;
      }
      t.expenses = (t.expenses || []).map(e => {
        const originalAmount = e.amount;
        const normalizedAmount = migrationAmount(originalAmount, '支出金额');
        if (Object.prototype.hasOwnProperty.call(e, 'fuel')) {
          if (e.catId !== 'fuel' || !e.fuel || typeof e.fuel !== 'object' || Array.isArray(e.fuel) ||
              Object.keys(e.fuel).some(key => key !== 'unitPrice' && key !== 'liters') ||
              !Object.prototype.hasOwnProperty.call(e.fuel, 'unitPrice') ||
              !Object.prototype.hasOwnProperty.call(e.fuel, 'liters')) {
            throw new Error('备份包含无效 fuel 元数据');
          }
          const resolved = calculateFuelFields({
            totalAmount: originalAmount,
            unitPrice: e.fuel.unitPrice,
            liters: e.fuel.liters
          });
          if (!resolved.ok) throw new Error('备份包含无效 fuel 元数据：' + resolved.error.message);
          e.fuel = { unitPrice: resolved.unitPrice, liters: resolved.liters };
        }
        e.amount = normalizedAmount;
        return e;
      });
      t.incomes = (t.incomes || []).map(e => Object.assign(e, {
        amount: migrationAmount(e.amount, '收入金额')
      }));
    });
    d.maintenance.forEach(m => {
      if (!validVehicleIds.has(m.vehicleId)) {
        if (!ownerRecordsWritable)
          throw new Error('司机同步数据包含不可见车辆');
        m.vehicleId = fallbackVehicleId;
      }
      m.amount = migrationAmount(m.amount, '维修金额');
    });

    const period = defaultPeriod();
    if (!isDateString(d.settings.periodStartDate) ||
        !isDateString(d.settings.periodEndDate) ||
        d.settings.periodEndDate < d.settings.periodStartDate) {
      d.settings.periodStartDate = period.start;
      d.settings.periodEndDate = period.end;
    }
    if (!ownerRecordsWritable)
      d.settings.activeVehicleId = 'all';
    else if (d.settings.activeVehicleId !== 'all' && !validVehicleIds.has(d.settings.activeVehicleId))
      d.settings.activeVehicleId = 'all';

    d.schemaVersion = SCHEMA_VERSION;
    return d;
  }

  function tripDate(trip) {
    return trip.status === 'closed' && trip.endDate ? trip.endDate : trip.startDate;
  }

  function tripTieKey(trip) {
    return [
      tripDate(trip) || '',
      trip.closedAt || '',
      trip.createdAt || '',
      trip.id || ''
    ].join('|');
  }

  function compareTripsAsc(a, b) {
    return tripTieKey(a).localeCompare(tripTieKey(b));
  }

  function compareTripsDesc(a, b) {
    return compareTripsAsc(b, a);
  }

  function matchesVehicle(record, vehicleId) {
    return vehicleId === 'all' || record.vehicleId === vehicleId;
  }

  function tripsInPeriod(state, start, end, vehicleId, includeOpenOutsidePeriod) {
    return state.trips.filter(t => {
      if (!matchesVehicle(t, vehicleId === undefined || vehicleId === null ? 'all' : vehicleId)) return false;
      if (includeOpenOutsidePeriod && t.status === 'open') return true;
      return isInRange(tripDate(t), start, end);
    });
  }

  function closedTripsInPeriod(state, start, end, vehicleId) {
    return state.trips.filter(t =>
      t.status === 'closed' &&
      isInRange(t.endDate, start, end) &&
      matchesVehicle(t, vehicleId === undefined || vehicleId === null ? 'all' : vehicleId)
    );
  }

  function maintenanceInPeriod(state, start, end, vehicleId) {
    return state.maintenance.filter(m =>
      isInRange(m.date, start, end) &&
      matchesVehicle(m, vehicleId === undefined || vehicleId === null ? 'all' : vehicleId)
    );
  }

  function tripTotals(trip) {
    const expUnits = (trip.expenses || []).reduce((sum, entry) => sum + amountUnits(entry.amount), 0n);
    const incUnits = (trip.incomes || []).reduce((sum, entry) => sum + amountUnits(entry.amount), 0n);
    return {
      exp: unitsToNumber(expUnits, 2),
      inc: unitsToNumber(incUnits, 2),
      profit: unitsToNumber(incUnits - expUnits, 2)
    };
  }

  function tripSeq(state, trip, start, end) {
    const list = tripsInPeriod(state, start, end, trip.vehicleId || LEGACY_VEHICLE_ID, false)
      .slice()
      .sort(compareTripsAsc);
    return list.findIndex(item => item.id === trip.id) + 1;
  }

  function periodStatsUnits(state, start, end, vehicleId) {
    const trips = closedTripsInPeriod(state, start, end, vehicleId);
    let incUnits = 0n;
    let expUnits = 0n;
    trips.forEach(t => {
      incUnits += (t.incomes || []).reduce((sum, entry) => sum + amountUnits(entry.amount), 0n);
      expUnits += (t.expenses || []).reduce((sum, entry) => sum + amountUnits(entry.amount), 0n);
    });
    const maintenanceUnits = maintenanceInPeriod(state, start, end, vehicleId)
      .reduce((sum, item) => sum + amountUnits(item.amount), 0n);
    return {
      count: trips.length,
      incUnits,
      expUnits,
      tripProfitUnits: incUnits - expUnits,
      maintenanceUnits,
      netProfitUnits: incUnits - expUnits - maintenanceUnits
    };
  }

  function periodStats(state, start, end, vehicleId) {
    const fixed = periodStatsUnits(state, start, end, vehicleId);
    const tripProfitUnits = fixed.tripProfitUnits;
    const maintenanceUnits = fixed.maintenanceUnits;
    const inc = unitsToNumber(fixed.incUnits, 2);
    const exp = unitsToNumber(fixed.expUnits, 2);
    const tripProfit = unitsToNumber(tripProfitUnits, 2);
    const maintenance = unitsToNumber(maintenanceUnits, 2);
    return {
      count: fixed.count,
      inc,
      exp,
      // Backward-compatible aliases: profit has always meant trip-only profit.
      profit: tripProfit,
      maint: maintenance,
      tripProfit,
      maintenance,
      netProfit: unitsToNumber(fixed.netProfitUnits, 2)
    };
  }

  function monthKeys(start, end) {
    if (!isDateString(start) || !isDateString(end) || end < start) return [];
    const keys = [];
    const cursor = new Date(start.slice(0, 7) + '-01T00:00:00');
    const last = end.slice(0, 7);
    while (localDateString(cursor).slice(0, 7) <= last && keys.length < 24) {
      keys.push(localDateString(cursor).slice(0, 7));
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return keys;
  }

  function monthProfits(state, start, end, vehicleId) {
    const keys = monthKeys(start, end);
    const valueUnits = new Array(keys.length).fill(0n);
    closedTripsInPeriod(state, start, end, vehicleId).forEach(t => {
      const index = keys.indexOf(t.endDate.slice(0, 7));
      if (index >= 0) {
        const income = (t.incomes || []).reduce((sum, entry) => sum + amountUnits(entry.amount), 0n);
        const expense = (t.expenses || []).reduce((sum, entry) => sum + amountUnits(entry.amount), 0n);
        valueUnits[index] += income - expense;
      }
    });
    return { keys, values: valueUnits.map(value => unitsToNumber(value, 2)) };
  }

  function reportScope(state, input) {
    const options = input || {};
    let kind = 'period';
    let start = options.start;
    let end = options.end;

    if (options.month !== undefined) {
      const month = String(options.month);
      if (!/^\d{4}-\d{2}$/.test(month)) throw new RangeError('month must use YYYY-MM');
      const yearNumber = Number(month.slice(0, 4));
      const monthNumber = Number(month.slice(5, 7));
      if (yearNumber < 1000 || monthNumber < 1 || monthNumber > 12) {
        throw new RangeError('month must use YYYY-MM with year 1000-9999');
      }
      const lastDay = new Date(Date.UTC(yearNumber, monthNumber, 0)).getUTCDate();
      const naturalStart = month + '-01';
      const naturalEnd = month + '-' + String(lastDay).padStart(2, '0');
      const periodStart = state.settings && state.settings.periodStartDate;
      const periodEnd = state.settings && state.settings.periodEndDate;
      if (!isDateString(periodStart) || !isDateString(periodEnd) || periodEnd < periodStart) {
        throw new RangeError('month reports require a valid current accounting period');
      }
      start = naturalStart > periodStart ? naturalStart : periodStart;
      end = naturalEnd < periodEnd ? naturalEnd : periodEnd;
      kind = 'month';
    } else if (options.year !== undefined) {
      const year = String(options.year);
      if (!/^\d{4}$/.test(year) || Number(year) < 1000) {
        throw new RangeError('year must use YYYY with year 1000-9999');
      }
      start = year + '-01-01';
      end = year + '-12-31';
      kind = 'year';
    } else {
      start = start || (state.settings && state.settings.periodStartDate);
      end = end || (state.settings && state.settings.periodEndDate);
    }

    if (!isDateString(start) || !isDateString(end) || (kind !== 'month' && end < start)) {
      throw new RangeError('report scope requires a valid start and end date');
    }
    const hasVehicleId = Object.prototype.hasOwnProperty.call(options, 'vehicleId');
    const vehicleId = hasVehicleId
      ? String(options.vehicleId === null || options.vehicleId === undefined ? '' : options.vehicleId)
      : (state.settings && state.settings.activeVehicleId) || 'all';
    return {
      kind,
      start,
      end,
      empty: end < start,
      vehicleId,
      vehicle: vehicleId === 'all'
        ? { kind: 'all' }
        : { kind: 'single', vehicleId },
      tripBasis: 'closed.endDate',
      maintenanceBasis: 'maintenance.date',
      fuelBasis: 'parentClosedTrip.endDate'
    };
  }

  function toSafeInteger(units, field) {
    const result = Number(units);
    if (!Number.isSafeInteger(result)) throw new RangeError(field + ' exceeds safe integer range');
    return result;
  }

  function newFuelAccumulator() {
    return {
      totalCostUnits: 0n,
      structuredCostUnits: 0n,
      litersUnits: 0n,
      minPriceUnits: null,
      maxPriceUnits: null,
      totalRecords: 0,
      structuredRecords: 0,
      legacyRecords: 0
    };
  }

  function addFuelRecord(accumulator, expense) {
    const costUnits = amountUnits(expense.amount);
    accumulator.totalCostUnits += costUnits;
    accumulator.totalRecords += 1;

    const fuel = expense.fuel;
    const resolved = fuel && calculateFuelFields({
      totalAmount: expense.amount,
      unitPrice: fuel.unitPrice,
      liters: fuel.liters
    });
    if (!resolved || !resolved.ok) {
      accumulator.legacyRecords += 1;
      return;
    }

    const litersUnits = decimalToUnits(resolved.liters, 3);
    // Use the record's effective total/volume price for extrema so a one-record
    // weighted average can never sit outside its own minimum/maximum range.
    const priceUnits = roundQuotient(costUnits * 100000n, litersUnits);
    accumulator.structuredCostUnits += costUnits;
    accumulator.litersUnits += litersUnits;
    accumulator.structuredRecords += 1;
    if (accumulator.minPriceUnits === null || priceUnits < accumulator.minPriceUnits) {
      accumulator.minPriceUnits = priceUnits;
    }
    if (accumulator.maxPriceUnits === null || priceUnits > accumulator.maxPriceUnits) {
      accumulator.maxPriceUnits = priceUnits;
    }
  }

  function fuelWarning(legacyRecords) {
    if (!legacyRecords) return null;
    return '有 ' + legacyRecords + ' 条油费缺少或含无效 fuel 元数据；总费用已计入，但升数与油价统计未包含这些记录。';
  }

  function finishFuelAccumulator(accumulator) {
    const averagePriceUnits = accumulator.litersUnits > 0n
      ? roundQuotient(accumulator.structuredCostUnits * 100000n, accumulator.litersUnits)
      : null;
    const legacyCostUnits = accumulator.totalCostUnits - accumulator.structuredCostUnits;
    const warning = fuelWarning(accumulator.legacyRecords);
    const warnings = warning ? [{
      code: 'fuel-coverage-incomplete',
      message: warning,
      legacyRecords: accumulator.legacyRecords
    }] : [];
    return {
      totalCostCents: toSafeInteger(accumulator.totalCostUnits, 'totalCostCents'),
      structuredCostCents: toSafeInteger(accumulator.structuredCostUnits, 'structuredCostCents'),
      volumeMl: toSafeInteger(accumulator.litersUnits, 'volumeMl'),
      weightedUnitPriceX10000: averagePriceUnits === null
        ? null
        : toSafeInteger(averagePriceUnits, 'weightedUnitPriceX10000'),
      minUnitPriceX10000: accumulator.minPriceUnits === null
        ? null
        : toSafeInteger(accumulator.minPriceUnits, 'minUnitPriceX10000'),
      maxUnitPriceX10000: accumulator.maxPriceUnits === null
        ? null
        : toSafeInteger(accumulator.maxPriceUnits, 'maxUnitPriceX10000'),
      legacyCostCents: toSafeInteger(legacyCostUnits, 'legacyCostCents'),
      coverage: {
        totalRecords: accumulator.totalRecords,
        structuredRecords: accumulator.structuredRecords,
        legacyRecords: accumulator.legacyRecords,
        structuredCostCents: toSafeInteger(accumulator.structuredCostUnits, 'coverage.structuredCostCents'),
        legacyCostCents: toSafeInteger(legacyCostUnits, 'coverage.legacyCostCents'),
        litersCoverageComplete: accumulator.legacyRecords === 0,
        warning
      },
      warnings,
      legacyCoverageWarning: warning,
      display: {
        totalCost: unitsToNumber(accumulator.totalCostUnits, 2),
        structuredCost: unitsToNumber(accumulator.structuredCostUnits, 2),
        totalLiters: unitsToNumber(accumulator.litersUnits, 3),
        weightedAverageUnitPrice: averagePriceUnits === null ? null : unitsToNumber(averagePriceUnits, 4),
        minimumUnitPrice: accumulator.minPriceUnits === null ? null : unitsToNumber(accumulator.minPriceUnits, 4),
        maximumUnitPrice: accumulator.maxPriceUnits === null ? null : unitsToNumber(accumulator.maxPriceUnits, 4),
        legacyCost: unitsToNumber(legacyCostUnits, 2)
      }
    };
  }

  function buildReportSummary(state, input) {
    const scope = reportScope(state, input);
    const fixedStats = periodStatsUnits(state, scope.start, scope.end, scope.vehicleId);
    const overallFuel = newFuelAccumulator();
    const trendBuckets = new Map();
    const vehicleBuckets = new Map();
    const vehicles = new Map((state.vehicles || []).map(vehicle => [vehicle.id, vehicle]));
    const scopedVehicles = scope.vehicleId === 'all'
      ? (state.vehicles || [])
      : [(state.vehicles || []).find(vehicle => vehicle.id === scope.vehicleId) || {
          id: scope.vehicleId,
          name: ''
        }];
    scopedVehicles.forEach(vehicle => vehicleBuckets.set(vehicle.id, newFuelAccumulator()));

    closedTripsInPeriod(state, scope.start, scope.end, scope.vehicleId).forEach(trip => {
      const bucketKey = trip.endDate.slice(0, 7);
      (trip.expenses || []).filter(expense => expense.catId === 'fuel').forEach(expense => {
        if (!trendBuckets.has(bucketKey)) trendBuckets.set(bucketKey, newFuelAccumulator());
        if (!vehicleBuckets.has(trip.vehicleId)) vehicleBuckets.set(trip.vehicleId, newFuelAccumulator());
        addFuelRecord(overallFuel, expense);
        addFuelRecord(trendBuckets.get(bucketKey), expense);
        addFuelRecord(vehicleBuckets.get(trip.vehicleId), expense);
      });
    });

    const fuel = finishFuelAccumulator(overallFuel);
    fuel.trend = Array.from(trendBuckets.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([period, accumulator]) => Object.assign({ period }, finishFuelAccumulator(accumulator)));
    fuel.byVehicle = Array.from(vehicleBuckets.entries()).map(([vehicleId, accumulator]) => {
      const vehicle = vehicles.get(vehicleId);
      return Object.assign({ vehicleId, vehicleName: vehicle ? vehicle.name : '' }, finishFuelAccumulator(accumulator));
    });

    return {
      contractVersion: 1,
      scope,
      financial: {
        tripCount: fixedStats.count,
        incomeCents: toSafeInteger(fixedStats.incUnits, 'incomeCents'),
        tripExpenseCents: toSafeInteger(fixedStats.expUnits, 'tripExpenseCents'),
        tripProfitCents: toSafeInteger(fixedStats.tripProfitUnits, 'tripProfitCents'),
        maintenanceCents: toSafeInteger(fixedStats.maintenanceUnits, 'maintenanceCents'),
        netProfitCents: toSafeInteger(fixedStats.netProfitUnits, 'netProfitCents'),
        display: {
          income: unitsToNumber(fixedStats.incUnits, 2),
          tripExpenses: unitsToNumber(fixedStats.expUnits, 2),
          tripProfit: unitsToNumber(fixedStats.tripProfitUnits, 2),
          maintenance: unitsToNumber(fixedStats.maintenanceUnits, 2),
          netProfit: unitsToNumber(fixedStats.netProfitUnits, 2)
        }
      },
      fuel,
      warnings: fuel.warnings.slice()
    };
  }

  return {
    SCHEMA_VERSION,
    LEGACY_VEHICLE_ID,
    defaultPeriod,
    isDateString,
    isInRange,
    periodDays,
    legacyVehicle,
    cleanAmount,
    calculateFuelFields,
    fuelConsistencyToleranceCents,
    migrate,
    tripDate,
    compareTripsAsc,
    compareTripsDesc,
    tripsInPeriod,
    closedTripsInPeriod,
    maintenanceInPeriod,
    tripTotals,
    tripSeq,
    periodStats,
    monthKeys,
    monthProfits,
    buildReportSummary
  };
});
