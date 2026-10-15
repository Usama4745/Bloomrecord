import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { MIGRATIONS } from './migrations';

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  sqlite: Database.Database;
  db: AppDatabase;
  close(): void;
}

/** Opens (creating if needed) the SQLite database and applies pending migrations. Use ':memory:' in tests. */
export function openDatabase(file: string, migrations = MIGRATIONS): DatabaseHandle {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  runMigrations(sqlite, migrations);
  const db = drizzle(sqlite, { schema });
  return { sqlite, db, close: () => sqlite.close() };
}

export function runMigrations(sqlite: Database.Database, migrations: ReadonlyArray<{ id: string; sql: string }>): string[] {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS __migrations (id TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)`);
  const applied = new Set(
    (sqlite.prepare('SELECT id FROM __migrations').all() as Array<{ id: string }>).map((r) => r.id),
  );
  const ran: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    const statements = m.sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    sqlite.transaction(() => {
      for (const stmt of statements) sqlite.exec(stmt);
      sqlite.prepare('INSERT INTO __migrations (id, applied_at) VALUES (?, ?)').run(m.id, Date.now());
    })();
    ran.push(m.id);
  }
  return ran;
}
