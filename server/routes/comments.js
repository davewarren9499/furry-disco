import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import * as iris from '../integrations/iris.js';

export const commentsRouter = Router();

commentsRouter.get('/task/:taskId', (req, res) => {
  const rows = db
    .prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY created_at DESC')
    .all(req.params.taskId);
  res.json(rows);
});

// Refresh the local comment cache for a task from its source (currently
// IRIS only — Missive threads are read live via /api/missive/thread).
commentsRouter.post('/task/:taskId/sync', async (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'not found' });
  if (task.source !== 'iris') return res.json({ synced: 0 });

  try {
    const remoteComments = await iris.fetchTicketComments(task.source_id);
    const upsert = db.prepare(`
      INSERT INTO comments (id, task_id, body, author, origin, remote_id)
      VALUES (?, ?, ?, ?, 'iris', ?)
      ON CONFLICT(id) DO NOTHING
    `);
    const existingRemoteIds = new Set(
      db.prepare("SELECT remote_id FROM comments WHERE task_id = ? AND origin = 'iris'").all(task.id).map((r) => r.remote_id)
    );
    let synced = 0;
    for (const c of remoteComments) {
      const remoteId = String(c.id);
      if (existingRemoteIds.has(remoteId)) continue;
      upsert.run(randomUUID(), task.id, c.body || c.text || '', c.author_name || c.author || 'IRIS', remoteId);
      synced++;
    }
    res.json({ synced });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

commentsRouter.post('/task/:taskId', async (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.taskId);
  if (!task) return res.status(404).json({ error: 'not found' });
  const { body, author = 'me' } = req.body;
  if (!body) return res.status(400).json({ error: 'body is required' });

  const id = randomUUID();
  db.prepare(
    "INSERT INTO comments (id, task_id, body, author, origin) VALUES (?, ?, ?, ?, 'local')"
  ).run(id, task.id, body, author);

  if (task.source === 'iris') {
    try {
      await iris.postTicketComment(task.source_id, body);
    } catch (err) {
      console.error(`[comments] failed to post to IRIS ticket ${task.source_id}:`, err.message);
      return res.status(207).json({
        comment: db.prepare('SELECT * FROM comments WHERE id = ?').get(id),
        warning: `Saved locally but failed to post to IRIS: ${err.message}`,
      });
    }
  }

  res.status(201).json(db.prepare('SELECT * FROM comments WHERE id = ?').get(id));
});
