import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const ref = process.env.TTQ_TEST_PROJECT_REF;
const origin = process.env.TTQ_CLOUD_TEST_ORIGIN;
const site = process.env.TTQ_TEST_SITE_NAME;
if (!ref || !origin || !site || !process.argv.includes(`--confirm-new-project=${ref}`)) throw new Error('尚未执行云端验证：需要独立测试项目ref、测试站名称/HTTPS地址和 --confirm-new-project=ref。');
const url = new URL(origin);
if (url.protocol !== 'https:' || url.hostname !== `${site}.netlify.app` || url.origin !== origin) throw new Error('只允许指定的新 Netlify 测试站，不接受原站或任意转发地址。');
if (process.env.TTQ_SUPABASE_URL !== `https://${ref}.supabase.co`) throw new Error('Supabase 项目标识不一致，拒绝测试写入。');
const credentials = ['A', 'B'].map(id => ({ email: process.env[`TTQ_TEST_USER_${id}_EMAIL`], password: process.env[`TTQ_TEST_USER_${id}_PASSWORD`] }));
if (credentials.some(item => !item.email || !item.password) || credentials[0].email === credentials[1].email) throw new Error('请在隔离的空 Supabase 验收项目创建两个独立且已验证的测试账号。');

function browser() {
  const cookies = new Map();
  return async (path, body) => {
    const response = await fetch(origin+path, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(60_000), headers: { origin, 'content-type': 'application/json', 'x-ttq-request': 'ledger-v1', cookie: Array.from(cookies, ([key,value])=>`${key}=${value}`).join('; ') }, body: JSON.stringify(body) });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';'); const separator = pair.indexOf('=');
      cookies.set(pair.slice(0,separator),pair.slice(separator+1));
    }
    return { status: response.status, payload: await response.json() };
  };
}
const infoResponse = await fetch(origin+'/api/deployment-info', { redirect: 'manual', signal: AbortSignal.timeout(15000) });
assert.equal(infoResponse.status, 200, '目标不是已配置的 Netlify + Supabase 验收站');
const info = await infoResponse.json();
assert.equal(info.deployment, 'netlify-supabase');
assert.equal(info.supabaseProjectRef, ref, '站点实际使用的项目与测试项目不一致，拒绝写入');
const a = browser(), b = browser();
assert.equal((await a('/auth/supabase/signin', credentials[0])).status, 200);
assert.equal((await b('/auth/supabase/signin', credentials[1])).status, 200);
const initialA = await a('/api/bootstrap', {}), initialB = await b('/api/bootstrap', {});
assert.equal(initialA.status, 200); assert.equal(initialB.status, 200);
assert.notEqual(initialA.payload.fleet.id, initialB.payload.fleet.id);
assert.equal(initialA.payload.cloudEmpty, true, '测试账号已有初始化账本，停止写入');
assert.equal(initialB.payload.cloudEmpty, true, '测试账号已有初始化账本，停止写入');
for (const initial of [initialA, initialB]) assert.equal(initial.payload.records.filter(row=>row.type!=='fleet_settings').length, 0, '测试账号并非空账本，停止写入');
const id = 'validation-'+randomUUID();
const batch = { operationId: randomUUID(), finalize: true, operations: [{ op: 'put', type: 'vehicle', id, expectedVersion: 0, data: { id, name: '部署验证用测试车辆', active: true, plateNo: '', sortOrder: 0 } }] };
assert.equal((await a('/api/sync', batch)).status, 200);
assert.equal((await a('/api/sync', batch)).payload.replayed, true);
assert.equal((await a('/api/bootstrap', {})).payload.records.filter(row=>row.type==='vehicle').length, 1);
assert.equal((await b('/api/bootstrap', {})).payload.records.filter(row=>row.type==='vehicle').length, 0);
assert.equal((await a('/auth/logout', {})).status, 200);
assert.equal((await a('/api/bootstrap', {})).status, 401);
console.log('真实云端验证通过：两个账号登录、首次开账、保存、幂等重放、持久读取、隔离、退出。');
console.log('仅测试账号A保留一条验证车辆，便于人工检查；未导入任何真实账目。请继续用国内手机流量测试。');
