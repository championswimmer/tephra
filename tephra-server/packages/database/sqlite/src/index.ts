import { DatabaseSync } from 'node:sqlite';

import type { Database, Repositories, TransactionRepositories } from '@tephra/database-core';

import { migrate } from './migrate.js';
import { makeRepositories } from './repositories.js';
import { SerialExecutor, serialized } from './serial.js';

export interface SqliteDatabase extends Database {
  close(): void;
}
export interface OpenSqliteDatabaseOptions {
  filename: string;
  migrationFile?: string | URL;
}

export function openSqliteDatabase(options: OpenSqliteDatabaseOptions | string): SqliteDatabase {
  const normalized = typeof options === 'string' ? { filename: options } : options;
  const connection = new DatabaseSync(normalized.filename);
  try {
    connection.exec('PRAGMA foreign_keys = ON');
    connection.exec('PRAGMA busy_timeout = 5000');
    migrate(connection, normalized.migrationFile);
  } catch (error) {
    connection.close();
    throw error;
  }
  const direct = makeRepositories(connection);
  const executor = new SerialExecutor();
  const exposed = Object.fromEntries(Object.entries(direct).filter(([key]) => key !== 'lockVault').map(([key, repository]) => [key, serialized(repository as object, executor)])) as unknown as Repositories;
  let closed = false;
  return {
    ...exposed,
    transaction<T>(operation: (repositories: TransactionRepositories) => Promise<T>): Promise<T> {
      return executor.run(async () => {
        connection.exec('BEGIN IMMEDIATE');
        try {
          const result = await operation(direct);
          connection.exec('COMMIT');
          return result;
        } catch (error) {
          connection.exec('ROLLBACK');
          throw error;
        }
      });
    },
    close() {
      if (!closed) {
        connection.close();
        closed = true;
      }
    },
  };
}
