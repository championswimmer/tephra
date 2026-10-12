import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

import { first, requiredNumber } from './rows.js';

const MIGRATIONS_URL = new URL('../../../../migrations/sqlite/', import.meta.url);
const MIGRATIONS = [
  { version: 1, file: '001_initial.sql' },
  { version: 2, file: '002_vault_name_unique.sql' },
  { version: 3, file: '003_vault_files_path_fold.sql' },
  { version: 4, file: '004_graph_cache.sql' },
  { version: 5, file: '005_revision_manifest_hash_index.sql' },
] as const;

export function migrate(db: DatabaseSync, migrationFile: string | URL | undefined): void {
  const versionRow = first(db, 'PRAGMA user_version');
  const version = versionRow ? requiredNumber(versionRow, 'user_version') : 0;
  const latest = MIGRATIONS[MIGRATIONS.length - 1]!.version;
  if (version > latest) throw new Error(`SQLite schema version ${version} is newer than supported version ${latest}`);
  // A custom migration file replaces the whole chain (used by tests). The
  // production migrations live under the default migrations directory.
  if (migrationFile === undefined && version === latest) return;
  // Table rebuilds (005) drop a parent table that file_versions references
  // with a composite FK: with enforcement on, DROP TABLE would
  // cascade-delete the child rows, and PRAGMA foreign_keys is a no-op inside
  // a transaction, so enforcement is suspended around the whole run (this
  // connection is still private to openSqliteDatabase — nothing else can
  // write concurrently) and foreign_key_check runs before the stamp.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (migrationFile !== undefined) {
      const sql = readFileSync(migrationFile instanceof URL ? fileURLToPath(migrationFile) : migrationFile, 'utf8');
      db.exec(sql);
    } else {
      for (const migration of MIGRATIONS) {
        if (migration.version <= version) continue;
        const sql = readFileSync(fileURLToPath(new URL(migration.file, MIGRATIONS_URL)), 'utf8');
        db.exec(sql);
      }
    }
    const violations = db.prepare('PRAGMA foreign_key_check').all() as Array<unknown>;
    if (violations.length > 0) {
      throw new Error(`SQLite foreign_key_check failed: ${JSON.stringify(violations)}`);
    }
    db.exec(`PRAGMA user_version = ${latest}`);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Prefer the original failure when rollback itself cannot run.
    }
    throw error;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
