// Missive integration.
//
// NOTE: docs.missiveapp.com/learn.missiveapp.com were unreachable from this
// build environment (network egress blocked), so paths follow Missive's
// publicly documented REST conventions (bearer token, /v1/conversations,
// /v1/messages) rather than a verified spec against your account. Missive
// has no "task" object of its own — a "task" here means a conversation
// assigned to you (Missive supports per-user conversation assignment),
// which is the natural analogue.

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

// Conversations currently assigned to me and not yet archived/closed.
export async function fetchAssignedConversations() {
  assertConfigured();
  const params = new URLSearchParams({ assignee: MY_USER_ID, limit: '50' });
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
    url: conversationUrl(conv.id),
    status: conv.closed ? 'resolved' : 'open',
    reason: 'assigned',
    assignee: 'me',
    meta: JSON.stringify({
      lastActivityAt: conv.last_activity_at,
      teamId: conv.team_id,
    }),
  };
}
