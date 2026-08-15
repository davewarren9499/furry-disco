import { Router } from 'express';
import { db } from '../db.js';
import * as missive from '../integrations/missive.js';

export const missiveRouter = Router();

// Live thread + task info for a Missive-sourced task, fetched fresh so
// replies sent from Missive itself show up without waiting for a poll.
missiveRouter.get('/thread/:taskId', async (req, res) => {
  // Whole handler inside this try -- see the same note in routes/iris.js
  // and routes/comments.js: an uncaught throw in an async Express 4
  // handler otherwise hangs the request instead of erroring.
  try {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.taskId);
    if (!task || task.source !== 'missive') return res.status(404).json({ error: 'not a missive task' });

    // source_id is the *task's own* id now (see normalizeMissiveTask), which
    // for a subtask is a different id than its parent conversation -- the
    // conversation to actually fetch a thread for lives in meta instead.
    // Standalone tasks (no conversation at all) have neither.
    const meta = task.meta ? JSON.parse(task.meta) : {};
    const conversationId = meta.conversationId;
    if (!conversationId) return res.json({ subject: null, messages: [] });

    const [subject, messages] = await Promise.all([
      missive.fetchConversationSubject(conversationId),
      missive.fetchConversationMessages(conversationId),
    ]);
    res.json({
      subject,
      messages: messages.map((m) => ({
        id: m.id,
        from: m.from_field?.address || m.from,
        subject: m.subject,
        preview: m.preview,
        createdAt: m.delivered_at || m.created_at,
        url: missive.conversationUrl(conversationId),
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
