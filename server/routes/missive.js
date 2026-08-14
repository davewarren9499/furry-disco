import { Router } from 'express';
import { db } from '../db.js';
import * as missive from '../integrations/missive.js';

export const missiveRouter = Router();

// Live thread + task info for a Missive-sourced task, fetched fresh so
// replies sent from Missive itself show up without waiting for a poll.
missiveRouter.get('/thread/:taskId', async (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.taskId);
  if (!task || task.source !== 'missive') return res.status(404).json({ error: 'not a missive task' });

  try {
    const messages = await missive.fetchConversationMessages(task.source_id);
    res.json({
      task: { ...task, meta: task.meta ? JSON.parse(task.meta) : null },
      messages: messages.map((m) => ({
        id: m.id,
        from: m.from_field?.address || m.from,
        subject: m.subject,
        preview: m.preview,
        createdAt: m.delivered_at || m.created_at,
        url: missive.conversationUrl(task.source_id),
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
