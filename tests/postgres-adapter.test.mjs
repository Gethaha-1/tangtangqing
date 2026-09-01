import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePostgresSql, postgresPoolOptions, PostgresDatabase } from '../db/postgres.ts';

test('Postgres binds parameters and qualifies only SQL tokens, never quoted content', () => {
  assert.equal(compilePostgresSql("SELECT '?' AS x FROM users WHERE id = ? AND display_name = 'users ?' -- ?\n"),
    "SELECT '?' AS x FROM ttq.users WHERE id = $1 AND display_name = 'users ?' -- ?\n");
  assert.equal(compilePostgresSql('SELECT $$? users$$, "?" FROM vehicle_assignments WHERE datetime(starts_at) <= CURRENT_TIMESTAMP AND user_id = ?'),
    'SELECT $$? users$$, "?" FROM ttq.vehicle_assignments WHERE ttq.datetime(starts_at) <= CURRENT_TIMESTAMP AND user_id = $1');
  assert.equal(compilePostgresSql('SELECT /* outer ? /* nested ? */ */ ? FROM ttq.users'),
    'SELECT /* outer ? /* nested ? */ */ $1 FROM ttq.users');
});

test('Postgres requires explicit configuration and verifies TLS for remote hosts', () => {
  assert.throws(() => postgresPoolOptions({}), /TTQ_DATABASE_URL/);
  const options = postgresPoolOptions({ TTQ_DATABASE_URL: 'postgresql://ttq_app:secret@db.example.com:5432/postgres?sslmode=disable&ssl=0&host=attacker.example' });
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.equal(new URL(options.connectionString).search, '');
  assert.equal(postgresPoolOptions({ TTQ_DATABASE_URL: 'postgres://ttq_app:secret@127.0.0.1:55432/test' }).ssl, false);
  assert.throws(() => postgresPoolOptions({ NETLIFY: 'true', TTQ_DATABASE_URL: 'postgres://ttq_app:secret@127.0.0.1/test' }), /本地数据库/);
});

test('D1-compatible batch rolls back all writes and always releases its connection', async () => {
  const calls = [];
  const client = { async query(sql) { calls.push(sql); if (sql.includes('broken')) throw new Error('constraint'); return { rows: [], rowCount: 1 }; }, release() { calls.push('release'); } };
  const db = new PostgresDatabase({ connect: async () => client });
  await assert.rejects(db.batch([db.prepare('INSERT INTO users (id) VALUES (?)').bind('one'), db.prepare('broken')]), /constraint/);
  assert.equal(calls[0], 'BEGIN ISOLATION LEVEL SERIALIZABLE');
  assert.deepEqual(calls.slice(-2), ['ROLLBACK', 'release']);
  assert.equal(calls.includes('COMMIT'), false);
});

test('read-only batches use one escaped serializable snapshot round trip', async () => {
  const calls = [];
  const client = {
    escapeLiteral(value) { return `'${String(value).replaceAll("'", "''")}'`; },
    async query(sql) {
      calls.push(sql);
      return [
        { command: 'BEGIN', rows: [], rowCount: null },
        { command: 'SELECT', rows: [{ value: 'one' }], rowCount: 1 },
        { command: 'SELECT', rows: [{ value: 'two' }], rowCount: 1 },
        { command: 'COMMIT', rows: [], rowCount: null },
      ];
    },
    release() { calls.push('release'); },
  };
  const db = new PostgresDatabase({ connect: async () => client });
  const results = await db.batch([
    db.prepare('SELECT ? AS value FROM users WHERE display_name = ?').bind('one', "O'Reilly"),
    db.prepare('SELECT ? AS value FROM vehicles').bind('two'),
  ]);
  assert.deepEqual(results.map(result => result.results[0].value), ['one', 'two']);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY;/);
  assert.match(calls[0], /'O''Reilly'/);
  assert.match(calls[0], /FROM ttq\.users/);
  assert.deepEqual(calls.slice(-1), ['release']);
});

test('cloud Auth and database must belong to the same explicitly configured test project', () => {
  const ref='abcdefghijklmnopqrst';
  const env={NETLIFY:'true',TTQ_AUTH_MODE:'supabase',TTQ_SUPABASE_URL:`https://${ref}.supabase.co`,TTQ_DATABASE_URL:`postgresql://ttq_app.${ref}:password@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres`};
  assert.equal(postgresPoolOptions(env).ssl.rejectUnauthorized,true);
  assert.throws(()=>postgresPoolOptions({...env,TTQ_DATABASE_URL:'postgresql://ttq_app.anotherprojectrefhere:password@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres'}),/项目不一致/);
});
