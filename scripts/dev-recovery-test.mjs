import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// This runner cannot read a real/local user's ledger or cloud credentials.
const recoveryTestDirectory = mkdtempSync(join(tmpdir(), 'ttq-browser-recovery-'));
process.env.TTQ_SQLITE_PATH = join(recoveryTestDirectory, 'isolated.db');
process.env.TTQ_ALLOWED_ORIGINS = 'http://127.0.0.1:3107';
process.env.TTQ_NEXT_DIST_DIR = '.next-browser-test';
process.argv = [process.execPath, process.argv[1], '--hostname', '127.0.0.1', '--port', '3107'];
process.on('exit', () => rmSync(recoveryTestDirectory, { recursive: true, force: true }));
await import('./dev-local.mjs');
