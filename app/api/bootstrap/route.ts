import { getD1 } from "../../../db";
import { ensureSchema } from "../../../db/runtime-schema";
import {
  loadBootstrap,
  resolveOrCreateActor,
} from "../../../lib/server/bootstrap";
import {
  AuthenticationError,
  getTrustedPrincipal,
} from "../../../lib/server/auth";
import {
  enforceMutationRequest,
  readJsonWithinLimit,
  RequestSecurityError,
  secureJson,
  withSecurityHeaders,
} from "../../../lib/server/http-security";
import { serverAuthOptions } from "../../../lib/server/auth-runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return withSecurityHeaders(
    new Response(null, { status: 405, headers: { allow: "POST" } }),
    request,
  );
}

export async function POST(request: Request): Promise<Response> {
  return bootstrap(request);
}

async function bootstrap(request: Request): Promise<Response> {
  try {
    enforceMutationRequest(request);
    await readJsonWithinLimit(request);
    const identity = getTrustedPrincipal(request, serverAuthOptions());
    await ensureSchema();
    const d1 = getD1();
    const actor = await resolveOrCreateActor(d1, identity);
    const payload = await loadBootstrap(d1, actor);
    return secureJson(request, payload, 200);
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return secureJson(
        request,
        { error: { code: error.code, message: error.message } },
        error.status,
      );
    }
    if (error instanceof AuthenticationError) {
      return secureJson(
        request,
        { error: { code: error.code, message: error.message } },
        error.code === "unauthenticated" ? 401 : 503,
      );
    }
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return secureJson(
        request,
        { error: { code: "invalid_json", message: "请求不是有效 JSON" } },
        400,
      );
    }
    console.error("bootstrap failed", error);
    return secureJson(
      request,
      {
        error: {
          code: "bootstrap_failed",
          message: "暂时没能打开云端账本，请检查网络后重试",
        },
      },
      500,
    );
  }
}
