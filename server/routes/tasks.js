import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';

export const tasksRouter = Router();

// Counts for the tab badges. 'resolved' is capped at 25 to match what the
// resolved tab itself actually displays (see the LIMIT below).
tasksRouter.get('/counts', (req, res) => {
  const open = db.prepare("SELECT COUNT(*) c FROM tasks WHERE status = 'open'").get().c;
  const resolved = db.prepare("SELECT COUNT(*) c FROM (SELECT id FROM tasks WHERE status = 'resolved' LIMIT 25)").get().c;
  const done = db.prepare("SELECT COUNT(*) c FROM tasks WHERE status = 'done'").get().c;
  res.json({ open, resolved, done });
});

// Matches MID, DBA (via merchant_cache), ticket type, title, and locally
// synced comment bodies. DBA/type/comments aren't columns on tasks, so this
// always joins/subqueries rather than being a simple LIKE on one column.
// Falls back through progressively less-specific timestamps so every task
// sorts sensibly even when the source doesn't have the preferred one yet
// (e.g. a brand-new ticket with no comments has no lastCommentAt; a manual
// task has no source timestamps at all).
const ADDED_SORT_SQL = "COALESCE(json_extract(t.meta, '$.createdAt'), strftime('%Y-%m-%dT%H:%M:%fZ', t.created_at))";
const LAST_COMMENT_SORT_SQL = `COALESCE(json_extract(t.meta, '$.lastCommentAt'), ${ADDED_SORT_SQL})`;

tasksRouter.get('/', (req, res) => {
  const { status, q, sort } = req.query; // 'open' | 'resolved' | 'done'; q = free-text search; sort = 'added' | 'comment'
  const orderSql = sort === 'comment' ? LAST_COMMENT_SORT_SQL : ADDED_SORT_SQL;
  const params = {};
  let searchSql = '';
  if (q) {
    params.q = `%${q}%`;
    searchSql = `
      AND (
        t.title LIKE @q OR
        json_extract(t.meta, '$.merchantId') LIKE @q OR
        json_extract(t.meta, '$.type') LIKE @q OR
        m.dba LIKE @q OR
        t.id IN (SELECT task_id FROM comments WHERE body LIKE @q)
      )`;
  }

  let rows;
  if (status === 'resolved') {
    // Resolved is API-driven, not manually ranked -- most recently resolved
    // first, capped to the last 25. Not affected by the sort param: this
    // ordering was a deliberate earlier decision, not the added/comment choice.
    params.status = status;
    rows = db.prepare(`
      SELECT t.* FROM tasks t
      LEFT JOIN merchant_cache m ON m.mid = json_extract(t.meta, '$.merchantId')
      WHERE t.status = @status ${searchSql}
      ORDER BY t.resolved_at DESC LIMIT 25
    `).all(params);
  } else if (status) {
    params.status = status;
    rows = db.prepare(`
      SELECT t.* FROM tasks t
      LEFT JOIN merchant_cache m ON m.mid = json_extract(t.meta, '$.merchantId')
      WHERE t.status = @status ${searchSql}
      ORDER BY ${orderSql} DESC, t.rowid DESC
    `).all(params);
  } else {
    rows = db.prepare(`
      SELECT t.* FROM tasks t
      LEFT JOIN merchant_cache m ON m.mid = json_extract(t.meta, '$.merchantId')
      WHERE 1=1 ${searchSql}
      ORDER BY ${orderSql} DESC, t.rowid DESC
    `).all(params);
  }
  res.json(rows.map(withParsedMeta));
});

tasksRouter.post('/', (req, res) => {
  const { title, url, importance = 2 } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  const id = randomUUID();
  db.prepare(
    `INSERT INTO tasks (id, source, source_id, title, url, importance, status)
     VALUES (?, 'manual', ?, ?, ?, ?, 'open')`
  ).run(id, id, title, url || null, importance);
  res.status(201).json(withParsedMeta(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)));
});

tasksRouter.patch('/:id', (req, res) => {
  const { id } = req.params;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return res.status(404).json({ error: 'not found' });

  const { importance, status } = req.body;
  // 'resolved' is API-driven only -- see server/poller.js and the UI's
  // QUICK_MOVE_TARGETS note. It's not just hidden from the dropdown: a raw
  // PATCH here actually pushes a real status change to IRIS (below), so
  // this has to be enforced server-side, not just left to the UI.
  if (status === 'resolved') {
    return res.status(400).json({ error: "'resolved' can only be set by the source sync, not manually" });
  }
  const fields = [];
  const values = [];

  if (importance !== undefined) {
    fields.push('importance = ?');
    values.push(importance);
  }
  // Only 'open' and 'done' can reach here -- 'resolved' was rejected above.
  if (status !== undefined) {
    fields.push('status = ?');
    values.push(status);
    if (status === 'done') {
      fields.push("done_at = datetime('now')");
    }
  }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });

  fields.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  // 'open' and 'done' are both purely local, read-only with respect to the
  // source -- neither ever writes back to IRIS/Missive. Only the source
  // sync (poller.js) can move a ticket to 'resolved', and that's the only
  // status this dashboard ever pushes anywhere (via comments, not status).

  res.json(withParsedMeta(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)));
});

tasksRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

function withParsedMeta(row) {
  if (!row) return row;
  return { ...row, meta: row.meta ? JSON.parse(row.meta) : null };
}
