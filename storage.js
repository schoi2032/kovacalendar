import { DatabaseSync } from 'node:sqlite';

export function storage(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, subject TEXT UNIQUE, name TEXT NOT NULL, email TEXT);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user TEXT REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth (state TEXT PRIMARY KEY, session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      verifier TEXT NOT NULL, mode TEXT NOT NULL, account TEXT, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, user TEXT NOT NULL REFERENCES users(id),
      subject TEXT NOT NULL UNIQUE, email TEXT, refresh TEXT NOT NULL, scopes TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS calendars (id TEXT PRIMARY KEY, user TEXT NOT NULL REFERENCES users(id),
      account TEXT REFERENCES accounts(id) ON DELETE CASCADE, remote TEXT, name TEXT NOT NULL, color TEXT NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0, direction TEXT NOT NULL DEFAULT 'native', role TEXT, zone TEXT,
      sync_token TEXT, full_sync INTEGER NOT NULL DEFAULT 0, last_sync TEXT, error TEXT, failures INTEGER NOT NULL DEFAULT 0,
      due INTEGER NOT NULL DEFAULT 0, watch_due INTEGER NOT NULL DEFAULT 0, watch_error TEXT,
      UNIQUE(account, remote));
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, calendar TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
      google_id TEXT, data TEXT NOT NULL, remote_data TEXT, etag TEXT, synced TEXT,
      status TEXT NOT NULL DEFAULT 'synced', deleted INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
      operation TEXT, local_origin INTEGER NOT NULL DEFAULT 0, UNIQUE(calendar, google_id));
    CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, calendar TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
      token TEXT NOT NULL, resource TEXT, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY, calendar TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
      at TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS events_calendar ON events(calendar);
    CREATE INDEX IF NOT EXISTS calendars_due ON calendars(due) WHERE account IS NOT NULL;
    CREATE INDEX IF NOT EXISTS logs_calendar ON logs(calendar,id);
  `);
  return {
    get: (sql, ...args) => db.prepare(sql).get(...args),
    all: (sql, ...args) => db.prepare(sql).all(...args),
    run: (sql, ...args) => db.prepare(sql).run(...args),
    close: () => db.close(),
    transaction(work) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = work();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
