import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  LocationProviderError,
  reverseConfiguredLocation,
  reverseWithAmap,
} from "../lib/server/location-providers.ts";

function amapJson(value) {
  return Response.json(value, { status: 200 });
}

test("高德先把 WGS84 转为 GCJ02，再逆地理编码，并按官方规则签名", async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url: new URL(url), options });
    return calls.length === 1
      ? amapJson({ status: "1", locations: "117.123456,36.654321" })
      : amapJson({ status: "1", regeocode: { addressComponent: {
        province: "山东省", city: "济南市", district: "历城区",
      } } });
  };
  const result = await reverseWithAmap(36.6, 117.1, "test-key", "private-key", { fetch });
  assert.deepEqual(result, { province: "山东省", city: "济南市", county: "历城区" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.origin + calls[0].url.pathname,
    "https://restapi.amap.com/v3/assistant/coordinate/convert");
  assert.equal(calls[0].url.searchParams.get("coordsys"), "gps");
  assert.equal(calls[0].url.searchParams.get("locations"), "117.1,36.6");
  const canonical = "coordsys=gps&key=test-key&locations=117.1,36.6&output=JSON";
  assert.equal(calls[0].url.searchParams.get("sig"),
    createHash("md5").update(canonical + "private-key").digest("hex"));
  assert.equal(calls[1].url.searchParams.get("location"), "117.123456,36.654321");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.redirect, "error");
});

test("定位服务商只能显式选择，不在失败时跨服务商转发坐标", async () => {
  const previousProvider = process.env.TTQ_LOCATION_PROVIDER;
  const previousKey = process.env.TTQ_AMAP_WEB_SERVICE_KEY;
  let calls = 0;
  try {
    process.env.TTQ_LOCATION_PROVIDER = "amap";
    process.env.TTQ_AMAP_WEB_SERVICE_KEY = "test-key";
    await assert.rejects(
      reverseConfiguredLocation(36.6, 117.1, {
        fetch: async () => { calls += 1; return new Response("", { status: 503 }); },
      }),
      (error) => error instanceof LocationProviderError && error.code === "provider_http_error",
    );
    assert.equal(calls, 1, "高德失败后不能自动调用 BigDataCloud");

    process.env.TTQ_LOCATION_PROVIDER = "unknown";
    await assert.rejects(
      reverseConfiguredLocation(36.6, 117.1, { fetch: async () => { calls += 1; return amapJson({}); } }),
      (error) => error instanceof LocationProviderError && error.code === "provider_configuration_invalid",
    );
    assert.equal(calls, 1);
  } finally {
    if (previousProvider === undefined) delete process.env.TTQ_LOCATION_PROVIDER;
    else process.env.TTQ_LOCATION_PROVIDER = previousProvider;
    if (previousKey === undefined) delete process.env.TTQ_AMAP_WEB_SERVICE_KEY;
    else process.env.TTQ_AMAP_WEB_SERVICE_KEY = previousKey;
  }
});

test("高德直辖市 city 为空时使用省级名称，且缺少 Key 直接失败", async () => {
  const result = await reverseWithAmap(39.9, 116.4, "test-key", undefined, {
    fetch: async (url) => new URL(url).pathname.includes("coordinate")
      ? amapJson({ status: "1", locations: "116.41,39.91" })
      : amapJson({ status: "1", regeocode: { addressComponent: {
        province: "北京市", city: [], district: "朝阳区",
      } } }),
  });
  assert.deepEqual(result, { province: "北京市", city: "北京市", county: "朝阳区" });

  const previousProvider = process.env.TTQ_LOCATION_PROVIDER;
  const previousKey = process.env.TTQ_AMAP_WEB_SERVICE_KEY;
  try {
    process.env.TTQ_LOCATION_PROVIDER = "amap";
    delete process.env.TTQ_AMAP_WEB_SERVICE_KEY;
    await assert.rejects(reverseConfiguredLocation(39.9, 116.4),
      (error) => error instanceof LocationProviderError && error.code === "amap_key_missing");
  } finally {
    if (previousProvider === undefined) delete process.env.TTQ_LOCATION_PROVIDER;
    else process.env.TTQ_LOCATION_PROVIDER = previousProvider;
    if (previousKey === undefined) delete process.env.TTQ_AMAP_WEB_SERVICE_KEY;
    else process.env.TTQ_AMAP_WEB_SERVICE_KEY = previousKey;
  }
});
