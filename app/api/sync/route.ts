import { getD1 } from "../../../db";
import { ensureSchema } from "../../../db/runtime-schema";
import {
  resolveOrCreateActor,
} from "../../../lib/server/bootstrap";
import {
  AuthenticationError,
  getTrustedIdentity,
} from "../../../lib/server/auth";
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

export async function POST(request: Request): Promise<Response> {
  try {
    const identity = getTrustedIdentity(request);
    const input = await readJson(request);
    const syncRequest = parseSyncRequest(input);
    const requestHash = await hashSyncPayload(
      canonicalSyncPayload(
        syncRequest.operations,
        syncRequest.finalize,
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
    return json(response, 200);
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return json(
        { error: { code: "unauthenticated", message: error.message } },
        401,
      );
    }
    if (error instanceof RecordValidationError) {
      return json(
        { error: { code: error.code, message: error.message } },
        400,
      );
    }
    if (error instanceof AtomicSyncBatchError) {
      return json(
        {
          error: { code: error.code, message: error.message },
          results: error.results || [],
          hasConflicts: error.status === 409,
          hasRejected: error.status === 422,
        },
        error.status,
      );
    }
    if (error instanceof SyntaxError) {
      return json(
        {
          error: {
            code: "invalid_json",
            message: "同步请求不是有效 JSON",
          },
        },
        400,
      );
    }
    console.error("sync failed", error);
    return json(
      {
        error: {
          code: "sync_failed",
          message: "这次没有保存到云端，请检查网络后重试",
        },
      },
      500,
    );
  }
}

async function readJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 2_000_000) {
    throw new RecordValidationError(
      "payload_too_large",
      "一次原子提交的数据太多，本次没有写入；请使用受控的大型导入流程",
    );
  }
  return request.json();
}

function json(value: unknown, status: number): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
