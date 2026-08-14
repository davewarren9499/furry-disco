import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../db.js';

export const templatesRouter = Router();

templatesRouter.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM comment_templates ORDER BY name ASC').all());
});

templatesRouter.post('/', (req, res) => {
  const { name, body } = req.body;
  if (!name || !body) return res.status(400).json({ error: 'name and body are required' });
  const id = randomUUID();
  db.prepare('INSERT INTO comment_templates (id, name, body) VALUES (?, ?, ?)').run(id, name, body);
  res.status(201).json(db.prepare('SELECT * FROM comment_templates WHERE id = ?').get(id));
});

templatesRouter.patch('/:id', (req, res) => {
  const { name, body } = req.body;
  const existing = db.prepare('SELECT * FROM comment_templates WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE comment_templates SET name = ?, body = ? WHERE id = ?').run(
    name ?? existing.name,
    body ?? existing.body,
    req.params.id
  );
  res.json(db.prepare('SELECT * FROM comment_templates WHERE id = ?').get(req.params.id));
});

templatesRouter.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM comment_templates WHERE id = ?').run(req.params.id);
  res.status(204).end();
});
