import {
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
  handleImageOptimization,
} from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  isLocalAuthHost,
  LOCAL_AUTH_COOKIE,
  safeAuthReturnTo,
} from "../lib/auth/logout";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: {
          format: string;
          quality: number;
        }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const LOCAL_EMAIL = "local-owner@ttq.test";
const LOCAL_FULL_NAME = "本地测试车主";

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ location });
  if (cookie) headers.set("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}

function withLocalIdentity(request: Request, url: URL): Request {
  if (!isLocalAuthHost(url.hostname)) return request;
  const headers = new Headers(request.headers);
  // Local development has no Sites dispatcher. Strip caller-supplied identity
  // assertions, then mint the fixed test identity only from our HttpOnly cookie.
  headers.delete("oai-authenticated-user-email");
  headers.delete("oai-authenticated-user-full-name");
  headers.delete("oai-authenticated-user-full-name-encoding");
  if (cookieValue(request, LOCAL_AUTH_COOKIE) !== "owner") {
    return new Request(request, { headers });
  }
  headers.set("oai-authenticated-user-email", LOCAL_EMAIL);
  headers.set(
    "oai-authenticated-user-full-name",
    encodeURIComponent(LOCAL_FULL_NAME),
  );
  headers.set(
    "oai-authenticated-user-full-name-encoding",
    "percent-encoded-utf-8",
  );
  return new Request(request, { headers });
}

function hasIdentity(request: Request): boolean {
  return Boolean(request.headers.get("oai-authenticated-user-email"));
}

const worker = {
  async fetch(
    originalRequest: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(originalRequest.url);

    if (url.pathname === "/api/local-auth/signin") {
      if (!isLocalAuthHost(url.hostname)) return new Response("Not found", { status: 404 });
      return redirect(
        safeAuthReturnTo(url.searchParams.get("return_to")),
        `${LOCAL_AUTH_COOKIE}=owner; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800`,
      );
    }

    const request = withLocalIdentity(originalRequest, url);

    if (
      url.pathname === "/ledger" ||
      url.pathname === "/ledger/" ||
      url.pathname === "/ledger/index.html"
    ) {
      if (!hasIdentity(request)) return redirect("/?next=%2Fledger");
      const assetUrl = new URL("/ledger/index.html", request.url);
      return env.ASSETS.fetch(new Request(assetUrl, request));
    }

    if (
      url.pathname === "/ledger/domain.js" ||
      url.pathname === "/ledger/cloud-sync.js"
    ) {
      if (!hasIdentity(request)) return new Response("Unauthorized", { status: 401 });
      return env.ASSETS.fetch(request);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [
        ...DEFAULT_DEVICE_SIZES,
        ...DEFAULT_IMAGE_SIZES,
      ];
      return handleImageOptimization(
        request,
        {
          fetchAsset: (path) =>
            env.ASSETS.fetch(new Request(new URL(path, request.url))),
          transformImage: async (body, { width, format, quality }) => {
            const result = await env.IMAGES.input(body)
              .transform(width > 0 ? { width } : {})
              .output({ format, quality });
            return result.response();
          },
        },
        allowedWidths,
      );
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
