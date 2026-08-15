import { Router, raw } from 'express';
import { db } from '../db.js';
import * as iris from '../integrations/iris.js';

export const irisRouter = Router();

// Accepts the raw file body directly (no multipart/multer needed -- the
// browser sends the File/Blob as-is via fetch). Scoped to this one route
// only, separate from the app-wide express.json() in index.js.
const rawFileBody = raw({ type: '*/*', limit: '25mb' });

// Live ticket info for an IRIS-sourced task, fetched fresh so status/priority
// changes made in IRIS itself show up without waiting for a poll.
irisRouter.get('/ticket/:taskId', async (req, res) => {
  // The whole handler (including the DB lookup) is inside this try: Express
  // 4 doesn't catch a rejected promise from an async handler on its own, so
  // an uncaught throw here (e.g. a SQLITE_BUSY from the poller writing at
  // the same moment) would otherwise hang the request instead of erroring.
  try {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.taskId);
    if (!task || task.source !== 'iris') return res.status(404).json({ error: 'not an iris task' });

    const detail = await iris.fetchTicketDetail(task.source_id);
    const g = detail.general || {};
    // Comment attachments live on each comment in the live detail response,
    // but our local comments table (what the dashboard actually displays --
    // see /api/comments) doesn't store files. Keying by remote comment id
    // lets the frontend attach file chips to the comments it already has
    // without a DB migration.
    const commentFiles = {};
    for (const c of detail.comments || []) {
      if (c.files?.length) commentFiles[c.id] = c.files.map((f) => ({ id: f.id, name: f.name, size: f.size }));
    }
    res.json({
      id: g.id,
      subject: g.subject,
      description: g.description,
      status: g.status?.name,
      priority: g.priority?.name,
      type: g.type?.name,
      group: g.group?.name,
      merchantId: g.mid,
      dueDate: g.due_date,
      due: g.due,
      createdAt: g.created,
      createdBy: g.created_username,
      resolvedAt: g.resolved,
      resolvedBy: g.resolved_username,
      assignedUsers: (g.assigned_users || []).map((u) => u.name),
      // {id, name} pairs, distinct from assignedUsers above (which is just
      // names, already used for the "Assigned to" display field) -- the
      // comment composer's notify picker needs real IDs to send to IRIS.
      assignees: (g.assigned_users || []).map((u) => ({ id: u.id, name: u.name })),
      url: iris.ticketUrl(g.id),
      files: (detail.files || []).map((f) => ({ id: f.id, name: f.name, size: f.size })),
      commentFiles,
      // Other open tickets for the same merchant -- pulled from our own
      // already-synced local data (every iris task's meta.merchantId is
      // set at sync time), so this costs a local query, not another IRIS
      // API call. Lets you notice "there are 3 other open tickets for this
      // merchant" without leaving the one you're on.
      relatedOpenTickets: g.mid
        ? db.prepare(`
            SELECT id, title, meta FROM tasks
            WHERE source = 'iris' AND status = 'open'
              AND source_id != @sourceId
              AND json_extract(meta, '$.merchantId') = @mid
            ORDER BY COALESCE(json_extract(meta, '$.createdAt'), created_at) DESC
          `).all({ sourceId: task.source_id, mid: g.mid })
            .map((t) => ({ id: t.id, title: t.title, type: JSON.parse(t.meta || '{}').type || null }))
        : [],
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Proxies the attachment download so the browser never needs the IRIS API
// key. PDFs and images are served inline (so the browser -- or our own
// <iframe> viewer for PDFs -- can render them directly); everything else
// downloads, since there's no generic in-browser viewer for it.
const INLINE_MIME = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

irisRouter.get('/ticket/:taskId/attachment/:attachmentId', async (req, res) => {
  try {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.taskId);
    if (!task || task.source !== 'iris') return res.status(404).json({ error: 'not an iris task' });

    const buf = await iris.fetchTicketAttachment(task.source_id, req.params.attachmentId);
    const ext = String(req.query.name || '').split('.').pop().toLowerCase();
    const mime = INLINE_MIME[ext];
    res.setHeader('Content-Type', mime || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `${mime ? 'inline' : 'attachment'}; filename="${(req.query.name || 'file').replace(/"/g, '')}"`
    );
    res.send(buf);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Step 1 of attaching a file to a new comment (see iris.uploadTicketFile).
// The browser never needs the IRIS API key for this either -- same proxy
// pattern as the attachment download route above.
irisRouter.post('/ticket/:taskId/upload', rawFileBody, async (req, res) => {
  try {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.taskId);
    if (!task || task.source !== 'iris') return res.status(404).json({ error: 'not an iris task' });

    const filename = String(req.query.name || 'file');
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: 'empty file body' });
    }
    const fileId = await iris.uploadTicketFile(req.body, filename);
    res.json({ fileId });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

const getCachedDba = db.prepare('SELECT dba FROM merchant_cache WHERE mid = ?');
const upsertDba = db.prepare(`
  INSERT INTO merchant_cache (mid, dba) VALUES (?, ?)
  ON CONFLICT(mid) DO UPDATE SET dba = excluded.dba, cached_at = datetime('now')
`);

// DBA names for a batch of merchant ids, cached indefinitely (DBA names
// rarely change) since IRIS has no bulk lookup endpoint -- each new mid
// costs one real API call, ever.
irisRouter.get('/merchants', async (req, res) => {
  // Per-mid failures are caught individually below (one bad mid shouldn't
  // sink the whole batch); this outer try only guards against something
  // unexpected at the request level, e.g. the cache lookup loop itself.
  try {
    const mids = String(req.query.mids || '').split(',').map((m) => m.trim()).filter(Boolean);
    const result = {};
    const misses = [];
    for (const mid of mids) {
      const cached = getCachedDba.get(mid);
      if (cached) result[mid] = cached.dba;
      else misses.push(mid);
    }

    const CONCURRENCY = 5;
    for (let i = 0; i < misses.length; i += CONCURRENCY) {
      const batch = misses.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (mid) => {
          try {
            const dba = await iris.fetchMerchantDba(mid);
            upsertDba.run(mid, dba);
            result[mid] = dba;
          } catch (err) {
            console.error(`[iris] failed to fetch DBA for mid ${mid}:`, err.message);
          }
        })
      );
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
