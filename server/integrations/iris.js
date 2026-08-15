// IRIS CRM (Banquest) Helpdesk integration.
//
// Verified against the live OpenAPI spec at https://demo.iriscrm.com/api/v1.yaml
// (mirrors the account's own instance) and against real requests to
// https://iris.banquest.com/api/v1/helpdesk. Key things that don't match the
// generic REST conventions you might assume:
// - Auth is a single `X-API-KEY` header (apiKey scheme), not Bearer.
// - The resource is `/v1/helpdesk`, not `/v1/tickets`.
// - There's no separate comments-list endpoint; comments come embedded in
//   the ticket detail response's `comments` array.
// - `notifiers` on a comment is an object keyed by user id
//   (`{ "2990": { id, type, fullName }, ... }`), not an array.
// - `status` on a ticket is an object `{ id, name }`; PATCH takes a plain
//   status string instead (`new, open, in_progress, info_required, resolved`).

const BASE_URL = process.env.IRIS_BASE_URL || 'https://iris.banquest.com/api';
const API_KEY = process.env.IRIS_API_KEY;
const MY_USER_ID = process.env.IRIS_USER_ID; // your IRIS user id, for assignee/mention matching
const MY_USERNAME = process.env.IRIS_USERNAME || ''; // fallback text match for @mentions in comments

const TICKETS_PATH = process.env.IRIS_TICKETS_PATH || '/v1/helpdesk';

function assertConfigured() {
  if (!API_KEY) throw new Error('IRIS_API_KEY is not set');
  if (!MY_USER_ID) throw new Error('IRIS_USER_ID is not set');
}

async function irisFetch(pathname, options = {}) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    ...options,
    headers: {
      'X-API-KEY': API_KEY,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`IRIS API ${pathname} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// Fetch tickets assigned to me. Sorted by most-recently-modified so that,
// with a huge assigned queue (10k+ tickets accumulated over years), the
// single page we pull is actually the tickets with recent activity rather
// than an arbitrary unsorted slice (which skewed towards old tickets).
export async function fetchMyTickets() {
  assertConfigured();
  const params = new URLSearchParams({
    assigned_to: MY_USER_ID,
    sort_by: 'modified',
    sort_dir: 'desc',
    per_page: '1000',
  });
  const data = await irisFetch(`${TICKETS_PATH}?${params}`);
  return data.data || [];
}

// IRIS wants `Y-m-d\TH:i:sP` (no milliseconds, `+00:00` offset, not `Z`) and
// requires both start_date and end_date whenever date_filter is set.
function toIrisTimestamp(date) {
  return date.toISOString().replace(/\.\d+Z$/, '+00:00');
}

// Tickets modified since the last poll, across ALL assigned tickets (not
// just mine), so we can scan their latest comments for an @mention of me
// even when I'm not the assignee. `assigned_to=''` opts out of the "only my
// tickets" default; `unassigned=1` additionally 403s on this account's API
// key, so unassigned tickets aren't scanned — an acceptable gap since a
// ticket with nobody assigned is unlikely to carry an @mention anyway.
export async function fetchRecentlyUpdatedTickets(sinceIso) {
  assertConfigured();
  const params = new URLSearchParams({
    date_filter: 'modified',
    start_date: toIrisTimestamp(new Date(sinceIso)),
    end_date: toIrisTimestamp(new Date()),
    assigned_to: '',
    per_page: '100',
  });
  const data = await irisFetch(`${TICKETS_PATH}?${params}`);
  return data.data || [];
}

// Full ticket detail: { general: {...fields}, checklist: [...], comments: [...] }
export async function fetchTicketDetail(ticketId) {
  assertConfigured();
  return irisFetch(`${TICKETS_PATH}/${ticketId}`);
}

export async function fetchTicketComments(ticketId) {
  const detail = await fetchTicketDetail(ticketId);
  return detail.comments || [];
}

// notify: optional array of IRIS user IDs (or emails) to notify about this
// comment. Left undefined/empty, IRIS falls back to its own default
// notification behavior (in practice: everyone else on the ticket).
// extendedFiles: optional array of {tmp_name, title} -- tmp_name is the
// fileId returned by uploadTicketFile() below; title is the display name.
export async function postTicketComment(ticketId, comment, notify, extendedFiles) {
  assertConfigured();
  const body = { comment };
  if (notify?.length) body.notify = notify;
  if (extendedFiles?.length) body.extended_files = extendedFiles;
  return irisFetch(`${TICKETS_PATH}/${ticketId}/comment`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// Step 1 of attaching a file to a comment: upload the raw bytes to get a
// temporary fileId, then pass {tmp_name: fileId, title: name} in
// postTicketComment()'s extendedFiles. IRIS wants extension and name as
// separate query params (not just parsed from the filename) purely for
// its own validation.
export async function uploadTicketFile(buffer, filename) {
  assertConfigured();
  const extension = filename.includes('.') ? filename.split('.').pop() : '';
  const params = new URLSearchParams({ extension, name: filename });
  const res = await fetch(`${BASE_URL}${TICKETS_PATH}/file?${params}`, {
    method: 'POST',
    headers: { 'X-API-KEY': API_KEY, 'Content-Type': 'application/octet-stream' },
    body: buffer,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`IRIS API file upload -> ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.fileId;
}

// Does this comment @mention me? `notifiers` looked like the right signal
// (a per-comment object keyed by user id) but turned out to be wrong: it's
// IRIS's "who gets notified about this comment" list, which in practice is
// every assignee except the comment's author -- not who was actually
// @-tagged in the text. A comment as plain as "PPS submitted" still lists
// every other assignee in `notifiers`. Real @mentions are only detectable
// by matching the literal "@Name" text (mirrors app.js's MY_MENTION_RE,
// which highlights the same patterns in the UI).
const MENTION_RE = new RegExp(
  `@(dave\\s+warren|dave${MY_USERNAME ? `|${MY_USERNAME.toLowerCase()}` : ''})\\b`,
  'i'
);

export function commentMentionsMe(comment) {
  return MENTION_RE.test(comment.comment || '');
}

export function ticketUrl(ticketId) {
  const webBase = process.env.IRIS_WEB_BASE_URL || 'https://iris.banquest.com';
  return `${webBase}/v2/helpdesk/ticket/${ticketId}`;
}

export function normalizeTicket(ticket, reason) {
  const assignedUsers = ticket.assigned_users || [];
  return {
    source: 'iris',
    source_id: String(ticket.id),
    title: ticket.subject || `Ticket #${ticket.id}`,
    url: ticketUrl(ticket.id),
    status: mapIrisStatus(ticket.status?.name),
    // Normalize IRIS's offset-based timestamp (e.g. -04:00) to UTC ISO so it
    // sorts correctly alongside Missive's timestamps in the resolved list.
    resolvedAt: ticket.resolved ? new Date(ticket.resolved).toISOString() : null,
    reason,
    assignee: assignedUsers.map((u) => u.name).join(', ') || null,
    meta: JSON.stringify({
      irisStatus: ticket.status?.name,
      merchantId: ticket.mid,
      priority: ticket.priority?.name,
      type: ticket.type?.name || null,
      // When the ticket was actually created in IRIS, not when we first
      // synced it into this dashboard (created_at on the tasks row).
      createdAt: ticket.created ? new Date(ticket.created).toISOString() : null,
      // IRIS tracks this natively per ticket -- date of the most recent
      // comment, regardless of who posted it.
      lastCommentAt: ticket.last_comment ? new Date(ticket.last_comment).toISOString() : null,
    }),
  };
}

function mapIrisStatus(statusName) {
  return String(statusName || '').toLowerCase() === 'resolved' ? 'resolved' : 'open';
}

// DBA name for a merchant id. There's no bulk "DBA by mid list" endpoint, so
// callers should cache this (see server/routes/iris.js's merchant_cache use)
// rather than calling it per-ticket on every poll.
export async function fetchMerchantDba(mid) {
  assertConfigured();
  const data = await irisFetch(`/v1/merchants/${mid}`);
  return data.account_information?.['DBA Name'] || data.general?.name || null;
}

// Ticket attachments are binary, not JSON -- irisFetch() always calls
// res.json(), so this bypasses it and returns the raw response instead.
export async function fetchTicketAttachment(ticketId, attachmentId) {
  assertConfigured();
  // attachmentId comes straight from the request URL (unlike ticketId,
  // which is always our own trusted source_id) -- encode defensively.
  const res = await fetch(`${BASE_URL}${TICKETS_PATH}/${encodeURIComponent(ticketId)}/download/${encodeURIComponent(attachmentId)}`, {
    headers: { 'X-API-KEY': API_KEY },
  });
  if (!res.ok) {
    throw new Error(`IRIS API attachment download -> ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
