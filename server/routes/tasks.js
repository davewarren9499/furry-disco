import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import * as missive from '../integrations/missive.js';
import { pollMissive } from '../poller.js';

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

// "Needs my attention": an @mention (whether that's why the ticket is on
// the board at all, or one buried in the comments of a ticket I'm already
// assigned to -- see server/poller.js) or Rush priority. Its own endpoint
// (rather than reusing GET /) because the notification bell needs this
// count/list regardless of which tab or filters are currently active.
tasksRouter.get('/attention', (req, res) => {
  const rows = db.prepare(`
    SELECT t.* FROM tasks t
    WHERE t.status = 'open' AND (
      t.reason = 'mentioned' OR
      json_extract(t.meta, '$.mentionedInComments') = 1 OR
      json_extract(t.meta, '$.priority') = 'Rush'
    )
    ORDER BY ${ADDED_SORT_SQL} DESC, t.rowid DESC
  `).all();
  res.json(rows.map(withParsedMeta));
});

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

tasksRouter.post('/', async (req, res) => {
  const { title, url, importance = 2, createInMissive, description } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });

  if (createInMissive) {
    // Create the real task in Missive, then pull the fresh sync back in
    // immediately (rather than duplicate poller.js's upsert/normalize
    // logic here) so it shows up in this response without waiting for the
    // next scheduled poll. importance/url are dashboard-only concepts
    // Missive has no equivalent for, so they're just dropped here.
    try {
      const created = await missive.createTask({ title, description });
      await pollMissive();
      const row = db.prepare('SELECT * FROM tasks WHERE source = ? AND source_id = ?').get('missive', String(created.id));
      return res.status(201).json(withParsedMeta(row));
    } catch (err) {
      return res.status(502).json({ error: `Failed to create Missive task: ${err.message}` });
    }
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO tasks (id, source, source_id, title, url, importance, status)
     VALUES (?, 'manual', ?, ?, ?, ?, 'open')`
  ).run(id, id, title, url || null, importance);
  res.status(201).json(withParsedMeta(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)));
});

tasksRouter.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!task) return res.status(404).json({ error: 'not found' });

  const { importance, status } = req.body;
  // 'resolved' is API-driven only for IRIS -- see server/poller.js and the
  // UI's QUICK_MOVE_TARGETS note. A raw PATCH here would otherwise push a
  // real status change to a live IRIS ticket, so that's enforced server-
  // side, not just left to the UI. Missive is the deliberate exception:
  // Missive genuinely supports closing from an integration cleanly (see
  // closeConversation/updateTaskState below), so manually resolving is
  // allowed there and pushed for real.
  if (status === 'resolved' && task.source !== 'missive') {
    return res.status(400).json({ error: "'resolved' can only be set by the source sync, not manually" });
  }
  const fields = [];
  const values = [];

  if (importance !== undefined) {
    fields.push('importance = ?');
    values.push(importance);
  }
  if (status !== undefined) {
    fields.push('status = ?');
    values.push(status);
    if (status === 'done') {
      fields.push("done_at = datetime('now')");
    }
    if (status === 'resolved') {
      fields.push("resolved_at = datetime('now')");
    }
  }
  if (!fields.length) return res.status(400).json({ error: 'nothing to update' });

  fields.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  // 'open' and 'done' are purely local for both sources; 'resolved' for
  // IRIS never reaches here (rejected above). Closing a Missive task is
  // the one real write-back a status change makes: which API call depends
  // on whether this is a real Task object or a bare tasked-conversation
  // (see normalizeMissiveTask). Local state is already committed above
  // regardless of whether the push below succeeds -- same partial-success
  // pattern as comments.js.
  if (status === 'resolved' && task.source === 'missive') {
    const meta = task.meta ? JSON.parse(task.meta) : {};
    try {
      if (meta.taskType === 'task') {
        await missive.updateTaskState(task.source_id, 'closed');
      } else if (meta.conversationId) {
        await missive.closeConversation(meta.conversationId);
      }
    } catch (err) {
      console.error(`[tasks] failed to push close to Missive for ${task.source_id}:`, err.message);
      return res.status(207).json({
        task: withParsedMeta(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)),
        warning: `Closed locally but failed to close in Missive: ${err.message}`,
      });
    }
  }

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
