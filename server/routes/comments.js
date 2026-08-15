import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import * as iris from '../integrations/iris.js';
import * as missive from '../integrations/missive.js';

export const commentsRouter = Router();

// SQLite's own `datetime('now')` (used for local comments) produces UTC as
// "YYYY-MM-DD HH:MM:SS" -- no 'T', no 'Z'. IRIS timestamps carry a real
// offset (e.g. -04:00). Normalizing both to that exact same naive-UTC shape
// keeps `ORDER BY created_at` correct: mixing space- and 'T'-separated
// strings would sort wrong, since string comparison hits the differing
// separator character before it ever compares the actual time.
function toSqliteUtc(dateInput) {
  return new Date(dateInput).toISOString().slice(0, 19).replace('T', ' ');
}

commentsRouter.get('/task/:taskId', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY created_at DESC')
    .all(req.params.taskId);
  res.json(rows);
});

// Refresh the local comment cache for a task from its source (currently
// IRIS only — Missive threads are read live via /api/missive/thread).
commentsRouter.post('/task/:taskId/sync', async (req, res) => {
  // The whole handler is inside this try: Express 4 doesn't catch a
  // rejected promise from an async handler on its own, so an uncaught
  // throw in the DB lookup would otherwise hang the request instead of
  // erroring (see the same note in routes/iris.js).
  try {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'not found' });
    if (task.source !== 'iris') return res.json({ synced: 0 });

    const remoteComments = await iris.fetchTicketComments(task.source_id);
    const upsert = db.prepare(`
      INSERT INTO comments (id, task_id, body, author, origin, remote_id, created_at)
      VALUES (?, ?, ?, ?, 'iris', ?, ?)
      ON CONFLICT(id) DO NOTHING
    `);
    const existingRemoteIds = new Set(
      db.prepare("SELECT remote_id FROM comments WHERE task_id = ? AND origin = 'iris'").all(task.id).map((r) => r.remote_id)
    );
    let synced = 0;
    for (const c of remoteComments) {
      const remoteId = String(c.id);
      if (existingRemoteIds.has(remoteId)) continue;
      const createdAt = c.created?.date ? toSqliteUtc(c.created.date) : toSqliteUtc(new Date());
      upsert.run(randomUUID(), task.id, c.comment || '', c.created?.username || 'IRIS', remoteId, createdAt);
      synced++;
    }
    res.json({ synced });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

commentsRouter.post('/task/:taskId', async (req, res) => {
  // Outer try covers the whole handler for the same reason as the /sync
  // route above -- an uncaught throw in an async handler otherwise hangs
  // the request instead of erroring. The inner try/catch is separate and
  // intentional: it distinguishes "saved locally but failed to reach IRIS"
  // (207, still a partial success) from a genuine unexpected failure (500).
  try {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'not found' });
    const { body, author = 'me', notify, extendedFiles } = req.body;
    if (!body) return res.status(400).json({ error: 'body is required' });

    const id = randomUUID();
    db.prepare(
      "INSERT INTO comments (id, task_id, body, author, origin) VALUES (?, ?, ?, ?, 'local')"
    ).run(id, task.id, body, author);

    if (task.source === 'iris') {
      try {
        await iris.postTicketComment(task.source_id, body, notify, extendedFiles);
      } catch (err) {
        console.error(`[comments] failed to post to IRIS ticket ${task.source_id}:`, err.message);
        return res.status(207).json({
          comment: db.prepare('SELECT * FROM comments WHERE id = ?').get(id),
          warning: `Saved locally but failed to post to IRIS: ${err.message}`,
        });
      }
    } else if (task.source === 'missive') {
      // Missive's comment equivalent is a "post" on the underlying
      // conversation -- only possible when there is one (a standalone task
      // with no linked conversation has nothing to post to, so it stays
      // local-only, same as before this existed).
      const meta = task.meta ? JSON.parse(task.meta) : {};
      if (meta.conversationId) {
        try {
          await missive.postConversationComment(meta.conversationId, body);
        } catch (err) {
          console.error(`[comments] failed to post to Missive conversation ${meta.conversationId}:`, err.message);
          return res.status(207).json({
            comment: db.prepare('SELECT * FROM comments WHERE id = ?').get(id),
            warning: `Saved locally but failed to post to Missive: ${err.message}`,
          });
        }
      }
    }

    res.status(201).json(db.prepare('SELECT * FROM comments WHERE id = ?').get(id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
