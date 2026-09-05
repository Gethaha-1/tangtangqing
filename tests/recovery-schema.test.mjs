import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { RECOVERY_SCHEMA_STATEMENTS } from '../db/recovery-schema.ts';

for (const mode of ['migration', 'runtime']) test(`SQLite recovery ${mode}: additive, constrained, revision-aware and atomic`, () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for (const name of ['0000_public_wildside', '0001_smart_the_twelve', '0002_lonely_shriek'])
      db.exec(readFileSync(new URL(`../drizzle/${name}.sql`, import.meta.url), 'utf8'));
    db.exec("INSERT INTO users(id) VALUES('u'); INSERT INTO fleets(id,name,created_by_user_id) VALUES('f','测试','u'); INSERT INTO fleet_members(id,fleet_id,user_id,role) VALUES('m','f','u','owner'); INSERT INTO categories(fleet_id,id,kind,name) VALUES('f','old','expense','旧科目');");
    const old = db.prepare('SELECT * FROM categories').all();
    if (mode === 'migration') db.exec(readFileSync(new URL('../drizzle/0003_tranquil_lockjaw.sql', import.meta.url), 'utf8'));
    else for (const sql of RECOVERY_SCHEMA_STATEMENTS) db.exec(sql);
    // Runtime can safely open an already migrated local database.
    for (const sql of RECOVERY_SCHEMA_STATEMENTS) db.exec(sql);
    assert.deepEqual(db.prepare('SELECT * FROM categories').all(), old);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE '%_ledger_revision_%'").get().n, 21);
    const revision = () => db.prepare("SELECT version FROM fleets WHERE id='f'").get().version;
    const initial = revision();
    db.exec("INSERT INTO categories(fleet_id,id,kind,name) VALUES('f','new','expense','新科目'); UPDATE categories SET name='改名' WHERE id='new'; DELETE FROM categories WHERE id='new';");
    assert.equal(revision(), initial + 3);
    db.exec('BEGIN');
    db.exec("UPDATE categories SET name='未确认' WHERE id='old'");
    db.exec('ROLLBACK');
    assert.equal(revision(), initial + 3);
    assert.deepEqual(db.prepare('SELECT * FROM categories').all(), old);
    db.exec("INSERT INTO restore_jobs(fleet_id,id,membership_id,user_id,base_version,manifest_json,created_at,expires_at) VALUES('f','j','m','u',1,'{}','now','later'); INSERT INTO restore_chunks VALUES('f','j',0,'hash','[]');");
    assert.throws(() => db.exec("INSERT INTO restore_chunks VALUES('f','j',256,'hash','[]')"), /CHECK/);
    assert.throws(() => db.exec("INSERT INTO restore_jobs(fleet_id,id,membership_id,user_id,base_version,manifest_json,created_at,expires_at) VALUES('f','j2','m','u',1,'{}','now','later')"), /UNIQUE/);
    db.exec("DELETE FROM restore_jobs WHERE id='j'");
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM restore_chunks').get().n, 0);
    assert.deepEqual(db.prepare('SELECT * FROM categories').all(), old);
  } finally { db.close(); }
});
