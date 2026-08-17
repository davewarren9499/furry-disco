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
    -- Merge, not overwrite: normalizeTicket()/normalizeMissiveTask() never
    -- know about fields set out-of-band on this row (currently just
    -- meta.mentionedInComments, from the mention backfill/scan below), so
    -- a plain overwrite here would silently wipe them out on every regular
    -- poll. json_patch keeps any key the new meta doesn't mention; a key
    -- explicitly set to null in the new meta still deletes it (RFC 7396
    -- merge-patch semantics), so real field resets still work as before.
    meta = json_patch(COALESCE(tasks.meta, '{}'), excluded.meta),
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

// Patches meta.mentionedInComments onto an already-synced row without
// touching anything else the normal upsert manages (title, status, reason,
// ...). Used for tickets I'm already assigned to -- reason stays 'assigned'
// (that drives grouping), this is a separate signal used only to highlight
// the row, for a mention that'd otherwise be buried in the comment list.
const markMentionedInComments = db.prepare(`
  UPDATE tasks SET meta = json_set(COALESCE(meta, '{}'), '$.mentionedInComments', 1)
  WHERE source = 'iris' AND source_id = ?
`);

// Not exported -- only called from pollAll() below, which is the module's
// actual public entry point.
async function pollIris() {
  if (!process.env.IRIS_API_KEY) return { skipped: 'IRIS_API_KEY not set' };

  const assigned = await iris.fetchMyTickets();
  for (const ticket of assigned) {
    upsert(iris.normalizeTicket(ticket, 'assigned'));
  }

  // Scan tickets updated since the last poll for @mentions of me in new
  // comments -- both for tickets I'm not assigned to (reason: 'mentioned',
  // its own group) and, separately, tickets I already am assigned to (just
  // flagged via meta.mentionedInComments, since a mention there can still
  // get buried in a long comment thread otherwise).
  //
  // storedLastPoll is null only right after a fresh restart, in which case
  // lastPoll falls back to a 24h window -- on an active queue that's most
  // of the ~200 currently-assigned tickets, and fetching comments for each
  // one (a real sequential API call per ticket) would make the first poll
  // take a very long time. isColdStart skips the already-assigned half of
  // this scan on that one poll only; every regular 2-minute poll after
  // that has a small enough "recently modified" set for the full scan.
  const storedLastPoll = getSyncState('iris_last_poll');
  const isColdStart = !storedLastPoll;
  const lastPoll = storedLastPoll || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const updated = await iris.fetchRecentlyUpdatedTickets(lastPoll);
  const assignedIds = new Set(assigned.map((t) => String(t.id)));
  for (const ticket of updated) {
    const isAssigned = assignedIds.has(String(ticket.id));
    if (isAssigned && isColdStart) continue;
    try {
      const comments = await iris.fetchTicketComments(ticket.id);
      if (!comments.some(iris.commentMentionsMe)) continue;
      if (isAssigned) {
        markMentionedInComments.run(String(ticket.id));
      } else {
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

// Exported (unlike pollIris) so a task creation/close from the dashboard
// can pull the fresh state back in immediately, without waiting for the
// next scheduled poll or paying the cost of a full IRIS re-sync too.
export async function pollMissive() {
  if (!process.env.MISSIVE_API_TOKEN) return { skipped: 'MISSIVE_API_TOKEN not set' };

  // One call covers everything: standalone tasks, conversation subtasks,
  // and tasked conversations, in any state -- see the comment on
  // fetchMyTasks for why this replaced two separate conversations? calls.
  const tasks = await missive.fetchMyTasks();
  for (const task of tasks) {
    upsert(missive.normalizeMissiveTask(task));
  }

  pruneResolved('missive');
  return { total: tasks.length };
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
