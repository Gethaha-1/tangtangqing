import { getD1 } from "../../../db";
import { ensureSchema } from "../../../db/runtime-schema";
import {
  resolveOrCreateActor,
} from "../../../lib/server/bootstrap";
import {
  AuthenticationError,
} from "../../../lib/server/auth";
import {
  enforceMutationRequest,
  readJsonWithinLimit,
  RequestSecurityError,
  secureJson,
} from "../../../lib/server/http-security";
import { requestIdentity, withRequestSession } from "../../../lib/server/request-identity";
import {
  canonicalSyncPayload,
  parseSyncRequest,
  RecordValidationError,
} from "../../../lib/server/sync-contract";
import {
  applyAtomicSyncBatch,
  AtomicSyncBatchError,
  hashSyncPayload,
} from "../../../lib/server/sync-repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return withRequestSession(request, await sync(request));
}

async function sync(request: Request): Promise<Response> {
  try {
    enforceMutationRequest(request);
    const input = await readJsonWithinLimit(request);
    const identity = await requestIdentity(request);
    const syncRequest = parseSyncRequest(input);
    const requestHash = await hashSyncPayload(
      canonicalSyncPayload(
        syncRequest.operations,
        syncRequest.finalize,
        syncRequest.clientSchemaVersion,
      ),
    );

    await ensureSchema();
    const d1 = getD1();
    const actor = await resolveOrCreateActor(d1, identity);
    const response = await applyAtomicSyncBatch(
      d1,
      actor,
      syncRequest.operationId,
      requestHash,
      syncRequest.operations,
      syncRequest.finalize,
    );
    return secureJson(request, response, 200);
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
    if (error instanceof RecordValidationError) {
      return secureJson(
        request,
        { error: { code: error.code, message: error.message } },
        400,
      );
    }
    if (error instanceof AtomicSyncBatchError) {
      return secureJson(
        request,
        {
          error: { code: error.code, message: error.message },
          results: error.results || [],
          hasConflicts: error.status === 409,
          hasRejected: error.status === 422,
        },
        error.status,
      );
    }
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return secureJson(
        request,
        {
          error: {
            code: "invalid_json",
            message: "同步请求不是有效 JSON",
          },
        },
        400,
      );
    }
    // Log only a bounded SQLSTATE, never SQL, bind values or account data.
    const code = (error as { code?: unknown })?.code;
    console.error("sync failed", error instanceof Error ? error.name : "unknown",
      typeof code === "string" && /^[A-Z0-9]{5}$/.test(code) ? code : "unclassified");
    return secureJson(
      request,
      {
        error: {
          code: "sync_failed",
          message: "云端处理失败，保存结果尚未确认；请稍后重新连接核对",
        },
      },
      500,
    );
  }
}
