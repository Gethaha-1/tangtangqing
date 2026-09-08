import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/location-client.js';
import '../src/domain.js';
import '../src/cloud-sync.js';
import { normalizeBusinessSettingsData, normalizeTripBusinessData } from '../lib/server/sync-contract.ts';
import { withSecurityHeaders } from '../lib/server/http-security.ts';

const L = globalThis.TTQLocation;
const D = globalThis.TTQDomain;
const cityData = { countryCode: 'CN', lookupSource: 'coordinates', city: '济南市', localityInfo: { administrative: [
  { name: '山东省', chinaAdminCode: '370000', adminLevel: 4 },
  { name: '济南市', chinaAdminCode: '370100', adminLevel: 5 },
  { name: '历城区', chinaAdminCode: '370112', adminLevel: 6 },
  { name: '某街道', adminLevel: 8 },
] } };

test('位置解析按行政区划区分地级市、县级市和直辖市，不把街道当区县', () => {
  assert.deepEqual(L.addressFromResponse(cityData), { city: '济南市', county: '历城区' });
  assert.deepEqual(L.addressFromResponse({ ...cityData, localityInfo: { administrative: [
    { name: '德州市', chinaAdminCode: '371400' }, { name: '乐陵市', chinaAdminCode: '371481' }
  ] } }), { city: '德州市', county: '乐陵市' });
  assert.deepEqual(L.addressFromResponse({ ...cityData, localityInfo: { administrative: [
    { name: '北京市', chinaAdminCode: '110000' }, { name: '朝阳区', chinaAdminCode: '110105' }
  ] } }), { city: '北京市', county: '朝阳区' });
  assert.deepEqual(L.addressFromResponse({ countryCode: 'CN', city: '济南市', locality: '某街道' }), { city: '济南市', county: '' });
  assert.throws(() => L.addressFromResponse({ ...cityData, lookupSource: 'ipGeolocation' }), /GPS/);
});

test('地址查询只用本次设备 GPS、无密钥/账号/cookie，拒绝定位时不请求第三方', async () => {
  let calls = 0;
  const result = await L.currentAddress({
    geolocation: { getCurrentPosition(resolve, _reject, options) {
      assert.equal(options.maximumAge, 0);
      resolve({ coords: { latitude: 36.6, longitude: 117.1 } });
    } },
    fetch: async (url, options) => {
      calls++;
      assert.equal(new URL(url).searchParams.get('localityLanguage'), 'zh');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.referrerPolicy, 'no-referrer');
      return Response.json(cityData);
    }
  });
  assert.equal(result.county, '历城区');
  assert.equal(calls, 1);
  await assert.rejects(L.currentAddress({ geolocation: { getCurrentPosition(_resolve, reject) { reject(new Error('denied')); } }, fetch: async () => { calls++; } }));
  assert.equal(calls, 1);
});

test('查询失败仍可拿到坐标；取消定位不会继续发送第三方请求', async () => {
  let coordinates;
  await assert.rejects(L.currentAddress({
    geolocation: { getCurrentPosition(resolve) { resolve({ coords: { latitude: 36.6, longitude: 117.1 } }); } },
    onCoordinates: value => { coordinates = value; },
    fetch: async () => new Response('', { status: 503 })
  }));
  assert.deepEqual(coordinates, { latitude: 36.6, longitude: 117.1 });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(L.currentAddress({ signal: controller.signal,
    geolocation: { getCurrentPosition(resolve) { resolve({ coords: { latitude: 36.6, longitude: 117.1 } }); } },
    fetch: () => { assert.fail('取消后不查询'); }
  }), /取消/);
});

test('市县可选字段通过前后端规范化、云同步与备份恢复，旧 region 不变', () => {
  const location = { city: '济南市', county: '历城区', region: '济南市历城区', name: '粮库', latitude: 36.6, longitude: 117.1 };
  const business = D.normalizeTripBusiness({ returnTrip: { loadedTons: '30', unitPrice: '240', pickupLocation: location } });
  assert.deepEqual(normalizeTripBusinessData(business), business);
  const settings = D.normalizeBusinessSettings({ places: [{ ...location, id: 'place1' }] });
  assert.deepEqual(normalizeBusinessSettingsData(settings), settings);
  const legacy = D.normalizeTripBusiness({ returnTrip: { loadedTons: '30', unitPrice: '240', pickupLocation: { region: '济南 历城' } } });
  assert.equal(legacy.returnTrip.pickupLocation.region, '济南 历城');
  assert.equal(Object.hasOwn(legacy.returnTrip.pickupLocation, 'city'), false);
  assert.deepEqual(normalizeTripBusinessData(legacy), legacy);
  const source = { schemaVersion: 4, settings: { business: settings }, categories: { expense: [], income: [] },
    vehicles: [{ id: 'v1', name: '测试车', active: true }],
    trips: [{ id: 't1', vehicleId: 'v1', startDate: '2026-09-01', status: 'open', expenses: [], incomes: [], business }], maintenance: [] };
  const fixture = D.migrate(source, source);
  const restored = D.migrate(JSON.parse(JSON.stringify(fixture)), fixture);
  assert.equal(restored.trips[0].business.returnTrip.pickupLocation.county, '历城区');
  assert.equal(globalThis.TTQCloudSync.compareConservation(fixture, restored).equal, true);
  assert.throws(() => normalizeTripBusinessData({ returnTrip: { loadedTons: '30', unitPrice: '240', pickupLocation: { city: '市'.repeat(41) } } }), /市/);
});

test('只在账本路径允许本源定位，API 与登录页仍拒绝定位', () => {
  for (const pathname of ['/ledger', '/ledger/index.html', '/api/bootstrap', '/']) {
    const response = withSecurityHeaders(new Response(''), new Request('https://example.test' + pathname));
    assert.ok(response.headers.get('permissions-policy').includes(pathname.startsWith('/ledger') ? 'geolocation=(self)' : 'geolocation=()'));
  }
});
