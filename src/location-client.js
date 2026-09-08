(function (root) {
  'use strict';
  const endpoint = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
  const name = value => typeof value === 'string' ? value.trim().slice(0, 40) : '';

  function addressFromResponse(data) {
    if (!data || /ip/i.test(String(data.lookupSource || ''))) throw new Error('未取得 GPS 对应地址');
    const rows = (data.localityInfo && data.localityInfo.administrative || []).filter(row => row && name(row.name));
    let city = '', county = '';
    if (data.countryCode === 'CN') {
      const code = row => String(row.chinaAdminCode || '');
      const cityRow = rows.find(row => /^\d{4}00$/.test(code(row)) && !/0000$/.test(code(row)));
      const countyRow = rows.find(row => /^\d{6}$/.test(code(row)) && !/00$/.test(code(row)));
      const municipality = rows.find(row => /^(11|12|31|50)0000$/.test(code(row)) || /^(北京|天津|上海|重庆)市$/.test(row.name));
      city = name((municipality || cityRow || rows.find(row => row.adminLevel === 5))?.name);
      county = name((countyRow || rows.find(row => row.adminLevel === 6))?.name);
      if (!city) city = name(data.city);
    } else {
      city = name(data.city);
      county = name(rows.find(row => /county|district/i.test(row.description || ''))?.name);
    }
    // A village/locality is not necessarily a county: never label it as one.
    if (county === city) county = '';
    if (!city && !county) throw new Error('地址服务未返回市县名称');
    return { city, county };
  }

  async function currentAddress(options) {
    const config = options || {};
    const geolocation = config.geolocation || root.navigator?.geolocation;
    if (!geolocation) throw new Error('当前设备不支持定位');
    const position = await new Promise((resolve, reject) => geolocation.getCurrentPosition(resolve, reject,
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }));
    const latitude = Number(position.coords.latitude), longitude = Number(position.coords.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180)
      throw new Error('设备返回的位置无效');
    if (config.signal?.aborted) throw new Error('定位已取消');
    const coordinates = { latitude: Number(latitude.toFixed(6)), longitude: Number(longitude.toFixed(6)) };
    if (config.onCoordinates) config.onCoordinates(coordinates);
    const controller = new AbortController();
    const abort = () => controller.abort();
    config.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 8000);
    try {
      // Client-only provider: fresh device GPS only, never saved coordinates or an IP fallback.
      const url = new URL(endpoint);
      url.search = new URLSearchParams({ latitude, longitude, localityLanguage: 'zh' }).toString();
      const response = await (config.fetch || root.fetch.bind(root))(url.toString(), {
        credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal
      });
      if (!response.ok) throw new Error('地址查询暂不可用');
      return Object.assign(coordinates, addressFromResponse(await response.json()));
    } finally {
      clearTimeout(timer);
      config.signal?.removeEventListener('abort', abort);
    }
  }
  root.TTQLocation = Object.freeze({ currentAddress, addressFromResponse });
})(typeof globalThis !== 'undefined' ? globalThis : this);
