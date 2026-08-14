import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import * as iris from '../integrations/iris.js';

export const tasksRouter = Router();

tasksRouter.get('/', (req, res) => {
  const { status } = req.query; // 'open' | 'resolved' | 'done'
  const rows = status
    ? db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY rank ASC, importance DESC, updated_at DESC').all(status)
    : db.prepare('SELECT * FROM tasks ORDER BY rank ASC, importance DESC, updated_at DESC').all();
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

  const { importance, rank, status } = req.body;
  const fields = [];
  const values = [];

  if (importance !== undefined) {
    fields.push('importance = ?');
    values.push(importance);
  }
  if (rank !== undefined) {
    fields.push('rank = ?');
    values.push(rank);
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

  // Push status changes for IRIS-sourced tasks back to IRIS so it stays in
  // sync (e.g. marking a ticket resolved from the dashboard closes it in
  // IRIS too). Missive has no equivalent ticket-status concept.
  if (status && task.source === 'iris' && status !== 'done') {
    iris.updateTicketStatus(task.source_id, status === 'resolved' ? 'resolved' : 'open').catch((err) => {
      console.error(`[tasks] failed to push status to IRIS for ${task.source_id}:`, err.message);
    });
  }

  res.json(withParsedMeta(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)));
});

// Bulk re-rank: body is an ordered array of task ids (drag-and-drop result).
tasksRouter.post('/reorder', (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds must be an array' });
  const stmt = db.prepare('UPDATE tasks SET rank = ? WHERE id = ?');
  const tx = db.transaction((ids) => {
    ids.forEach((id, index) => stmt.run(index, id));
  });
  tx(orderedIds);
  res.json({ ok: true });
});

tasksRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

function withParsedMeta(row) {
  if (!row) return row;
  return { ...row, meta: row.meta ? JSON.parse(row.meta) : null };
}
