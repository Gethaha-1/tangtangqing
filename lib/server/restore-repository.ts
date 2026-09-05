import type { Actor } from './bootstrap';
import { canonicalSyncPayload, isObject, orderSyncOperations, parseSyncOperations, RecordValidationError, rejectOwnershipFields, requiredOperationId, type SyncOperation } from './sync-contract';
import { applyAtomicSyncBatch, AtomicSyncBatchError, hashSyncPayload, validateSyncPut } from './sync-repository';

export const RESTORE_LIMITS = { bytes: 20 * 1024 * 1024, chunkBytes: 128 * 1024, chunks: 256, operations: 30000, days: 7 } as const;
type Manifest = { chunks: { hash: string; bytes: number; count: number }[]; totalBytes: number; operationCount: number };
type Job = { id: string; base_version: number; manifest_json: string; status: string; expires_at: string };
const fail = (code: string, message: string): never => { throw new RecordValidationError(code, message); };
const conflict = (message: string): never => { throw new AtomicSyncBatchError(409, 'restore_conflict', message); };
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

export function parseRestoreManifest(value: unknown): Manifest {
  if (!isObject(value)) return fail('invalid_manifest', '恢复清单格式不正确');
  rejectOwnershipFields(value);
  if (!Array.isArray(value.chunks) || !value.chunks.length || value.chunks.length > RESTORE_LIMITS.chunks)
    return fail('restore_limit', '恢复分块数量超出限制');
  const chunks = value.chunks.map(part => {
    if (!isObject(part) || typeof part.hash !== 'string' || !/^[a-f0-9]{64}$/.test(part.hash) ||
      !Number.isSafeInteger(part.bytes) || Number(part.bytes) < 2 || Number(part.bytes) > RESTORE_LIMITS.chunkBytes ||
      !Number.isSafeInteger(part.count) || Number(part.count) < 1 || Number(part.count) > 250)
      return fail('invalid_manifest', '恢复分块摘要不正确');
    return { hash: part.hash, bytes: Number(part.bytes), count: Number(part.count) };
  });
  const totalBytes = chunks.reduce((n, part) => n + part.bytes, 0);
  const operationCount = chunks.reduce((n, part) => n + part.count, 0);
  if (value.totalBytes !== totalBytes || value.operationCount !== operationCount ||
    totalBytes > RESTORE_LIMITS.bytes || operationCount > RESTORE_LIMITS.operations)
    return fail('restore_limit', '恢复内容超过 20 MiB 或 30000 条变更，未修改正式账本');
  return { chunks, totalBytes, operationCount };
}

async function owner(d1: D1Database, actor: Actor) {
  const member = await d1.prepare('SELECT role, version FROM fleet_members WHERE id = ? AND fleet_id = ? AND user_id = ? AND active = 1')
    .bind(actor.membershipId, actor.fleetId, actor.userId).first<{ role: string; version: number }>();
  if (actor.role !== 'owner' || member?.role !== 'owner' || member.version !== actor.membershipVersion)
    fail('owner_required', '只有当前有效车主可以完整恢复账本');
}

async function jobForActor(d1: D1Database, actor: Actor, id: string): Promise<Job> {
  await owner(d1, actor);
  const job = await d1.prepare('SELECT id, base_version, manifest_json, status, expires_at FROM restore_jobs WHERE fleet_id = ? AND id = ? AND membership_id = ? AND user_id = ?')
    .bind(actor.fleetId, requiredOperationId(id), actor.membershipId, actor.userId).first<Job>();
  if (!job) return fail('restore_not_found', '没有找到当前账号的恢复任务');
  return job;
}

function active(job: Job) {
  if (job.expires_at <= new Date().toISOString()) fail('restore_expired', '临时恢复任务已过期，请重新选择备份；正式账本未因过期改变');
  if (!['uploading', 'ready'].includes(job.status)) fail('restore_closed', '此恢复任务已经结束');
}

/** Opportunistic, tenant-scoped cleanup; never deletes formal ledger rows or receipts. */
export async function cleanExpiredRestores(d1: D1Database, actor: Actor) {
  await owner(d1, actor);
  await d1.prepare("DELETE FROM restore_jobs WHERE fleet_id = ? AND expires_at <= ? AND status <> 'complete'")
    .bind(actor.fleetId, new Date().toISOString()).run();
}

export async function startRestore(d1: D1Database, actor: Actor, id: string, baseVersion: unknown, value: unknown) {
  requiredOperationId(id);
  if (!Number.isSafeInteger(baseVersion) || Number(baseVersion) < 1) fail('invalid_version', '缺少恢复预览对应的车队版本');
  const manifest = parseRestoreManifest(value);
  await cleanExpiredRestores(d1, actor);
  const encoded = JSON.stringify(manifest);
  const receipt = await d1.prepare('SELECT operation_id FROM sync_commits WHERE fleet_id = ? AND operation_id = ?')
    .bind(actor.fleetId, id).first();
  if (receipt) {
    const completed = await jobForActor(d1, actor, id);
    if (completed.status !== 'complete' || completed.manifest_json !== encoded || completed.base_version !== baseVersion)
      conflict('恢复请求标识已经使用，请核对原任务');
    return restoreStatus(d1, actor, id);
  }
  const now = new Date(), expires = new Date(now.valueOf() + RESTORE_LIMITS.days * 86400000).toISOString();
  try {
    await d1.prepare(`INSERT INTO restore_jobs (fleet_id, id, membership_id, user_id, base_version, manifest_json, status, created_at, expires_at)
      SELECT ?, ?, ?, ?, ?, ?, 'uploading', ?, ? WHERE EXISTS (
        SELECT 1 FROM fleets WHERE id = ? AND version = ?
      )`).bind(actor.fleetId, id, actor.membershipId, actor.userId, baseVersion, encoded, now.toISOString(), expires, actor.fleetId, baseVersion).run();
  } catch (error) {
    // Retry is allowed only for the exact same manifest, owner and baseline.
    const existing = await d1.prepare('SELECT id FROM restore_jobs WHERE fleet_id = ? AND id = ? AND membership_id = ? AND user_id = ? AND base_version = ? AND manifest_json = ?')
      .bind(actor.fleetId, id, actor.membershipId, actor.userId, baseVersion, encoded).first();
    if (!existing) {
      if (/unique|restore_jobs_one_active/i.test(String(error))) conflict('已有未结束的恢复任务，请先继续或取消；当前账本没有被替换');
      throw error;
    }
  }
  const existing = await d1.prepare('SELECT id FROM restore_jobs WHERE fleet_id = ? AND id = ? AND membership_id = ? AND user_id = ? AND base_version = ? AND manifest_json = ?')
    .bind(actor.fleetId, id, actor.membershipId, actor.userId, baseVersion, encoded).first();
  if (!existing) conflict('账本在预览后已经变化，请重新读取并确认恢复摘要');
  return restoreStatus(d1, actor, id);
}

export async function restoreStatus(d1: D1Database, actor: Actor, id: string) {
  const job = await jobForActor(d1, actor, id);
  const received = await d1.prepare('SELECT ordinal FROM restore_chunks WHERE fleet_id = ? AND job_id = ? ORDER BY ordinal')
    .bind(actor.fleetId, id).all<{ ordinal: number }>();
  return { id: job.id, status: job.expires_at <= new Date().toISOString() && job.status !== 'complete' ? 'expired' : job.status,
    baseVersion: job.base_version, expiresAt: job.expires_at, manifest: JSON.parse(job.manifest_json) as Manifest,
    received: (received.results || []).map(row => row.ordinal) };
}

export async function listRestores(d1: D1Database, actor: Actor) {
  if (actor.role !== 'owner') return { jobs: [] };
  await cleanExpiredRestores(d1, actor);
  const result = await d1.prepare("SELECT id, status, created_at, expires_at FROM restore_jobs WHERE fleet_id = ? AND membership_id = ? AND user_id = ? AND status IN ('uploading','ready') ORDER BY created_at DESC LIMIT 1")
    .bind(actor.fleetId, actor.membershipId, actor.userId).all();
  return { jobs: result.results || [] };
}

export async function uploadRestoreChunk(d1: D1Database, actor: Actor, id: string, ordinal: unknown, payload: unknown) {
  const job = await jobForActor(d1, actor, id);
  active(job);
  const manifest = parseRestoreManifest(JSON.parse(job.manifest_json));
  if (!Number.isSafeInteger(ordinal) || Number(ordinal) < 0 || Number(ordinal) >= manifest.chunks.length || typeof payload !== 'string')
    return fail('invalid_chunk', '恢复分块格式不正确');
  const part = manifest.chunks[Number(ordinal)];
  if (bytes(payload) !== part.bytes || await hashSyncPayload(payload) !== part.hash)
    return fail('chunk_mismatch', '分块内容与预览指纹不一致，未写入正式账本');
  const operations = parseSyncOperations({ operations: JSON.parse(payload) });
  if (operations.length !== part.count) fail('chunk_mismatch', '分块记录数不一致');
  operations.filter(op => op.op === 'put').forEach(validateSyncPut);
  // Immutable content, conditional insert, and unique ordinal make retries safe.
  await d1.prepare(`INSERT INTO restore_chunks (fleet_id, job_id, ordinal, hash, payload)
    SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM restore_jobs WHERE fleet_id = ? AND id = ? AND status = 'uploading' AND expires_at > ?)
    ON CONFLICT (fleet_id, job_id, ordinal) DO NOTHING`)
    .bind(actor.fleetId, id, ordinal, part.hash, payload, actor.fleetId, id, new Date().toISOString()).run();
  const saved = await d1.prepare('SELECT hash FROM restore_chunks WHERE fleet_id = ? AND job_id = ? AND ordinal = ?')
    .bind(actor.fleetId, id, ordinal).first<{ hash: string }>();
  if (saved?.hash !== part.hash) conflict('恢复任务已经结束或分块不一致，请重新核对');
  return { id, received: ordinal };
}

export async function commitRestore(d1: D1Database, actor: Actor, id: string) {
  const job = await jobForActor(d1, actor, id);
  if (job.status === 'complete') return { id, status: 'complete', replayed: true };
  active(job);
  const manifest = parseRestoreManifest(JSON.parse(job.manifest_json));
  const result = await d1.prepare('SELECT ordinal, hash, payload FROM restore_chunks WHERE fleet_id = ? AND job_id = ? ORDER BY ordinal')
    .bind(actor.fleetId, id).all<{ ordinal: number; hash: string; payload: string }>();
  const chunks = result.results || [];
  if (chunks.length !== manifest.chunks.length) return fail('restore_incomplete', '还有分块未上传，正式账本保持不变');
  const operations: SyncOperation[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const part = manifest.chunks[index];
    if (chunk.ordinal !== index || bytes(chunk.payload) !== part.bytes || chunk.hash !== part.hash || await hashSyncPayload(chunk.payload) !== part.hash)
      return fail('chunk_mismatch', '临时恢复内容校验失败，未替换正式账本');
    const items = parseSyncOperations({ operations: JSON.parse(chunk.payload) });
    if (items.length !== part.count) return fail('chunk_mismatch', '临时恢复记录数不一致');
    operations.push(...items);
  }
  const ordered = orderSyncOperations(operations); // Reject duplicates across chunks too.
  const hash = await hashSyncPayload(canonicalSyncPayload(ordered, true));
  await d1.prepare("UPDATE restore_jobs SET status = 'ready' WHERE fleet_id = ? AND id = ? AND status = 'uploading'")
    .bind(actor.fleetId, id).run();
  await applyAtomicSyncBatch(d1, actor, id, hash, ordered, true, { jobId: id, baseVersion: job.base_version });
  return { id, status: 'complete' };
}

export async function cancelRestore(d1: D1Database, actor: Actor, id: string) {
  await owner(d1, actor);
  requiredOperationId(id);
  // A cancellation tombstone also fences a delayed start request that has not
  // arrived yet. A committed receipt can never be converted into cancellation.
  const now = new Date(), expires = new Date(now.valueOf() + RESTORE_LIMITS.days * 86400000).toISOString();
  await d1.prepare(`INSERT INTO restore_jobs (fleet_id, id, membership_id, user_id, base_version, manifest_json, status, created_at, expires_at)
    SELECT ?, ?, ?, ?, 1, '{}', 'cancelled', ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM sync_commits WHERE fleet_id = ? AND operation_id = ?
    ) ON CONFLICT (fleet_id, id) DO NOTHING`)
    .bind(actor.fleetId, id, actor.membershipId, actor.userId, now.toISOString(), expires, actor.fleetId, id).run();
  const job = await jobForActor(d1, actor, id);
  if (job.status === 'complete') conflict('服务器已完成恢复，不能当作未提交任务取消；请先回读账本');
  await d1.batch([
    d1.prepare("UPDATE restore_jobs SET status = 'cancelled' WHERE fleet_id = ? AND id = ? AND status IN ('uploading','ready')").bind(actor.fleetId, id),
    d1.prepare("DELETE FROM restore_chunks WHERE fleet_id = ? AND job_id = ? AND EXISTS (SELECT 1 FROM restore_jobs WHERE fleet_id = ? AND id = ? AND status = 'cancelled')")
      .bind(actor.fleetId, id, actor.fleetId, id),
  ]);
  return restoreStatus(d1, actor, id);
}
