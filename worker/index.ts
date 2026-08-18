import {
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
  handleImageOptimization,
} from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  safeAuthReturnTo,
} from "../lib/auth/logout";
import {
  AuthenticationError,
  INTERNAL_AUTH_HEADERS,
  resolveAuthMode,
  resolveInternalAuthSecret,
} from "../lib/server/auth";
import {
  adaptAuthenticationAtEdge,
  assertModeMayServeRequest,
  localAuthCookie,
} from "../lib/server/auth-edge";
import {
  enforceMutationRequest,
  readJsonWithinLimit,
  RequestSecurityError,
  secureJson,
  withSecurityHeaders,
} from "../lib/server/http-security";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  TTQ_AUTH_MODE?: string;
  TTQ_INTERNAL_AUTH_SECRET?: string;
  NODE_ENV?: string;
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

function hasIdentity(request: Request): boolean {
  return Boolean(request.headers.get(INTERNAL_AUTH_HEADERS.subject));
}

const worker = {
  async fetch(
    originalRequest: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(originalRequest.url);
    const finish = (response: Response) =>
      withSecurityHeaders(response, originalRequest);

    try {
      const authMode = resolveAuthMode(env.TTQ_AUTH_MODE);
      const internalSecret = resolveInternalAuthSecret(
        env.TTQ_INTERNAL_AUTH_SECRET,
      );
      assertModeMayServeRequest(originalRequest, authMode, env.NODE_ENV);

      if (url.pathname === "/api/local-auth/signin") {
        if (originalRequest.method !== "POST") {
          return finish(new Response(null, {
            status: 405,
            headers: { allow: "POST" },
          }));
        }
        if (authMode !== "local") return finish(new Response("Not found", { status: 404 }));
        enforceMutationRequest(originalRequest);
        await readJsonWithinLimit(originalRequest);
        const response = secureJson(
          originalRequest,
          { location: safeAuthReturnTo(url.searchParams.get("return_to")) },
          200,
        );
        const headers = new Headers(response.headers);
        headers.append("set-cookie", localAuthCookie(originalRequest));
        return new Response(response.body, { status: response.status, headers });
      }

      const request = adaptAuthenticationAtEdge(originalRequest, {
        authMode,
        nodeEnv: env.NODE_ENV,
        internalSecret,
      });

      if (
        url.pathname === "/ledger" ||
        url.pathname === "/ledger/" ||
        url.pathname === "/ledger/index.html"
      ) {
        if (!hasIdentity(request)) {
          return finish(new Response(null, {
            status: 302,
            headers: { location: "/?next=%2Fledger" },
          }));
        }
        const assetUrl = new URL("/ledger/index.html", request.url);
        return finish(await env.ASSETS.fetch(new Request(assetUrl, request)));
      }

      if (
        url.pathname === "/ledger/domain.js" ||
        url.pathname === "/ledger/cloud-sync.js" ||
        url.pathname === "/ledger/auth-client.js" ||
        url.pathname === "/ledger/ui-transition.js"
      ) {
        if (!hasIdentity(request)) return finish(new Response("Unauthorized", { status: 401 }));
        return finish(await env.ASSETS.fetch(request));
      }

      if (url.pathname === "/_vinext/image") {
        const allowedWidths = [
          ...DEFAULT_DEVICE_SIZES,
          ...DEFAULT_IMAGE_SIZES,
        ];
        return finish(await handleImageOptimization(
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
        ));
      }

      return finish(await handler.fetch(request, env, ctx));
    } catch (error) {
      if (error instanceof RequestSecurityError) {
        return secureJson(
          originalRequest,
          { error: { code: error.code, message: error.message } },
          error.status,
        );
      }
      if (error instanceof AuthenticationError) {
        return secureJson(
          originalRequest,
          { error: { code: error.code, message: error.message } },
          error.code === "unauthenticated" ? 401 : 503,
        );
      }
      console.error("worker request failed", error);
      return secureJson(
        originalRequest,
        { error: { code: "request_failed", message: "请求暂时无法处理" } },
        500,
      );
    }
  },
};

export default worker;
