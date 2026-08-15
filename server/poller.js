import { randomUUID } from 'node:crypto';
import { db, getSyncState, setSyncState } from './db.js';
import * as iris from './integrations/iris.js';
import * as missive from './integrations/missive.js';

const upsertTask = db.prepare(`
  INSERT INTO tasks (id, source, source_id, title, url, status, reason, assignee, meta, updated_at, resolved_at)
  VALUES (
    @id, @source, @source_id, @title, @url, @status, @reason, @assignee, @meta, datetime('now'),
    CASE WHEN @status = 'resolved' THEN COALESCE(@resolvedAt, datetime('now')) ELSE NULL END
  )
  ON CONFLICT(source, source_id) DO UPDATE SET
    title = excluded.title,
    url = excluded.url,
    reason = excluded.reason,
    assignee = excluded.assignee,
    meta = excluded.meta,
    updated_at = datetime('now'),
    -- Prefer the source's real resolution timestamp; fall back to a
    -- previously-recorded one, then to "now" as a last resort (e.g. the
    -- source doesn't expose a resolution date). Once set, a resolved_at is
    -- never overwritten, so re-syncing the same ticket doesn't shuffle it.
    resolved_at = CASE
      WHEN @status = 'resolved' THEN COALESCE(tasks.resolved_at, @resolvedAt, datetime('now'))
      ELSE tasks.resolved_at
    END,
    -- 'done' is a local triage bucket that otherwise sticks regardless of
    -- source status, but the source is authoritative on 'resolved': once
    -- the API reports a ticket resolved, it moves out of 'done' and into
    -- 'resolved' on the next poll.
    status = CASE
      WHEN @status = 'resolved' THEN 'resolved'
      WHEN tasks.status = 'done' THEN 'done'
      ELSE @status
    END
`);

const findExisting = db.prepare('SELECT id FROM tasks WHERE source = ? AND source_id = ?');

function upsert(normalized) {
  const existing = findExisting.get(normalized.source, normalized.source_id);
  upsertTask.run({ id: existing ? existing.id : randomUUID(), resolvedAt: null, ...normalized });
}

// Not exported -- only called from pollAll() below, which is the module's
// actual public entry point.
async function pollIris() {
  if (!process.env.IRIS_API_KEY) return { skipped: 'IRIS_API_KEY not set' };

  const assigned = await iris.fetchMyTickets();
  for (const ticket of assigned) {
    upsert(iris.normalizeTicket(ticket, 'assigned'));
  }

  // Scan tickets updated since the last poll for @mentions of me in new
  // comments, even when I'm not the assignee (e.g. someone loops me in).
  const lastPoll = getSyncState('iris_last_poll') || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const updated = await iris.fetchRecentlyUpdatedTickets(lastPoll);
  const assignedIds = new Set(assigned.map((t) => String(t.id)));
  for (const ticket of updated) {
    if (assignedIds.has(String(ticket.id))) continue; // already handled above
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

async function pollMissive() {
  if (!process.env.MISSIVE_API_TOKEN) return { skipped: 'MISSIVE_API_TOKEN not set' };

  const conversations = await missive.fetchAssignedConversations();
  for (const conv of conversations) {
    upsert(missive.normalizeConversation(conv));
  }
  pruneResolved('missive');
  return { assigned: conversations.length };
}

// Keep only the most recent 25 resolved tasks per source visible; older
// resolved ones are deleted to bound table growth (done tasks are untouched
// since they're a deliberate, user-controlled bucket, not auto-managed).
const pruneStmt = db.prepare(`
  DELETE FROM tasks
  WHERE source = ? AND status = 'resolved' AND id NOT IN (
    SELECT id FROM tasks WHERE source = ? AND status = 'resolved'
    ORDER BY resolved_at DESC LIMIT 25
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
