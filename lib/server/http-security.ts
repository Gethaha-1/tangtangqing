export const MAX_JSON_BYTES = 2 * 1024 * 1024;
export const REQUEST_MARKER_HEADER = "x-ttq-request";
export const REQUEST_MARKER_VALUE = "ledger-v1";

const BASE_SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "frame-ancestors 'none'",
  "permissions-policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export class RequestSecurityError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 403) {
    super(message);
    this.name = "RequestSecurityError";
    this.code = code;
    this.status = status;
  }
}

export type RequestSecurityOptions = {
  allowedOrigins?: readonly string[];
};

/** Enforces the browser-to-application boundary for every stateful request. */
export function enforceMutationRequest(
  request: Request,
  options: RequestSecurityOptions = {},
): void {
  const requestOrigin = new URL(request.url).origin;
  const allowlist = options.allowedOrigins ?? configuredOrigins(requestOrigin);
  const origin = request.headers.get("origin");
  if (!origin || !allowlist.includes(origin)) {
    throw new RequestSecurityError(
      "origin_not_allowed",
      "请求来源不受信任",
    );
  }

  if (request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") {
    throw new RequestSecurityError(
      "cross_site_request",
      "不接受跨站写入请求",
    );
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new RequestSecurityError(
      "unsupported_media_type",
      "请求必须使用 application/json",
      415,
    );
  }

  if (request.headers.get(REQUEST_MARKER_HEADER) !== REQUEST_MARKER_VALUE) {
    throw new RequestSecurityError(
      "request_marker_missing",
      `请求缺少 ${REQUEST_MARKER_HEADER}`,
    );
  }
}

export async function readJsonWithinLimit(
  request: Request,
  limit = MAX_JSON_BYTES,
): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > limit) {
    throw payloadTooLarge();
  }

  if (!request.body) return JSON.parse("");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel("payload too large");
        throw payloadTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export function secureJson(
  request: Request,
  value: unknown,
  status: number,
): Response {
  return withSecurityHeaders(Response.json(value, { status }), request);
}

export function withSecurityHeaders(
  response: Response,
  request: Request,
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  const pathname = new URL(request.url).pathname;
  if (pathname === "/ledger" || pathname.startsWith("/ledger/")) {
    headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(self), payment=(), usb=()");
  }
  if (new URL(request.url).protocol === "https:") {
    headers.set(
      "strict-transport-security",
      "max-age=31536000",
    );
  } else {
    headers.delete("strict-transport-security");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function configuredOrigins(requestOrigin: string): string[] {
  const configured =
    typeof process === "undefined" ? "" : process.env.TTQ_ALLOWED_ORIGINS ?? "";
  if (!configured.trim()) return [requestOrigin];

  const origins = configured.split(",").map((value) => value.trim()).filter(Boolean);
  if (
    origins.some((value) => {
      try {
        return new URL(value).origin !== value;
      } catch {
        return true;
      }
    })
  ) {
    throw new RequestSecurityError(
      "origin_configuration_invalid",
      "TTQ_ALLOWED_ORIGINS 配置无效",
      500,
    );
  }
  return origins;
}

function payloadTooLarge(): RequestSecurityError {
  return new RequestSecurityError(
    "payload_too_large",
    "一次提交不得超过 2 MiB",
    413,
  );
}
