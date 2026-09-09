import { recoveryRoute } from '../../../lib/server/recovery-route';
import { cancelRestore, commitRestore, listRestores, restoreStatus, startRestore, uploadRestoreChunk } from '../../../lib/server/restore-repository';
import { RecordValidationError, requireClientSchemaVersion, requiredOperationId } from '../../../lib/server/sync-contract';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: Request) {
  return recoveryRoute(request, async (d1, actor, input) => {
    if (input.action !== 'list' && input.action !== 'status')
      requireClientSchemaVersion(input.clientSchemaVersion);
    if (input.action === 'list') return listRestores(d1, actor);
    const id = requiredOperationId(input.id);
    switch (input.action) {
      case 'start': return startRestore(d1, actor, id, input.baseVersion, input.manifest);
      case 'status': return restoreStatus(d1, actor, id);
      case 'chunk': return uploadRestoreChunk(d1, actor, id, input.ordinal, input.payload);
      case 'commit': return commitRestore(d1, actor, id);
      case 'cancel': return cancelRestore(d1, actor, id);
      default: throw new RecordValidationError('invalid_action', '未知的恢复操作');
    }
  });
}
