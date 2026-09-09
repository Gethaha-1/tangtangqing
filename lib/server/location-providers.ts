import { createHash } from "node:crypto";

export type ReverseLocation = {
  province: string;
  city: string;
  county: string;
};

export class LocationProviderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LocationProviderError";
    this.code = code;
  }
}

type ProviderOptions = {
  fetch?: typeof fetch;
  signal?: AbortSignal;
};

const AMAP_CONVERT_URL = "https://restapi.amap.com/v3/assistant/coordinate/convert";
const AMAP_REGEO_URL = "https://restapi.amap.com/v3/geocode/regeo";
const BIG_DATA_CLOUD_URL = "https://api.bigdatacloud.net/data/reverse-geocode-client";

function boundedText(value: unknown, maximum = 40): string {
  const scalar = Array.isArray(value) ? value.find((item) => typeof item === "string") : value;
  return typeof scalar === "string" ? scalar.trim().slice(0, maximum) : "";
}

function providerUrl(
  endpoint: string,
  params: Record<string, string>,
  privateKey?: string,
): string {
  const sorted = Object.entries(params).sort(([left], [right]) => left.localeCompare(right));
  const query = new URLSearchParams(sorted);
  if (privateKey) {
    // Amap signs the sorted, unescaped key=value pairs. URL escaping is only
    // applied afterwards when the actual request URL is assembled.
    const canonical = sorted.map(([key, value]) => `${key}=${value}`).join("&");
    const signature = createHash("md5").update(canonical + privateKey).digest("hex");
    query.set("sig", signature);
  }
  return `${endpoint}?${query.toString()}`;
}

async function providerJson(
  url: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: "GET",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (!response.ok) throw new LocationProviderError("provider_http_error", "地址服务暂不可用");
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new LocationProviderError("provider_invalid_response", "地址服务返回格式不正确");
  }
  return body as Record<string, unknown>;
}

function requireAmapSuccess(body: Record<string, unknown>): void {
  if (String(body.status || "") !== "1") {
    const infoCode = /^\d{5}$/.test(String(body.infocode || "")) ? String(body.infocode) : "unknown";
    throw new LocationProviderError(`amap_${infoCode}`, "高德地址查询暂不可用");
  }
}

export async function reverseWithAmap(
  latitude: number,
  longitude: number,
  key: string,
  privateKey: string | undefined,
  options: ProviderOptions = {},
): Promise<ReverseLocation> {
  const fetchImpl = options.fetch ?? fetch;
  const common = { key, output: "JSON" };
  const converted = await providerJson(providerUrl(AMAP_CONVERT_URL, {
    ...common,
    coordsys: "gps",
    locations: `${longitude},${latitude}`,
  }, privateKey), fetchImpl, options.signal);
  requireAmapSuccess(converted);
  const convertedLocation = boundedText(converted.locations, 80);
  if (!/^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(convertedLocation)) {
    throw new LocationProviderError("amap_invalid_coordinates", "高德坐标转换结果无效");
  }

  const reversed = await providerJson(providerUrl(AMAP_REGEO_URL, {
    ...common,
    extensions: "base",
    location: convertedLocation,
    radius: "1000",
  }, privateKey), fetchImpl, options.signal);
  requireAmapSuccess(reversed);
  const regeocode = reversed.regeocode;
  const component = regeocode && typeof regeocode === "object" && !Array.isArray(regeocode)
    ? (regeocode as Record<string, unknown>).addressComponent : null;
  if (!component || typeof component !== "object" || Array.isArray(component)) {
    throw new LocationProviderError("amap_missing_address", "高德未返回市县信息");
  }
  const fields = component as Record<string, unknown>;
  const province = boundedText(fields.province);
  const city = boundedText(fields.city) || province;
  const county = boundedText(fields.district);
  if (!city && !county) throw new LocationProviderError("amap_missing_address", "高德未返回市县信息");
  return { province, city, county: county === city ? "" : county };
}

export function addressFromBigDataCloud(body: Record<string, unknown>): ReverseLocation {
  if (/ip/i.test(String(body.lookupSource || ""))) {
    throw new LocationProviderError("bigdatacloud_ip_fallback", "未取得 GPS 对应地址");
  }
  const localityInfo = body.localityInfo;
  const rows = localityInfo && typeof localityInfo === "object" && !Array.isArray(localityInfo) &&
    Array.isArray((localityInfo as Record<string, unknown>).administrative)
    ? ((localityInfo as Record<string, unknown>).administrative as unknown[])
      .filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row))
    : [];
  let province = "";
  let city = "";
  let county = "";
  const name = (row: Record<string, unknown> | undefined) => boundedText(row?.name);
  if (body.countryCode === "CN") {
    const code = (row: Record<string, unknown>) => String(row.chinaAdminCode || "");
    const provinceRow = rows.find((row) => /^\d{2}0000$/.test(code(row)));
    const cityRow = rows.find((row) => /^\d{4}00$/.test(code(row)) && !/0000$/.test(code(row)));
    const countyRow = rows.find((row) => /^\d{6}$/.test(code(row)) && !/00$/.test(code(row)));
    const municipality = rows.find((row) => /^(11|12|31|50)0000$/.test(code(row)) || /^(北京|天津|上海|重庆)市$/.test(String(row.name || "")));
    province = name(provinceRow || municipality);
    city = name(municipality || cityRow || rows.find((row) => Number(row.adminLevel) === 5)) || boundedText(body.city) || province;
    county = name(countyRow || rows.find((row) => Number(row.adminLevel) === 6));
  } else {
    province = boundedText(body.principalSubdivision);
    city = boundedText(body.city) || province;
    county = name(rows.find((row) => /county|district/i.test(String(row.description || ""))));
  }
  if (!city && !county) throw new LocationProviderError("bigdatacloud_missing_address", "地址服务未返回市县名称");
  return { province, city, county: county === city ? "" : county };
}

export async function reverseWithBigDataCloud(
  latitude: number,
  longitude: number,
  options: ProviderOptions = {},
): Promise<ReverseLocation> {
  const fetchImpl = options.fetch ?? fetch;
  const url = new URL(BIG_DATA_CLOUD_URL);
  url.search = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    localityLanguage: "zh",
  }).toString();
  return addressFromBigDataCloud(await providerJson(url.toString(), fetchImpl, options.signal));
}

export async function reverseConfiguredLocation(
  latitude: number,
  longitude: number,
  options: ProviderOptions = {},
): Promise<{ provider: "amap" | "bigdatacloud"; address: ReverseLocation }> {
  const provider = (process.env.TTQ_LOCATION_PROVIDER || "amap").trim().toLowerCase();
  if (provider === "bigdatacloud") {
    return { provider, address: await reverseWithBigDataCloud(latitude, longitude, options) };
  }
  if (provider !== "amap") throw new LocationProviderError("provider_configuration_invalid", "定位服务配置无效");
  const key = (process.env.TTQ_AMAP_WEB_SERVICE_KEY || "").trim();
  if (!key) throw new LocationProviderError("amap_key_missing", "高德定位服务尚未配置");
  const privateKey = (process.env.TTQ_AMAP_WEB_SERVICE_PRIVATE_KEY || "").trim() || undefined;
  return {
    provider,
    address: await reverseWithAmap(latitude, longitude, key, privateKey, options),
  };
}
