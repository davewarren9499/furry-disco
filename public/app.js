const state = {
  tab: 'open',
  tasks: [],
  templates: [],
  activeTaskId: null,
};

const IMPORTANCE_LABEL = { 1: 'Low', 2: 'Normal', 3: 'High', 4: 'Urgent' };

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  if (res.status === 204) return null;
  return res.json();
}

async function loadTasks() {
  state.tasks = await api(`/tasks?status=${state.tab}`);
  render();
}

async function loadTemplates() {
  state.templates = await api('/templates');
  const sel = document.getElementById('templateSelect');
  sel.innerHTML = '<option value="">Comment template…</option>' +
    state.templates.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
}

function render() {
  const list = document.getElementById('taskList');
  const empty = document.getElementById('emptyState');
  list.innerHTML = '';

  if (!state.tasks.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  for (const task of state.tasks) {
    list.appendChild(renderTaskItem(task));
  }
}

function renderTaskItem(task) {
  const li = document.createElement('li');
  li.className = 'task-item';
  li.draggable = state.tab === 'open';
  li.dataset.id = task.id;

  const sourceBadgeClass = `badge-${task.source}`;
  const mentionBadge = task.reason === 'mentioned' ? '<span class="badge badge-mentioned">Mentioned</span>' : '';

  li.innerHTML = `
    <span class="drag-handle">⠿</span>
    <span class="importance-dot importance-${task.importance}" title="${IMPORTANCE_LABEL[task.importance]}"></span>
    <div class="task-main">
      <div class="task-title">${escapeHtml(task.title)}</div>
      <div class="task-sub">
        <span class="badge ${sourceBadgeClass}">${task.source}</span>
        ${mentionBadge}
        ${task.assignee ? `<span>${escapeHtml(task.assignee)}</span>` : ''}
      </div>
    </div>
    ${task.url ? `<a class="task-source-link" href="${task.url}" target="_blank" rel="noopener" title="Open in source">↗</a>` : ''}
  `;

  li.addEventListener('click', (e) => {
    if (e.target.closest('.task-source-link')) return;
    openDrawer(task.id);
  });

  li.addEventListener('dragstart', () => li.classList.add('dragging'));
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    persistOrder();
  });

  return li;
}

function persistOrder() {
  const orderedIds = [...document.querySelectorAll('#taskList .task-item')].map((el) => el.dataset.id);
  api('/tasks/reorder', { method: 'POST', body: JSON.stringify({ orderedIds }) }).catch(console.error);
}

document.getElementById('taskList').addEventListener('dragover', (e) => {
  e.preventDefault();
  const list = e.currentTarget;
  const dragging = list.querySelector('.dragging');
  if (!dragging) return;
  const after = getDragAfterElement(list, e.clientY);
  if (after == null) list.appendChild(dragging);
  else list.insertBefore(dragging, after);
});

function getDragAfterElement(container, y) {
  const items = [...container.querySelectorAll('.task-item:not(.dragging)')];
  return items.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

// Tabs
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelector('.tab.active')?.classList.remove('active');
    btn.classList.add('active');
    state.tab = btn.dataset.tab;
    loadTasks();
  });
});

document.getElementById('syncBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncBtn');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    await api('/sync', { method: 'POST' });
    await loadTasks();
  } finally {
    btn.disabled = false;
    btn.textContent = '⟳ Sync';
  }
});

// Drawer
async function openDrawer(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  state.activeTaskId = taskId;

  document.getElementById('drawerTitle').textContent = task.title;
  const badge = document.getElementById('drawerSource');
  badge.textContent = task.source;
  badge.className = `badge badge-${task.source}`;
  const link = document.getElementById('drawerLink');
  if (task.url) { link.href = task.url; link.style.display = 'inline'; } else { link.style.display = 'none'; }
  document.getElementById('statusSelect').value = task.status;
  document.getElementById('importanceSelect').value = task.importance;

  const missiveBox = document.getElementById('missiveThread');
  if (task.source === 'missive') {
    missiveBox.hidden = false;
    document.getElementById('missiveMessages').innerHTML = '<p class="task-sub">Loading thread…</p>';
    try {
      const { messages } = await api(`/missive/thread/${task.id}`);
      renderMissiveThread(messages);
    } catch (err) {
      document.getElementById('missiveMessages').innerHTML = `<p class="task-sub">Failed to load thread: ${escapeHtml(err.message)}</p>`;
    }
  } else {
    missiveBox.hidden = true;
  }

  await loadComments(taskId);
  document.getElementById('drawer').hidden = false;
}

function renderMissiveThread(messages) {
  const box = document.getElementById('missiveMessages');
  if (!messages.length) {
    box.innerHTML = '<p class="task-sub">No messages found.</p>';
    return;
  }
  box.innerHTML = messages
    .map(
      (m) => `
      <div class="missive-message">
        <div class="missive-message-meta">${escapeHtml(m.from || 'Unknown')} · ${m.createdAt ? new Date(m.createdAt * 1000 || m.createdAt).toLocaleString() : ''}</div>
        <div>${escapeHtml(m.preview || m.subject || '')}</div>
      </div>`
    )
    .join('');
}

async function loadComments(taskId) {
  const comments = await api(`/comments/task/${taskId}`);
  renderComments(comments);
  // best-effort background refresh from source, then re-render
  api(`/comments/task/${taskId}/sync`, { method: 'POST' })
    .then(async (result) => {
      if (result?.synced) {
        const fresh = await api(`/comments/task/${taskId}`);
        renderComments(fresh);
      }
    })
    .catch(() => {});
}

function renderComments(comments) {
  const list = document.getElementById('commentList');
  if (!comments.length) {
    list.innerHTML = '<li class="task-sub">No comments yet.</li>';
    return;
  }
  list.innerHTML = comments
    .map(
      (c) => `
      <li class="comment-item">
        <div class="comment-item-meta">${escapeHtml(c.author || 'Unknown')} · ${new Date(c.created_at).toLocaleString()} ${c.origin === 'iris' ? '· from IRIS' : ''}</div>
        <div>${escapeHtml(c.body)}</div>
      </li>`
    )
    .join('');
}

document.getElementById('drawerClose').addEventListener('click', closeDrawer);
document.querySelector('#drawer .drawer-backdrop').addEventListener('click', closeDrawer);
function closeDrawer() {
  document.getElementById('drawer').hidden = true;
  state.activeTaskId = null;
}

document.getElementById('statusSelect').addEventListener('change', async (e) => {
  if (!state.activeTaskId) return;
  await api(`/tasks/${state.activeTaskId}`, { method: 'PATCH', body: JSON.stringify({ status: e.target.value }) });
  await loadTasks();
});

document.getElementById('importanceSelect').addEventListener('change', async (e) => {
  if (!state.activeTaskId) return;
  await api(`/tasks/${state.activeTaskId}`, { method: 'PATCH', body: JSON.stringify({ importance: Number(e.target.value) }) });
  await loadTasks();
});

document.getElementById('templateSelect').addEventListener('change', (e) => {
  const tpl = state.templates.find((t) => t.id === e.target.value);
  if (tpl) document.getElementById('commentBody').value = tpl.body;
});

document.getElementById('postCommentBtn').addEventListener('click', async () => {
  if (!state.activeTaskId) return;
  const textarea = document.getElementById('commentBody');
  const body = textarea.value.trim();
  if (!body) return;
  await api(`/comments/task/${state.activeTaskId}`, { method: 'POST', body: JSON.stringify({ body }) });
  textarea.value = '';
  document.getElementById('templateSelect').value = '';
  await loadComments(state.activeTaskId);
});

// New task modal
document.getElementById('newTaskBtn').addEventListener('click', () => {
  document.getElementById('newTaskModal').hidden = false;
});
document.getElementById('newTaskClose').addEventListener('click', () => {
  document.getElementById('newTaskModal').hidden = true;
});
document.querySelector('#newTaskModal .drawer-backdrop').addEventListener('click', () => {
  document.getElementById('newTaskModal').hidden = true;
});
document.getElementById('createTaskBtn').addEventListener('click', async () => {
  const title = document.getElementById('newTaskTitle').value.trim();
  if (!title) return;
  const url = document.getElementById('newTaskUrl').value.trim();
  const importance = Number(document.getElementById('newTaskImportance').value);
  await api('/tasks', { method: 'POST', body: JSON.stringify({ title, url, importance }) });
  document.getElementById('newTaskTitle').value = '';
  document.getElementById('newTaskUrl').value = '';
  document.getElementById('newTaskModal').hidden = true;
  if (state.tab === 'open') await loadTasks();
});

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

loadTasks();
loadTemplates();
