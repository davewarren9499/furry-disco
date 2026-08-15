// Missive integration.
//
// Verified against missiveapp.com/docs/developers/rest-api and live requests
// against the real account. This originally used GET /conversations
// (assigned=true, separately closed=true) with "a task is a conversation
// assigned to you" as the model. That was wrong on two counts, found by
// testing against real data:
//   1. "assigned" and "closed" are separate, non-overlapping Missive views
//      -- you can't even request both at once (400: "cannot paginate
//      multiple mailboxes"). A conversation vanishes from the assigned feed
//      the moment it's closed, so closures were never detected.
//   2. Missive has a real Tasks object (GET /v1/tasks) that the
//      conversations-only model completely missed: subtasks with their own
//      title/description attached to a conversation (e.g. a "Close Batch"
//      task with real instructions, sitting on top of an email thread that
//      otherwise looked like a bare, contentless row), plus standalone
//      tasks with no conversation at all. GET /v1/tasks?assignee=X&type=all
//      returns everything -- standalone tasks, conversation subtasks, and
//      "tasked conversations" (conversations you're assigned/due on, with
//      no separate task object) -- in every state (todo/in_progress/closed)
//      in one call, which is both more complete and simpler than chasing
//      two separate conversation views.

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

// Everything assigned to you: standalone tasks, conversation subtasks, and
// tasked conversations, in any state. type=all and omitting `state`
// entirely both matter here -- either narrows to a subset.
export async function fetchMyTasks() {
  assertConfigured();
  const params = new URLSearchParams({ assignee: MY_USER_ID, type: 'all', limit: '50' });
  const data = await missiveFetch(`/tasks?${params}`);
  return data.tasks || [];
}

// Standalone tasks need `organization` whenever `assignees` is set, and
// there's no "list organizations for this token" shortcut other than
// actually listing them -- personal tokens only ever belong to one, so the
// first one is always the right one.
async function fetchOrganizationId() {
  assertConfigured();
  const data = await missiveFetch('/organizations');
  return data.organizations?.[0]?.id || null;
}

// Creates a real standalone task in Missive, assigned to you. There's no
// "create a subtask of an existing conversation via this dashboard" flow
// (only relevant when starting from a specific email), so this only ever
// makes standalone tasks -- the same kind Missive's own "+ Task" button in
// the Tasks view creates.
export async function createTask({ title, description }) {
  assertConfigured();
  const organization = await fetchOrganizationId();
  const body = {
    tasks: {
      organization,
      title,
      assignees: [MY_USER_ID],
      ...(description ? { description } : {}),
    },
  };
  const data = await missiveFetch('/tasks', { method: 'POST', body: JSON.stringify(body) });
  return data.tasks;
}

// state: 'todo' | 'in_progress' | 'closed'. Only meaningful for real Task
// objects (meta.taskType === 'task') -- a bare tasked-conversation has no
// Task object to PATCH, see closeConversation below for that case instead.
export async function updateTaskState(taskId, state) {
  assertConfigured();
  const data = await missiveFetch(`/tasks/${taskId}`, {
    method: 'PATCH',
    body: JSON.stringify({ tasks: { state } }),
  });
  return data.tasks;
}

// Closes the conversation itself (silently -- no post/comment left behind).
// This is the write path for a bare tasked-conversation (meta.taskType ===
// 'conversation'), which has no separate Task object to PATCH.
export async function closeConversation(conversationId) {
  assertConfigured();
  return missiveFetch(`/conversations/${conversationId}`, {
    method: 'PATCH',
    body: JSON.stringify({ conversations: [{ id: conversationId, close: true }] }),
  });
}

// Missive's equivalent of a ticket comment is a "post" -- a note visible
// in the conversation, distinct from a real customer-facing email reply.
// `notification` is required by the API even though nothing here surfaces
// it as a push notification; title/body just need to be non-empty.
export async function postConversationComment(conversationId, text) {
  assertConfigured();
  const body = {
    posts: {
      conversation: conversationId,
      text,
      notification: { title: 'New comment', body: text.slice(0, 140) },
    },
  };
  return missiveFetch('/posts', { method: 'POST', body: JSON.stringify(body) });
}

export async function fetchConversationMessages(conversationId) {
  assertConfigured();
  const data = await missiveFetch(`/conversations/${conversationId}/messages`);
  return data.messages || data.data || [];
}

// Just the subject -- used to show "this task's email thread is called X"
// when a task's own title (e.g. "Close Batch") isn't the conversation's
// subject line, which the Tasks API doesn't include inline.
export async function fetchConversationSubject(conversationId) {
  assertConfigured();
  const data = await missiveFetch(`/conversations/${conversationId}`);
  const conv = data.conversations?.[0];
  return conv?.subject || conv?.latest_message_subject || null;
}

export function conversationUrl(conversationId) {
  return `https://mail.missiveapp.com/#inbox/conversations/${conversationId}`;
}

// Task descriptions come back as HTML (Missive's rich-text editor output,
// e.g. "<div>Manually close batch...</div>"). There's no sanitizer in this
// project, so rather than risk innerHTML-ing unsanitized markup, this
// strips tags down to plain text -- the caller still escapeHtml()s it
// before display, same as every other user-provided string in this app.
function stripHtml(html) {
  if (!html) return null;
  return html
    .replace(/<(br|\/div|\/p|\/li)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeMissiveTask(task) {
  // The conversation this task is "about", if any: either the parent
  // conversation of a subtask, or -- for a bare tasked-conversation (no
  // separate task object) -- the task's own id, since Missive treats the
  // conversation itself as the task in that case.
  const conversationId = task.conversation || (task.type === 'conversation' ? task.id : null);
  return {
    source: 'missive',
    source_id: String(task.id),
    title: task.title || '(untitled)',
    url: conversationId ? conversationUrl(conversationId) : null,
    status: task.state === 'closed' ? 'resolved' : 'open',
    // Missive timestamps are Unix seconds; convert to ISO so it sorts
    // correctly alongside IRIS's ISO timestamps in the resolved list.
    resolvedAt: task.closed_at ? new Date(task.closed_at * 1000).toISOString() : null,
    reason: 'assigned',
    assignee: 'me',
    meta: JSON.stringify({
      description: stripHtml(task.description),
      // 'task' (standalone or subtask, has its own title/description) or
      // 'conversation' (no separate task object -- the row IS the email).
      taskType: task.type,
      conversationId,
      dueAt: task.due_at ? new Date(task.due_at * 1000).toISOString() : null,
      // Closest thing Missive has to "last comment" -- doubles as that
      // field for the unified sort-by-last-comment option (see tasks.js).
      // No createdAt: unlike conversations, the Tasks API doesn't expose a
      // creation timestamp at all, so "date added" falls back to this
      // dashboard's own sync time for Missive rows (same as manual tasks).
      lastCommentAt: task.last_activity_at ? new Date(task.last_activity_at * 1000).toISOString() : null,
    }),
  };
}
