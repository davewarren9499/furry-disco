// IRIS CRM (Banquest) Helpdesk integration.
//
// NOTE: Live docs at iriscrm.com were unreachable from this build environment
// (network egress was blocked), so the paths/fields below follow IRIS CRM's
// documented REST conventions (bearer API key, /api/v1/... resources under
// the Helpdesk tag) rather than a verified spec. Treat IRIS_TICKETS_PATH /
// IRIS_COMMENTS_PATH as the two things most likely to need a one-line fix
// once you test against your real account — everything else (polling,
// diffing, mention detection) is independent of the exact path.

const BASE_URL = process.env.IRIS_BASE_URL || 'https://iris.banquest.com/api';
const API_KEY = process.env.IRIS_API_KEY;
const MY_USER_ID = process.env.IRIS_USER_ID; // your IRIS user id, for assignee/mention matching
const MY_USERNAME = process.env.IRIS_USERNAME || ''; // fallback text match for @mentions in comments

const TICKETS_PATH = process.env.IRIS_TICKETS_PATH || '/v1/tickets';
const COMMENTS_PATH = process.env.IRIS_COMMENTS_PATH || '/v1/tickets/{id}/comments';

function assertConfigured() {
  if (!API_KEY) throw new Error('IRIS_API_KEY is not set');
  if (!MY_USER_ID) throw new Error('IRIS_USER_ID is not set');
}

async function irisFetch(pathname, options = {}) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'X-API-KEY': API_KEY, // some IRIS deployments expect this header instead of Bearer
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

// Fetch tickets assigned to me, plus tickets updated recently so we can scan
// their latest comments for an @mention of me. IRIS CRM ticket list supports
// filtering; adjust query params to match your account's actual filter names.
export async function fetchMyTickets() {
  assertConfigured();
  const params = new URLSearchParams({ assignee_id: MY_USER_ID, per_page: '100' });
  const data = await irisFetch(`${TICKETS_PATH}?${params}`);
  return Array.isArray(data) ? data : data.items || data.data || [];
}

export async function fetchRecentlyUpdatedTickets(sinceIso) {
  assertConfigured();
  const params = new URLSearchParams({ updated_since: sinceIso, per_page: '100' });
  const data = await irisFetch(`${TICKETS_PATH}?${params}`);
  return Array.isArray(data) ? data : data.items || data.data || [];
}

export async function fetchTicketComments(ticketId) {
  assertConfigured();
  const data = await irisFetch(COMMENTS_PATH.replace('{id}', ticketId));
  return Array.isArray(data) ? data : data.items || data.data || [];
}

export async function postTicketComment(ticketId, body) {
  assertConfigured();
  return irisFetch(COMMENTS_PATH.replace('{id}', ticketId), {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

export async function updateTicketStatus(ticketId, status) {
  assertConfigured();
  return irisFetch(`${TICKETS_PATH}/${ticketId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

// Does this comment text @mention me? Checked against both a numeric
// mention id (if IRIS embeds one) and a plain @username text fallback.
export function commentMentionsMe(comment) {
  const text = (comment.body || comment.text || '').toLowerCase();
  if (MY_USERNAME && text.includes(`@${MY_USERNAME.toLowerCase()}`)) return true;
  const mentionIds = comment.mentioned_user_ids || comment.mentions || [];
  return mentionIds.map(String).includes(String(MY_USER_ID));
}

export function ticketUrl(ticketId) {
  const webBase = process.env.IRIS_WEB_BASE_URL || 'https://iris.banquest.com';
  return `${webBase}/helpdesk/tickets/${ticketId}`;
}

export function normalizeTicket(ticket, reason) {
  return {
    source: 'iris',
    source_id: String(ticket.id),
    title: ticket.subject || ticket.title || `Ticket #${ticket.id}`,
    url: ticketUrl(ticket.id),
    status: mapIrisStatus(ticket.status),
    reason,
    assignee: ticket.assignee_name || ticket.assignee || null,
    meta: JSON.stringify({
      irisStatus: ticket.status,
      merchantName: ticket.merchant_name,
      priority: ticket.priority,
    }),
  };
}

function mapIrisStatus(irisStatus) {
  const s = String(irisStatus || '').toLowerCase();
  if (['resolved', 'closed', 'completed'].includes(s)) return 'resolved';
  return 'open';
}
