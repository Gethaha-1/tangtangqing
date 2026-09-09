import { createHash } from "node:crypto";
import {
  enforceMutationRequest,
  readJsonWithinLimit,
  RequestSecurityError,
  secureJson,
  withSecurityHeaders,
} from "../../../../lib/server/http-security";
import { AuthenticationError } from "../../../../lib/server/auth";
import { requestIdentity, withRequestSession } from "../../../../lib/server/request-identity";
import {
  LocationProviderError,
  reverseConfiguredLocation,
} from "../../../../lib/server/location-providers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 10;
const buckets = new Map<string, number[]>();

function coordinate(value: unknown, maximum: number): number {
  if (typeof value !== "number") {
    throw new RequestSecurityError("invalid_coordinates", "设备返回的位置无效", 400);
  }
  const number = value;
  if (!Number.isFinite(number) || Math.abs(number) > maximum) {
    throw new RequestSecurityError("invalid_coordinates", "设备返回的位置无效", 400);
  }
  return Number(number.toFixed(6));
}

function enforceRateLimit(request: Request, subject: string): void {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() || "unknown";
  const key = createHash("sha256").update(`${subject}\u0000${forwarded}`).digest("hex");
  const now = Date.now();
  const recent = (buckets.get(key) || []).filter((stamp) => now - stamp < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    buckets.set(key, recent);
    throw new RequestSecurityError("location_rate_limited", "定位请求过于频繁，请一分钟后再试", 429);
  }
  recent.push(now);
  buckets.set(key, recent);
  if (buckets.size > 2_000) {
    for (const [bucketKey, stamps] of buckets) {
      if (!stamps.some((stamp) => now - stamp < RATE_WINDOW_MS)) buckets.delete(bucketKey);
    }
  }
}

export async function GET(request: Request): Promise<Response> {
  return withSecurityHeaders(new Response(null, { status: 405, headers: { allow: "POST" } }), request);
}

export async function POST(request: Request): Promise<Response> {
  return withRequestSession(request, await reverse(request));
}

async function reverse(request: Request): Promise<Response> {
  try {
    enforceMutationRequest(request);
    const body = await readJsonWithinLimit(request, 1_024);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new RequestSecurityError("invalid_body", "定位请求格式不正确", 400);
    }
    const identity = await requestIdentity(request);
    enforceRateLimit(request, identity.subject);
    const latitude = coordinate((body as Record<string, unknown>).latitude, 90);
    const longitude = coordinate((body as Record<string, unknown>).longitude, 180);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const result = await reverseConfiguredLocation(latitude, longitude, { signal: controller.signal });
      return secureJson(request, {
        provider: result.provider,
        coordinateSystem: "WGS84",
        city: result.address.city,
        county: result.address.county,
      }, 200);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return secureJson(request, { error: { code: error.code, message: error.message } }, error.status);
    }
    if (error instanceof AuthenticationError) {
      return secureJson(request, { error: { code: error.code, message: error.message } }, error.code === "unauthenticated" ? 401 : 503);
    }
    if (error instanceof LocationProviderError) {
      const configuration = error.code.endsWith("_missing") || error.code === "provider_configuration_invalid";
      console.error("location provider failed", error.code.replace(/[^a-z0-9_]/gi, "").slice(0, 40));
      return secureJson(request, {
        error: { code: configuration ? "location_not_configured" : "location_unavailable", message: error.message },
      }, configuration ? 503 : 502);
    }
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return secureJson(request, { error: { code: "invalid_json", message: "定位请求不是有效 JSON" } }, 400);
    }
    const name = error instanceof Error ? error.name : "unknown";
    console.error("location lookup failed", name === "AbortError" ? "timeout" : name);
    return secureJson(request, {
      error: { code: "location_unavailable", message: "地址查询暂不可用，可手动填写或稍后重试" },
    }, 502);
  }
}
