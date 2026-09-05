(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TTQRecovery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const LIMITS = { bytes: 20 * 1024 * 1024, chunkBytes: 128 * 1024, chunks: 256, operations: 30000 };
  const size = text => new TextEncoder().encode(text).byteLength;
  async function hash(text) {
    const digest = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  }
  async function prepare(operations) {
    if (!Array.isArray(operations) || !operations.length || operations.length > LIMITS.operations)
      throw new Error('恢复变更数量超出支持范围（最多 30000 条）');
    const payloads = [];
    let parts = [], length = 2;
    for (const operation of operations) {
      const part = JSON.stringify(operation), bytes = size(part);
      if (bytes + 2 > LIMITS.chunkBytes) throw new Error('单条记录太大，未发送恢复请求');
      if (parts.length && (parts.length >= 250 || length + bytes + 1 > LIMITS.chunkBytes)) {
        payloads.push('[' + parts.join(',') + ']'); parts = []; length = 2;
      }
      length += bytes + (parts.length ? 1 : 0); parts.push(part);
    }
    if (parts.length) payloads.push('[' + parts.join(',') + ']');
    const totalBytes = payloads.reduce((n, payload) => n + size(payload), 0);
    if (totalBytes > LIMITS.bytes || payloads.length > LIMITS.chunks) throw new Error('恢复变更超过 20 MiB，未发送请求');
    const chunks = await Promise.all(payloads.map(async payload => ({ hash: await hash(payload), bytes: size(payload), count: JSON.parse(payload).length })));
    return { payloads, manifest: { chunks, totalBytes, operationCount: operations.length } };
  }
  async function resume(request, task, progress, check) {
    const assert = check || (() => {}), report = progress || (() => {});
    let remote = await request('/api/restore', { action: 'start', id: task.id, baseVersion: task.baseVersion, manifest: task.manifest });
    assert();
    if (remote.id !== task.id) throw new Error('恢复任务回执不匹配，请核对原任务');
    if (remote.status === 'complete') return remote;
    if (!['uploading', 'ready'].includes(remote.status)) throw new Error('恢复任务已结束或过期，请重新选择备份');
    const received = new Set(remote.received);
    for (let ordinal = 0; ordinal < task.payloads.length; ordinal++) {
      if (!received.has(ordinal)) {
        report('正在上传备份 ' + (ordinal + 1) + '/' + task.payloads.length + '，原账本尚未替换');
        await request('/api/restore', { action: 'chunk', id: task.id, ordinal, payload: task.payloads[ordinal] });
        assert();
      }
    }
    report('分块上传完成，正在校验并一次性恢复，请等待服务器确认…');
    remote = await request('/api/restore', { action: 'commit', id: task.id });
    assert();
    if (remote.status !== 'complete' || remote.id !== task.id) throw new Error('恢复结果尚未确认，请核对原任务');
    return remote;
  }
  function versionsMatch(operations, records) {
    const versions = new Map(records.map(record => [record.type + '\0' + record.id, Number(record.version)]));
    return operations.every(op => (versions.get(op.type + '\0' + op.id) || 0) === op.expectedVersion);
  }
  return { LIMITS, hash, prepare, resume, versionsMatch };
});
