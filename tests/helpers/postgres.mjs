import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';

export async function vacantPort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** A real PostgreSQL process, loopback only, fresh directory; never uses env DB URLs. */
export async function startTestPostgres() {
  const directory = await mkdtemp(join(tmpdir(), 'ttq-pg-test-'));
  const port = await vacantPort();
  const password = randomBytes(24).toString('hex');
  const messages = [];
  const database = new EmbeddedPostgres({
    databaseDir: join(directory, 'database'), port, user: 'postgres', password,
    authMethod: 'scram-sha-256', persistent: false, createPostgresUser: false,
    postgresFlags: ['-h', '127.0.0.1', '-k', directory],
    onLog: message => messages.push(message), onError: message => messages.push(String(message)),
  });
  let admin;
  try {
    await database.initialise();
    await database.start();
    admin = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres' });
    await admin.connect();
    await admin.query('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
    const migration = await readFile(new URL('../../deploy/supabase/001_ledger.sql', import.meta.url), 'utf8');
    await admin.query(migration);
    // Verify migration idempotence in the real engine.
    await admin.query(migration);
    await admin.query(await readFile(new URL('../../supabase/migrations/20260905164507_ledger_recovery.sql', import.meta.url), 'utf8'));
    const businessMigration = await readFile(new URL('../../supabase/migrations/20260908120000_trip_business.sql', import.meta.url), 'utf8');
    await admin.query(businessMigration);
    await admin.query(businessMigration);
    await admin.query(`ALTER ROLE ttq_app LOGIN PASSWORD '${password}'`);
    return { admin, port, databaseUrl: `postgresql://ttq_app:${password}@127.0.0.1:${port}/postgres`, async stop() {
      await admin.end(); await database.stop(); await rm(directory, { recursive: true, force: true });
    } };
  } catch (error) {
    await admin?.end().catch(() => {});
    await database.stop().catch(() => {});
    await rm(directory, { recursive: true, force: true });
    throw new Error(`Isolated PostgreSQL failed: ${error?.message ?? error}\n${messages.slice(-4).join('\n')}`);
  }
}
