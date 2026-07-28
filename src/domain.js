(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TTQDomain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SCHEMA_VERSION = 2;
  const LEGACY_VEHICLE_ID = 'vehicle_legacy';

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
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
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

  function cleanAmount(value) {
    const n = typeof value === 'number' ? value : parseFloat(value);
    return isNaN(n) ? 0 : Math.round(n * 100) / 100;
  }

  function migrate(input, base) {
    if (!input || typeof input !== 'object') return clone(base);
    const d = clone(input);
    const fallback = clone(base);
    const oldVersion = d.schemaVersion || 1;

    d.settings = Object.assign({}, fallback.settings, d.settings || {});
    d.categories = d.categories || fallback.categories;
    d.trips = Array.isArray(d.trips) ? d.trips : [];
    d.maintenance = Array.isArray(d.maintenance) ? d.maintenance : [];
    d.vehicles = (Array.isArray(d.vehicles) && d.vehicles.length ? d.vehicles : [legacyVehicle()])
      .map((v, index) => ({
        id: String(v.id || ('vehicle_' + index)),
        name: String(v.name || ('车辆 ' + (index + 1))),
        plateNo: String(v.plateNo || ''),
        active: v.active !== false,
        createdAt: v.createdAt || new Date().toISOString()
      }));

    if (oldVersion < 2) {
      d.trips.forEach(t => { if (!t.vehicleId) t.vehicleId = LEGACY_VEHICLE_ID; });
      d.maintenance.forEach(m => { if (!m.vehicleId) m.vehicleId = LEGACY_VEHICLE_ID; });
    }

    const validVehicleIds = new Set(d.vehicles.map(v => v.id));
    const fallbackVehicleId = d.vehicles[0].id;
    d.trips.forEach(t => {
      if (!validVehicleIds.has(t.vehicleId)) t.vehicleId = fallbackVehicleId;
      t.expenses = (t.expenses || []).map(e => Object.assign(e, { amount: cleanAmount(e.amount) }));
      t.incomes = (t.incomes || []).map(e => Object.assign(e, { amount: cleanAmount(e.amount) }));
    });
    d.maintenance.forEach(m => {
      if (!validVehicleIds.has(m.vehicleId)) m.vehicleId = fallbackVehicleId;
      m.amount = cleanAmount(m.amount);
    });

    const period = defaultPeriod();
    if (!isDateString(d.settings.periodStartDate) ||
        !isDateString(d.settings.periodEndDate) ||
        d.settings.periodEndDate < d.settings.periodStartDate) {
      d.settings.periodStartDate = period.start;
      d.settings.periodEndDate = period.end;
    }
    if (d.settings.activeVehicleId !== 'all' && !validVehicleIds.has(d.settings.activeVehicleId))
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
      if (!matchesVehicle(t, vehicleId || 'all')) return false;
      if (includeOpenOutsidePeriod && t.status === 'open') return true;
      return isInRange(tripDate(t), start, end);
    });
  }

  function closedTripsInPeriod(state, start, end, vehicleId) {
    return state.trips.filter(t =>
      t.status === 'closed' &&
      isInRange(t.endDate, start, end) &&
      matchesVehicle(t, vehicleId || 'all')
    );
  }

  function maintenanceInPeriod(state, start, end, vehicleId) {
    return state.maintenance.filter(m =>
      isInRange(m.date, start, end) &&
      matchesVehicle(m, vehicleId || 'all')
    );
  }

  function tripTotals(trip) {
    const exp = (trip.expenses || []).reduce((sum, entry) => sum + cleanAmount(entry.amount), 0);
    const inc = (trip.incomes || []).reduce((sum, entry) => sum + cleanAmount(entry.amount), 0);
    return { exp, inc, profit: inc - exp };
  }

  function tripSeq(state, trip, start, end) {
    const list = tripsInPeriod(state, start, end, trip.vehicleId || LEGACY_VEHICLE_ID, false)
      .slice()
      .sort(compareTripsAsc);
    return list.findIndex(item => item.id === trip.id) + 1;
  }

  function periodStats(state, start, end, vehicleId) {
    const trips = closedTripsInPeriod(state, start, end, vehicleId);
    let inc = 0;
    let exp = 0;
    trips.forEach(t => {
      const totals = tripTotals(t);
      inc += totals.inc;
      exp += totals.exp;
    });
    const maint = maintenanceInPeriod(state, start, end, vehicleId)
      .reduce((sum, item) => sum + cleanAmount(item.amount), 0);
    return { count: trips.length, inc, exp, profit: inc - exp, maint };
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
    const values = new Array(keys.length).fill(0);
    closedTripsInPeriod(state, start, end, vehicleId).forEach(t => {
      const index = keys.indexOf(t.endDate.slice(0, 7));
      if (index >= 0) values[index] += tripTotals(t).profit;
    });
    return { keys, values };
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
    monthProfits
  };
});
