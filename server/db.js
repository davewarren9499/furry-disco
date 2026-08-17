import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data.sqlite');

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,              -- 'iris' | 'missive' | 'manual'
  source_id TEXT,                    -- id in the origin system
  title TEXT NOT NULL,
  url TEXT,                          -- deep link back to source
  importance INTEGER NOT NULL DEFAULT 2,  -- 1 low, 2 normal, 3 high, 4 urgent
  status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'resolved' | 'done'
  reason TEXT,                       -- why it's on the board: 'assigned' | 'mentioned'
  assignee TEXT,
  meta TEXT,                         -- JSON blob: extra source-specific fields
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  done_at TEXT,
  UNIQUE(source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  author TEXT,
  origin TEXT NOT NULL DEFAULT 'local', -- 'local' | 'iris' (pulled from remote)
  remote_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);

CREATE TABLE IF NOT EXISTS comment_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- DBA name rarely changes, so we cache it per merchant id instead of
-- looking it up on every poll (IRIS has no bulk "DBA by mid list" endpoint).
CREATE TABLE IF NOT EXISTS merchant_cache (
  mid TEXT PRIMARY KEY,
  dba TEXT,
  cached_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Migration: 'rank' was drag-and-drop ordering, removed when manual
// reordering was dropped in favor of sorting by date added/last comment.
// CREATE TABLE IF NOT EXISTS above doesn't touch existing databases that
// still have the column, so this drops it explicitly, once, on any db that
// predates the change. table_info check keeps it a no-op on fresh installs
// and on every subsequent boot of an already-migrated database.
const hasRankColumn = db.prepare("SELECT 1 FROM pragma_table_info('tasks') WHERE name = 'rank'").get();
if (hasRankColumn) {
  db.exec('ALTER TABLE tasks DROP COLUMN rank');
}

export function getSyncState(key) {
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setSyncState(key, value) {
  db.prepare(
    'INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}
