import { getD1 } from "../../../db";
import { ensureSchema } from "../../../db/runtime-schema";
import {
  loadBootstrap,
  resolveOrCreateActor,
} from "../../../lib/server/bootstrap";
import {
  AuthenticationError,
  getTrustedIdentity,
} from "../../../lib/server/auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return bootstrap(request);
}

// POST is kept as an equivalent same-origin entry point for clients that avoid
// caching identity-aware bootstrap requests. It does not accept identity data.
export async function POST(request: Request): Promise<Response> {
  return bootstrap(request);
}

async function bootstrap(request: Request): Promise<Response> {
  try {
    const identity = getTrustedIdentity(request);
    await ensureSchema();
    const d1 = getD1();
    const actor = await resolveOrCreateActor(d1, identity);
    const payload = await loadBootstrap(d1, actor);
    return json(payload, 200);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return json(
        { error: { code: "unauthenticated", message: error.message } },
        401,
      );
    }
    console.error("bootstrap failed", error);
    return json(
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

function json(value: unknown, status: number): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
