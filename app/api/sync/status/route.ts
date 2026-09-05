import { recoveryRoute } from '../../../../lib/server/recovery-route';
import { canonicalSyncPayload, parseSyncRequest } from '../../../../lib/server/sync-contract';
import { hashSyncPayload, AtomicSyncBatchError } from '../../../../lib/server/sync-repository';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  return recoveryRoute(request, async (d1, actor, input) => {
    const parsed = parseSyncRequest(input);
    const hash = await hashSyncPayload(canonicalSyncPayload(parsed.operations, parsed.finalize));
    const receipt = await d1.prepare('SELECT request_hash FROM sync_commits WHERE fleet_id = ? AND operation_id = ?')
      .bind(actor.fleetId, parsed.operationId).first<{ request_hash: string }>();
    if (receipt && receipt.request_hash !== hash)
      throw new AtomicSyncBatchError(409, 'operation_id_reused', '请求标识对应的内容不同，请停止重试并核对');
    // No historical record contents: a driver's assignments may have changed.
    return { operationId: parsed.operationId, committed: Boolean(receipt) };
  });
}
