import { randomUUID } from 'node:crypto';
import { db, getSyncState, setSyncState } from './db.js';
import * as iris from './integrations/iris.js';
import * as missive from './integrations/missive.js';

const upsertTask = db.prepare(`
  INSERT INTO tasks (id, source, source_id, title, url, status, reason, assignee, meta, updated_at)
  VALUES (@id, @source, @source_id, @title, @url, @status, @reason, @assignee, @meta, datetime('now'))
  ON CONFLICT(source, source_id) DO UPDATE SET
    title = excluded.title,
    url = excluded.url,
    reason = excluded.reason,
    assignee = excluded.assignee,
    meta = excluded.meta,
    updated_at = datetime('now'),
    -- resolved_at is set the moment a still-open row flips to resolved
    resolved_at = CASE
      WHEN tasks.status != 'resolved' AND excluded.status = 'resolved' THEN datetime('now')
      ELSE tasks.resolved_at
    END,
    -- never overwrite a status a human already moved to 'done'; otherwise
    -- follow the remote source's status
    status = CASE WHEN tasks.status = 'done' THEN 'done' ELSE excluded.status END
`);

const findExisting = db.prepare('SELECT id FROM tasks WHERE source = ? AND source_id = ?');

function upsert(normalized) {
  const existing = findExisting.get(normalized.source, normalized.source_id);
  upsertTask.run({ id: existing ? existing.id : randomUUID(), ...normalized });
}

export async function pollIris() {
  if (!process.env.IRIS_API_KEY) return { skipped: 'IRIS_API_KEY not set' };

  const assigned = await iris.fetchMyTickets();
  for (const ticket of assigned) {
    upsert(iris.normalizeTicket(ticket, 'assigned'));
  }

  // Scan tickets updated since the last poll for @mentions of me in new
  // comments, even when I'm not the assignee (e.g. someone loops me in).
  const lastPoll = getSyncState('iris_last_poll') || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const updated = await iris.fetchRecentlyUpdatedTickets(lastPoll);
  for (const ticket of updated) {
    if (assigned.some((t) => String(t.id) === String(ticket.id))) continue; // already handled above
    try {
      const comments = await iris.fetchTicketComments(ticket.id);
      if (comments.some(iris.commentMentionsMe)) {
        upsert(iris.normalizeTicket(ticket, 'mentioned'));
      }
    } catch (err) {
      console.error(`[iris] failed to check comments for ticket ${ticket.id}:`, err.message);
    }
  }

  setSyncState('iris_last_poll', new Date().toISOString());
  pruneResolved('iris');
  return { assigned: assigned.length, scannedForMentions: updated.length };
}

export async function pollMissive() {
  if (!process.env.MISSIVE_API_TOKEN) return { skipped: 'MISSIVE_API_TOKEN not set' };

  const conversations = await missive.fetchAssignedConversations();
  for (const conv of conversations) {
    upsert(missive.normalizeConversation(conv));
  }
  pruneResolved('missive');
  return { assigned: conversations.length };
}

// Keep only the most recent 50 resolved tasks per source visible; older
// resolved ones are deleted to bound table growth (done tasks are untouched
// since they're a deliberate, user-controlled bucket, not auto-managed).
const pruneStmt = db.prepare(`
  DELETE FROM tasks
  WHERE source = ? AND status = 'resolved' AND id NOT IN (
    SELECT id FROM tasks WHERE source = ? AND status = 'resolved'
    ORDER BY resolved_at DESC LIMIT 50
  )
`);

function pruneResolved(source) {
  pruneStmt.run(source, source);
}

export async function pollAll() {
  const results = {};
  try {
    results.iris = await pollIris();
  } catch (err) {
    console.error('[poller] IRIS poll failed:', err.message);
    results.iris = { error: err.message };
  }
  try {
    results.missive = await pollMissive();
  } catch (err) {
    console.error('[poller] Missive poll failed:', err.message);
    results.missive = { error: err.message };
  }
  return results;
}
