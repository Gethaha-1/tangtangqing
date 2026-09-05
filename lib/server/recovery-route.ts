import { getD1 } from '../../db';
import { ensureSchema } from '../../db/runtime-schema';
import { AuthenticationError } from './auth';
import { resolveOrCreateActor, type Actor } from './bootstrap';
import { enforceMutationRequest, readJsonWithinLimit, RequestSecurityError, secureJson } from './http-security';
import { requestIdentity, withRequestSession } from './request-identity';
import { isObject, RecordValidationError, rejectOwnershipFields } from './sync-contract';
import { AtomicSyncBatchError } from './sync-repository';

export async function recoveryRoute(request: Request, handler: (d1: D1Database, actor: Actor, input: Record<string, unknown>) => Promise<unknown>) {
  let response: Response;
  try {
    enforceMutationRequest(request);
    const identity = await requestIdentity(request);
    const input = await readJsonWithinLimit(request);
    if (!isObject(input)) throw new RecordValidationError('invalid_body', '请求必须是 JSON 对象');
    rejectOwnershipFields(input);
    await ensureSchema();
    const d1 = getD1(), actor = await resolveOrCreateActor(d1, identity);
    response = secureJson(request, await handler(d1, actor, input), 200);
  } catch (error) {
    const known = error instanceof RequestSecurityError || error instanceof AuthenticationError || error instanceof RecordValidationError || error instanceof AtomicSyncBatchError;
    const status = error instanceof RequestSecurityError || error instanceof AtomicSyncBatchError ? error.status
      : error instanceof AuthenticationError ? error.code === 'unauthenticated' ? 401 : 503
      : error instanceof RecordValidationError || error instanceof SyntaxError ? 400 : 500;
    response = secureJson(request, { error: { code: known ? error.code : 'recovery_failed',
      message: known ? error.message : '恢复处理尚未确认，请重新连接查询原任务；不要重复创建恢复任务' } }, status);
  }
  return withRequestSession(request, response);
}
