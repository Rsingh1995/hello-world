// SQLite storage (Node's built-in node:sqlite). One file, WAL mode: comfortably handles
// thousands of students because the simulation itself runs in the browser and the
// server only stores results.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS users (
     id INTEGER PRIMARY KEY,
     username TEXT NOT NULL UNIQUE COLLATE NOCASE,
     name TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('admin','teacher','student')),
     password_hash TEXT NOT NULL,
     must_change_password INTEGER NOT NULL DEFAULT 0,
     active INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     last_login_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     expires_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS cohorts (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL,
     join_code TEXT NOT NULL UNIQUE,
     enrol_open INTEGER NOT NULL DEFAULT 1,
     open_practice INTEGER NOT NULL DEFAULT 1,
     archived INTEGER NOT NULL DEFAULT 0,
     created_by INTEGER REFERENCES users(id),
     created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS cohort_members (
     cohort_id INTEGER NOT NULL REFERENCES cohorts(id) ON DELETE CASCADE,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     member_role TEXT NOT NULL CHECK (member_role IN ('student','teacher')),
     added_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (cohort_id, user_id))`,
  `CREATE INDEX IF NOT EXISTS cohort_members_user ON cohort_members(user_id)`,
  `CREATE TABLE IF NOT EXISTS cases (
     id TEXT PRIMARY KEY,
     status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
     current_version INTEGER NOT NULL,
     title TEXT NOT NULL,
     complaint TEXT NOT NULL,
     discipline TEXT,
     difficulty TEXT,
     builtin INTEGER NOT NULL DEFAULT 0,
     author_id INTEGER REFERENCES users(id),
     reviewed_by TEXT,
     reviewed_at TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS case_versions (
     case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
     version INTEGER NOT NULL,
     data TEXT NOT NULL,
     note TEXT,
     saved_by INTEGER REFERENCES users(id),
     saved_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (case_id, version))`,
  `CREATE TABLE IF NOT EXISTS assignments (
     id INTEGER PRIMARY KEY,
     cohort_id INTEGER NOT NULL REFERENCES cohorts(id) ON DELETE CASCADE,
     case_id TEXT NOT NULL REFERENCES cases(id),
     title TEXT,
     mode TEXT NOT NULL DEFAULT 'practice' CHECK (mode IN ('practice','assessment')),
     due_at TEXT,
     max_attempts INTEGER,
     show_debrief INTEGER NOT NULL DEFAULT 1,
     archived INTEGER NOT NULL DEFAULT 0,
     created_by INTEGER REFERENCES users(id),
     created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE INDEX IF NOT EXISTS assignments_cohort ON assignments(cohort_id)`,
  `CREATE TABLE IF NOT EXISTS attempts (
     id INTEGER PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     case_id TEXT NOT NULL REFERENCES cases(id),
     case_version INTEGER NOT NULL,
     assignment_id INTEGER REFERENCES assignments(id) ON DELETE SET NULL,
     started_at TEXT NOT NULL DEFAULT (datetime('now')),
     finished_at TEXT,
     score INTEGER,
     passed INTEGER,
     outcome TEXT,
     sim_seconds INTEGER,
     end_reason TEXT,
     summary TEXT,
     details TEXT)`,
  `CREATE INDEX IF NOT EXISTS attempts_user ON attempts(user_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS attempts_assignment ON attempts(assignment_id)`,
  `CREATE INDEX IF NOT EXISTS attempts_case ON attempts(case_id)`
];

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  for (const s of SCHEMA) db.exec(s);
  db.prepare(`INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1')`).run();
  return db;
}

/** Run fn inside a transaction; rolls back on error. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
