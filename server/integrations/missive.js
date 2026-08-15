// Missive integration.
//
// Verified against missiveapp.com/docs/developers/rest-api and live requests
// against the real account. Missive has no "task" object of its own — a
// "task" here means a conversation assigned to you (Missive supports
// per-user conversation assignment), which is the natural analogue.
//
// GET /conversations requires at least one mailbox-scope filter or it 400s
// with "You need to paginate at least one mailbox" — the scope we want is
// the boolean `assigned=true` flag (conversations assigned to the token's
// own user), not an `assignee=<id>` query param.

const BASE_URL = process.env.MISSIVE_BASE_URL || 'https://public.missiveapp.com/v1';
const API_TOKEN = process.env.MISSIVE_API_TOKEN;
const MY_USER_ID = process.env.MISSIVE_USER_ID;

function assertConfigured() {
  if (!API_TOKEN) throw new Error('MISSIVE_API_TOKEN is not set');
  if (!MY_USER_ID) throw new Error('MISSIVE_USER_ID is not set');
}

async function missiveFetch(pathname, options = {}) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Missive API ${pathname} -> ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

// Conversations currently assigned to me (open or closed — we read closed
// status per-conversation below so the poller can move them to Resolved).
export async function fetchAssignedConversations() {
  assertConfigured();
  const params = new URLSearchParams({ assigned: 'true', limit: '50' });
  const data = await missiveFetch(`/conversations?${params}`);
  return data.conversations || data.data || [];
}

export async function fetchConversationMessages(conversationId) {
  assertConfigured();
  const data = await missiveFetch(`/conversations/${conversationId}/messages`);
  return data.messages || data.data || [];
}

export function conversationUrl(conversationId) {
  return `https://mail.missiveapp.com/#inbox/conversations/${conversationId}`;
}

export function normalizeConversation(conv) {
  return {
    source: 'missive',
    source_id: String(conv.id),
    title: conv.subject || conv.latest_message_subject || '(no subject)',
    url: conv.web_url || conversationUrl(conv.id),
    status: conv.closed_at ? 'resolved' : 'open',
    // Missive timestamps are Unix seconds; convert to ISO so it sorts
    // correctly alongside IRIS's ISO timestamps in the resolved list.
    resolvedAt: conv.closed_at ? new Date(conv.closed_at * 1000).toISOString() : null,
    reason: 'assigned',
    assignee: 'me',
    meta: JSON.stringify({
      // Missive has no separate "last comment" concept -- last_activity_at
      // (unix seconds) is the closest equivalent, and doubles as that field
      // for the unified sort-by-last-comment option (see tasks.js).
      lastCommentAt: conv.last_activity_at ? new Date(conv.last_activity_at * 1000).toISOString() : null,
      teamId: conv.team?.id ?? null,
      // When the conversation was actually created in Missive, not when we
      // first synced it into this dashboard (created_at on the tasks row).
      createdAt: conv.created_at ? new Date(conv.created_at * 1000).toISOString() : null,
    }),
  };
}
