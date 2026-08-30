import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { postgresPoolOptions } from '../db/postgres.ts';

const ref = process.env.TTQ_TEST_PROJECT_REF;
if (!ref || !/^[a-z0-9]{16,32}$/.test(ref) || !process.argv.includes(`--confirm-new-project=${ref}`)) {
  throw new Error('拒绝操作：仅允许新建测试项目。设置 TTQ_TEST_PROJECT_REF，并显式传入 --confirm-new-project=该项目ref。');
}
const adminUrl = process.env.TTQ_DATABASE_ADMIN_URL;
const appPassword = process.env.TTQ_APP_DATABASE_PASSWORD;
if (!adminUrl || !appPassword || appPassword.length < 32) throw new Error('缺少迁移专用连接或至少32字符的新应用密码。不要把迁移凭据上传到 Netlify。');
let parsed;
try { parsed = new URL(adminUrl); } catch { throw new Error("迁移连接串格式无效（已隐藏）"); }
if (parsed.hostname !== `db.${ref}.supabase.co` && !decodeURIComponent(parsed.username).endsWith(`.${ref}`)) throw new Error('连接串不属于指定测试项目，已拒绝迁移。');
// The application runtime must use ttq_app. This one-shot local installer is
// the only path that accepts the project-scoped postgres administrator after
// the project-ref/host check above has succeeded.
const client = new pg.Client(postgresPoolOptions({
  ...process.env,
  TTQ_AUTH_MODE: undefined,
  TTQ_DATABASE_URL: adminUrl,
}));
try {
  await client.connect();
  const existing = await client.query("SELECT to_regnamespace('ttq') AS schema, EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ttq_app') AS role");
  if (existing.rows[0].schema || existing.rows[0].role) throw new Error('此项目已有 ttq schema。为避免影响已有数据，自动安装已停止；请使用新测试项目或人工审核已有状态。');
  await client.query(await readFile(new URL('../deploy/supabase/001_ledger.sql', import.meta.url), 'utf8'));
  const statement = await client.query("SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) AS sql", ['ttq_app', appPassword]);
  await client.query(statement.rows[0].sql);
  console.log('独立测试库 schema 和最小权限应用账号已准备。请配置 ttq_app 连接，并创建两个测试 Auth 用户。');
} finally { await client.end(); }
