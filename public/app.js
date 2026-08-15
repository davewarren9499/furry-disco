const state = {
  tab: 'open',
  tasks: [],
  templates: [],
  activeTaskId: null,
  typeFilters: new Set(), // empty = no filter, show everything
  priorityFilters: new Set(), // empty = no filter, show everything
  search: '',
  sort: 'added', // 'added' | 'comment' -- see the ORDER BY note in tasks.js
  dbaCache: {}, // mid -> dba, client-side memo on top of the server's cache
  selectedIds: new Set(), // bulk-edit selection
  collapsedGroups: new Set(['Missive']), // group labels currently folded -- Missive starts collapsed
  views: [],
  commentFiles: {}, // remote comment id -> [{id, name, size}], from the live ticket-info fetch
  ticketAssignees: [], // [{id, name}] for the open IRIS task, for the comment notify picker
  selectedCommentFile: null, // File object staged to upload with the next comment, or null
};

const IMPORTANCE_LABEL = { 1: 'Low', 2: 'Normal', 3: 'High', 4: 'Urgent' };

// Matches how people actually @mention you in IRIS comments/descriptions --
// full name, first name only, or your IRIS username, in any casing (real
// examples seen in this account: "@Dave Warren", "@dave/nesanel", "@Dave").
// \b after "dave" correctly stops at "/" too, since it's a non-word char.
const MY_MENTION_RE = /@(dave\s+warren|dwarren|dave)\b/gi;

// Runs on already-HTML-escaped text (so this only ever matches plain
// letters -- safe to inject the <mark> wrapper without re-escaping).
function highlightMentions(escapedHtml) {
  MY_MENTION_RE.lastIndex = 0;
  return escapedHtml.replace(MY_MENTION_RE, (match) => `<mark class="mention-me">${match}</mark>`);
}

// A /g regex's .test() advances lastIndex and remembers it between calls,
// which silently breaks repeated true/false checks (alternates wrong
// results) unless reset first.
function mentionsMe(rawText) {
  MY_MENTION_RE.lastIndex = 0;
  return MY_MENTION_RE.test(rawText || '');
}

// Each source's own icon, used in badges so IRIS/Missive items are
// recognizable by logo, not just by label text. Missive's favicon is a dark
// mark meant for light UIs -- it's invisible on our dark theme, so it gets
// a small white chip behind it; IRIS's icon already has an opaque dark
// backing baked in and reads fine as-is.
const SOURCE_ICON = {
  iris: { src: 'https://cdn.iriscrm.com/banquest/public/logos/iris.banquest.com.ico?v=20200609173658', chip: false },
  missive: { src: 'https://cdn.prod.website-files.com/66c7823b4706f4a0a95d2d31/67100e5ec7263b51ddb97437_missive-ico.png', chip: true },
};
const SOURCE_LABEL = { iris: 'IRIS', missive: 'Missive', manual: 'Manual' };
const SOURCE_LINK_LABEL = { iris: 'Open ticket ↗', missive: 'Open task ↗' };

// Mirrors iris.js's ticketUrl() default IRIS_WEB_BASE_URL -- this is a
// single-user dashboard already hardcoded to Banquest's own IRIS instance
// (colors, logos), so hardcoding the merchant URL pattern here too matches
// how the rest of the app is built rather than round-tripping to the
// server just to look up a fixed base URL.
function merchantUrl(mid) {
  return `https://iris.banquest.com/v2/merchant/${mid}/`;
}

function badgeIconHtml(source) {
  const icon = SOURCE_ICON[source];
  if (!icon) return '';
  const img = `<img class="badge-icon" src="${icon.src}" alt="" />`;
  return icon.chip ? `<span class="badge-icon-chip">${img}</span>` : img;
}

function sourceBadgeHtml(source) {
  return `<span class="badge badge-${source}">${badgeIconHtml(source)}${SOURCE_LABEL[source] || source}</span>`;
}

function setSourceBadge(el, source) {
  el.className = `badge badge-${source}`;
  el.innerHTML = `${badgeIconHtml(source)}${SOURCE_LABEL[source] || source}`;
}

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
  const q = state.search ? `&q=${encodeURIComponent(state.search)}` : '';
  state.tasks = await api(`/tasks?status=${state.tab}&sort=${state.sort}${q}`);
  state.selectedIds.clear();
  populateFilters();
  render();
  renderBulkBar();
  document.getElementById(`count-${state.tab}`).textContent = state.tasks.length;
  fetchMissingDbas();
}

async function loadCounts() {
  const counts = await api('/tasks/counts');
  for (const key of ['open', 'resolved', 'done']) {
    document.getElementById(`count-${key}`).textContent = counts[key] ?? 0;
  }
}

async function loadTemplates() {
  state.templates = await api('/templates');
  const sel = document.getElementById('templateSelect');
  sel.innerHTML = '<option value="">Comment template…</option>' +
    state.templates.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
}

// ---- Manage comment templates ----

let editingTemplateId = null;

function resetTemplateForm() {
  editingTemplateId = null;
  document.getElementById('templateFormTitle').textContent = 'New template';
  document.getElementById('templateName').value = '';
  document.getElementById('templateBody').value = '';
  document.getElementById('templateSaveBtn').textContent = 'Save';
  document.getElementById('templateCancelEditBtn').hidden = true;
}

function renderTemplatesManageList() {
  const list = document.getElementById('templatesManageList');
  if (!state.templates.length) {
    list.innerHTML = '<p class="task-sub">No templates yet.</p>';
    return;
  }
  list.innerHTML = state.templates.map((t) => `
    <li class="views-manage-item">
      <span>${escapeHtml(t.name)}</span>
      <div class="views-manage-actions">
        <button type="button" data-edit-template="${t.id}" class="btn btn-ghost">Edit</button>
        <button type="button" data-delete-template="${t.id}" class="btn btn-ghost">Delete</button>
      </div>
    </li>`).join('');

  list.querySelectorAll('[data-edit-template]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tpl = state.templates.find((t) => t.id === btn.dataset.editTemplate);
      if (!tpl) return;
      editingTemplateId = tpl.id;
      document.getElementById('templateFormTitle').textContent = 'Edit template';
      document.getElementById('templateName').value = tpl.name;
      document.getElementById('templateBody').value = tpl.body;
      document.getElementById('templateSaveBtn').textContent = 'Update';
      document.getElementById('templateCancelEditBtn').hidden = false;
    });
  });
  list.querySelectorAll('[data-delete-template]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/templates/${btn.dataset.deleteTemplate}`, { method: 'DELETE' });
      if (editingTemplateId === btn.dataset.deleteTemplate) resetTemplateForm();
      await loadTemplates();
      renderTemplatesManageList();
    });
  });
}

document.getElementById('manageTemplatesBtn').addEventListener('click', () => {
  resetTemplateForm();
  renderTemplatesManageList();
  document.getElementById('manageTemplatesModal').hidden = false;
});
document.getElementById('manageTemplatesClose').addEventListener('click', () => {
  document.getElementById('manageTemplatesModal').hidden = true;
});
document.querySelector('#manageTemplatesModal .modal-backdrop').addEventListener('click', () => {
  document.getElementById('manageTemplatesModal').hidden = true;
});
document.getElementById('templateCancelEditBtn').addEventListener('click', resetTemplateForm);

document.getElementById('templateSaveBtn').addEventListener('click', async () => {
  const name = document.getElementById('templateName').value.trim();
  const body = document.getElementById('templateBody').value.trim();
  if (!name || !body) return;
  if (editingTemplateId) {
    await api(`/templates/${editingTemplateId}`, { method: 'PATCH', body: JSON.stringify({ name, body }) });
  } else {
    await api('/templates', { method: 'POST', body: JSON.stringify({ name, body }) });
  }
  resetTemplateForm();
  await loadTemplates();
  renderTemplatesManageList();
});

// Mentioned tickets get their own group ahead of source, regardless of
// which source they came from, since "someone tagged you" outranks where
// the ticket lives. Everything else groups by source only -- ticket type is
// a filter facet, not a grouping axis.
function groupLabel(task) {
  if (task.reason === 'mentioned') return 'Mentioned';
  return SOURCE_LABEL[task.source] || 'Other';
}

// Fixed display order (not alphabetical): Mentioned, Missive, IRIS, then
// anything else. Groups not listed here sort after, alphabetically.
const GROUP_ORDER = ['Mentioned', 'Missive', 'IRIS'];
function groupSortKey(label) {
  const i = GROUP_ORDER.indexOf(label);
  return i === -1 ? GROUP_ORDER.length : i;
}

// ---- Multi-select filters (ticket type, priority) ----
// Both work the same way, so this is one factory wired up twice below
// rather than two near-duplicate blocks that'd drift apart over time.

function setupMultiselectFilter({ btnId, panelId, listId, selectAllId, selectNoneId, filterSet, valueOf, allLabel, emptyLabel }) {
  const btn = document.getElementById(btnId);
  const panel = document.getElementById(panelId);
  const list = document.getElementById(listId);

  function updateBtn() {
    if (filterSet.size === 0) btn.textContent = allLabel;
    else if (filterSet.size === 1) btn.textContent = [...filterSet][0];
    else btn.textContent = `${filterSet.size} selected`;
  }

  function populate(tasks) {
    const values = [...new Set(tasks.map(valueOf).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    // Drop selections for values no longer present in this tab's data.
    for (const v of [...filterSet]) {
      if (!values.includes(v)) filterSet.delete(v);
    }
    list.innerHTML = values.map((v) => `
      <label class="ms-item">
        <input type="checkbox" value="${escapeHtml(v)}" ${filterSet.has(v) ? 'checked' : ''} />
        ${escapeHtml(v)}
      </label>`).join('') || `<p class="task-sub">${emptyLabel}</p>`;
    updateBtn();
  }

  btn.addEventListener('click', () => { panel.hidden = !panel.hidden; });
  list.addEventListener('change', (e) => {
    if (e.target.type !== 'checkbox') return;
    if (e.target.checked) filterSet.add(e.target.value);
    else filterSet.delete(e.target.value);
    updateBtn();
    render();
  });
  document.getElementById(selectAllId).addEventListener('click', () => {
    list.querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.checked = true; filterSet.add(cb.value); });
    updateBtn();
    render();
  });
  document.getElementById(selectNoneId).addEventListener('click', () => {
    list.querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.checked = false; });
    filterSet.clear();
    updateBtn();
    render();
  });

  return { populate, panel };
}

const typeFilterUI = setupMultiselectFilter({
  btnId: 'typeMsBtn', panelId: 'typeMsPanel', listId: 'typeCheckboxList',
  selectAllId: 'typeSelectAll', selectNoneId: 'typeSelectNone',
  filterSet: state.typeFilters, valueOf: (t) => t.meta?.type,
  allLabel: 'All ticket types', emptyLabel: 'No ticket types in this tab.',
});
const priorityFilterUI = setupMultiselectFilter({
  btnId: 'priorityMsBtn', panelId: 'priorityMsPanel', listId: 'priorityCheckboxList',
  selectAllId: 'prioritySelectAll', selectNoneId: 'prioritySelectNone',
  filterSet: state.priorityFilters, valueOf: (t) => t.meta?.priority,
  allLabel: 'All priorities', emptyLabel: 'No priorities in this tab.',
});

function populateFilters() {
  typeFilterUI.populate(state.tasks);
  priorityFilterUI.populate(state.tasks);
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.multiselect')) {
    typeFilterUI.panel.hidden = true;
    priorityFilterUI.panel.hidden = true;
  }
});

// ---- Search (debounced) ----

let searchDebounce;
document.getElementById('searchInput').addEventListener('input', (e) => {
  clearTimeout(searchDebounce);
  const value = e.target.value.trim();
  searchDebounce = setTimeout(() => {
    state.search = value;
    closeDetail();
    loadTasks();
  }, 300);
});

// Sort is a display preference, not a filter -- it deliberately isn't reset
// on tab switch the way search/type/priority are (see activateTabUI).
document.getElementById('sortSelect').addEventListener('change', (e) => {
  state.sort = e.target.value;
  loadTasks();
});

// Type/priority filters are IRIS ticket concepts, so they'd otherwise hide
// every Missive task outright (no type/priority to match) whenever any
// filter is active. Mentioned tickets bypass filtering too, on the theory
// that "someone tagged you" should never be one click away from invisible.
function visibleTasks() {
  const hasFilters = state.typeFilters.size > 0 || state.priorityFilters.size > 0;
  document.getElementById('listFilterNote').hidden = !hasFilters;
  if (!hasFilters) return state.tasks;
  return state.tasks.filter((t) => {
    if (t.reason === 'mentioned' || t.source === 'missive') return true;
    const typeOk = state.typeFilters.size === 0 || (t.meta?.type && state.typeFilters.has(t.meta.type));
    const priorityOk = state.priorityFilters.size === 0 || (t.meta?.priority && state.priorityFilters.has(t.meta.priority));
    return typeOk && priorityOk;
  });
}

function render() {
  const list = document.getElementById('taskList');
  const empty = document.getElementById('emptyState');
  list.innerHTML = '';

  const visible = visibleTasks();
  if (!visible.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const groups = new Map();
  for (const task of visible) {
    const label = groupLabel(task);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(task);
  }
  const sortedLabels = [...groups.keys()].sort((a, b) => groupSortKey(a) - groupSortKey(b) || a.localeCompare(b));

  for (const label of sortedLabels) {
    const tasks = groups.get(label);
    const collapsed = state.collapsedGroups.has(label);

    const header = document.createElement('li');
    header.className = 'group-header';
    header.innerHTML = `
      <span class="group-label"><span class="group-caret">${collapsed ? '▸' : '▾'}</span>${escapeHtml(label)}</span>
      <span class="group-count">${tasks.length}</span>`;
    header.addEventListener('click', () => {
      if (collapsed) state.collapsedGroups.delete(label);
      else state.collapsedGroups.add(label);
      render();
    });
    list.appendChild(header);

    if (!collapsed) {
      for (const task of tasks) {
        list.appendChild(renderTaskItem(task));
      }
    }
  }
}

// 'resolved' is API-driven only (see server/poller.js -- the source always
// wins on the next poll, and PATCHing a task to 'resolved' actually closes
// the real ticket in IRIS). It's deliberately not a quick-move/bulk target:
// a stray click shouldn't resolve a live support ticket, and once IRIS or
// Missive reports something resolved, it stays there until the source says
// otherwise -- there's nothing useful a manual "un-resolve" would do.
const QUICK_MOVE_TARGETS = {
  open: [['done', 'Done']],
  resolved: [],
  done: [['open', 'Open']],
};

function renderTaskItem(task) {
  const li = document.createElement('li');
  li.className = 'task-item';
  li.dataset.id = task.id;
  if (task.id === state.activeTaskId) li.classList.add('active');
  if (state.selectedIds.has(task.id)) li.classList.add('selected');

  // No per-row "Mentioned" badge: every mentioned task already lives under
  // the "Mentioned" group header (see groupLabel above), so it'd be pure
  // redundancy -- and it was the extra flex-shrink:0 element crowding out
  // the DBA/MID text down to nothing on those rows.
  const typeBadge = task.meta?.type ? `<span class="task-type" title="${escapeHtml(task.meta.type)}">${escapeHtml(task.meta.type)}</span>` : '';
  // Date added in the *source* (IRIS/Missive), not when we happened to
  // sync it into this dashboard (task.created_at) -- and not updated_at,
  // since every poll touches that on every row whether or not anything
  // actually changed. Falls back to our own created_at for manual tasks,
  // which have no source to ask. Resolved is the exception: resolved_at is
  // when the ticket was actually resolved.
  const timeField = state.tab === 'resolved' ? task.resolved_at : (task.meta?.createdAt || task.created_at);
  const lastCommentField = task.meta?.lastCommentAt;

  const mid = task.source === 'iris' ? task.meta?.merchantId : null;
  const dba = mid ? state.dbaCache[mid] : null;
  let subText = '';
  if (mid) {
    subText = `<span class="task-merchant" data-mid="${escapeHtml(mid)}">${dba ? escapeHtml(dba) : '…'} · ${escapeHtml(mid)}</span>`;
  }

  const moveOptions = QUICK_MOVE_TARGETS[task.status] || [];
  // Resolved rows get no manual status controls at all -- see the note on
  // QUICK_MOVE_TARGETS above. Bulk-select would otherwise let "Move to
  // Done" apply to resolved items too, which the next poll just reverts.
  const canManuallyMove = task.status !== 'resolved';

  li.innerHTML = `
    ${canManuallyMove ? `<input type="checkbox" class="task-checkbox" ${state.selectedIds.has(task.id) ? 'checked' : ''} />` : '<span class="task-checkbox-spacer"></span>'}
    <span class="importance-bar importance-${task.importance}" title="${IMPORTANCE_LABEL[task.importance]} priority"></span>
    <div class="task-main">
      <div class="task-row-1">
        <span class="task-title" title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</span>
        <span class="task-times">
          <span class="task-time" title="${state.tab === 'resolved' ? 'Resolved' : 'Added'} ${timeField ? parseSqliteUtc(timeField).toLocaleString() : ''}">${state.tab === 'resolved' ? 'Resolved' : 'Added'} ${formatRelativeTime(timeField)}</span>
          ${lastCommentField ? `<span class="task-time task-time-comment" title="Last comment ${parseSqliteUtc(lastCommentField).toLocaleString()}">💬 ${formatRelativeTime(lastCommentField)}</span>` : ''}
        </span>
      </div>
      <div class="task-row-2">
        ${sourceBadgeHtml(task.source)}
        ${typeBadge}
        ${subText}
      </div>
    </div>
    ${moveOptions.length ? `
    <div class="task-quick-menu">
      <button type="button" class="task-kebab" title="Move to…">⋮</button>
      <div class="task-kebab-panel" hidden>
        ${moveOptions.map(([status, label]) => `<button type="button" data-move-status="${status}">Move to ${label}</button>`).join('')}
      </div>
    </div>` : ''}
    ${task.url ? `<a class="task-source-link" href="${task.url}" target="_blank" rel="noopener" title="Open in source">↗</a>` : ''}
  `;

  li.querySelector('.task-checkbox')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target.checked) state.selectedIds.add(task.id);
    else state.selectedIds.delete(task.id);
    li.classList.toggle('selected', e.target.checked);
    renderBulkBar();
  });

  const kebabBtn = li.querySelector('.task-kebab');
  const kebabPanel = li.querySelector('.task-kebab-panel');
  if (kebabBtn) {
    kebabBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.task-kebab-panel').forEach((p) => { if (p !== kebabPanel) p.hidden = true; });
      kebabPanel.hidden = !kebabPanel.hidden;
    });
    kebabPanel.querySelectorAll('[data-move-status]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        kebabPanel.hidden = true;
        await api(`/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ status: btn.dataset.moveStatus }) });
        await Promise.all([loadTasks(), loadCounts()]);
      });
    });
  }

  li.addEventListener('click', (e) => {
    if (e.target.closest('.task-source-link, .task-checkbox, .task-quick-menu')) return;
    openDetail(task.id);
  });

  return li;
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.task-quick-menu')) {
    document.querySelectorAll('.task-kebab-panel').forEach((p) => { p.hidden = true; });
  }
});

// ---- Bulk edit ----

function renderBulkBar() {
  const bar = document.getElementById('bulkBar');
  // Resolved is API-driven only (see the QUICK_MOVE_TARGETS note above) --
  // never show bulk move/clear controls there, regardless of selection state.
  if (state.selectedIds.size === 0 || state.tab === 'resolved') {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  document.getElementById('bulkCount').textContent = `${state.selectedIds.size} selected`;
}

document.querySelectorAll('[data-bulk-status]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const status = btn.dataset.bulkStatus;
    const ids = [...state.selectedIds];
    await Promise.all(ids.map((id) => api(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) })));
    await Promise.all([loadTasks(), loadCounts()]);
  });
});
document.getElementById('bulkClear').addEventListener('click', () => {
  state.selectedIds.clear();
  render();
  renderBulkBar();
});

// Resolve DBA names for every merchant id currently on screen that we
// haven't already looked up. Fetched in small chunks rather than one giant
// request -- with hundreds of distinct merchants on first load (each an
// uncached, real IRIS API call server-side), a single request wouldn't
// resolve for many seconds and every row would sit on "…" the whole time.
async function fetchMissingDbas() {
  const mids = [...new Set(
    state.tasks
      .filter((t) => t.source === 'iris' && t.meta?.merchantId)
      .map((t) => t.meta.merchantId)
      .filter((mid) => !(mid in state.dbaCache))
  )];
  if (!mids.length) return;

  const CHUNK_SIZE = 20;
  for (let i = 0; i < mids.length; i += CHUNK_SIZE) {
    const chunk = mids.slice(i, i + CHUNK_SIZE);
    try {
      const result = await api(`/iris/merchants?mids=${chunk.join(',')}`);
      Object.assign(state.dbaCache, result);
      for (const [mid, dba] of Object.entries(result)) {
        document.querySelectorAll(`.task-merchant[data-mid="${CSS.escape(mid)}"]`).forEach((el) => {
          el.textContent = `${dba || 'Unknown merchant'} · ${mid}`;
        });
      }
    } catch (err) {
      console.error('Failed to load merchant DBAs:', err);
    }
  }
}

// SQLite's own timestamps (created_at/updated_at/resolved_at/done_at) come
// back as naive UTC strings like "2026-08-14 20:53:47" -- no 'T', no 'Z'.
// `new Date(...)` on a string like that is parsed as *local* time by JS, so
// every such value needs this before use, or it silently shifts by however
// far the browser's timezone is from UTC. IRIS/Missive-native timestamps
// (already ISO-with-offset or epoch seconds) don't need this.
function parseSqliteUtc(str) {
  if (!str) return null;
  return new Date(str.includes('T') || str.includes('Z') ? str : `${str.replace(' ', 'T')}Z`);
}

function formatRelativeTime(iso) {
  if (!iso) return '';
  const date = parseSqliteUtc(iso);
  const diffMs = Date.now() - date.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ---- Tabs ----

function activateTabUI(tab) {
  document.querySelector('.tab.active')?.classList.remove('active');
  document.querySelector(`.tab[data-tab="${tab}"]`)?.classList.add('active');
  state.tab = tab;
  closeDetail();

  // Resolved is a fixed, date-sorted, capped-at-25 list -- search/type
  // filtering doesn't apply there, so the controls (and any filters left
  // over from another tab) are hidden rather than shown-but-useless.
  document.getElementById('listFilter').hidden = tab === 'resolved';
  if (tab === 'resolved') {
    state.typeFilters.clear();
    state.priorityFilters.clear();
    state.search = '';
    document.getElementById('searchInput').value = '';
    document.getElementById('listFilterNote').hidden = true;
  }
}

function setTab(tab) {
  activateTabUI(tab);
  state.typeFilters.clear();
  state.priorityFilters.clear();
  state.search = '';
  document.getElementById('searchInput').value = '';
  loadTasks();
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => setTab(btn.dataset.tab));
});

document.getElementById('syncBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncBtn');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    await api('/sync', { method: 'POST' });
    await Promise.all([loadTasks(), loadCounts()]);
  } finally {
    btn.disabled = false;
    btn.textContent = '⟳ Sync';
  }
});

// ---- Panel resizer ----

const LIST_WIDTH_KEY = 'furry-disco:listPanelWidth';
(function initResizer() {
  const listPanel = document.querySelector('.list-panel');
  const resizer = document.getElementById('panelResizer');
  const saved = Number(localStorage.getItem(LIST_WIDTH_KEY));
  if (saved) listPanel.style.width = `${saved}px`;

  let startX = 0;
  let startWidth = 0;
  function onMove(e) {
    const next = Math.min(800, Math.max(320, startWidth + (e.clientX - startX)));
    listPanel.style.width = `${next}px`;
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.classList.remove('resizing');
    localStorage.setItem(LIST_WIDTH_KEY, parseInt(listPanel.style.width, 10));
  }
  resizer.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startWidth = listPanel.getBoundingClientRect().width;
    document.body.classList.add('resizing');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
})();

// ---- Detail panel (persistent split view, not an overlay) ----
async function openDetail(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  state.activeTaskId = taskId;
  document.querySelector('#taskList .task-item.active')?.classList.remove('active');
  document.querySelector(`#taskList .task-item[data-id="${taskId}"]`)?.classList.add('active');

  document.getElementById('drawerTitle').textContent = task.title;
  setSourceBadge(document.getElementById('drawerSource'), task.source);
  const link = document.getElementById('drawerLink');
  if (task.url) {
    link.href = task.url;
    link.textContent = SOURCE_LINK_LABEL[task.source] || 'Open ↗';
    link.style.display = 'inline';
  } else {
    link.style.display = 'none';
  }

  const merchantLink = document.getElementById('drawerMerchantLink');
  const mid = task.source === 'iris' ? task.meta?.merchantId : null;
  if (mid) {
    merchantLink.href = merchantUrl(mid);
    merchantLink.style.display = 'inline';
  } else {
    merchantLink.style.display = 'none';
  }
  document.getElementById('statusSelect').value = task.status;
  // Resolved is API-driven only -- once a ticket lands there, nothing
  // manual should move it back out (see QUICK_MOVE_TARGETS above).
  document.getElementById('statusSelect').disabled = task.status === 'resolved';
  document.getElementById('importanceSelect').value = task.importance;

  document.getElementById('detailEmpty').hidden = true;
  document.getElementById('detailContent').hidden = false;
  document.querySelector('.detail-panel').scrollTop = 0;
  closePdfViewer();
  state.commentFiles = {};

  const missiveBox = document.getElementById('missiveThread');
  if (task.source === 'missive') {
    missiveBox.hidden = false;
    setMissiveThreadCollapsed(true); // collapsed by default each time a task is opened
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

  const ticketInfoBox = document.getElementById('ticketInfo');
  state.ticketAssignees = [];
  renderNotifyPicker(); // reset/hide until (if) the fetch below repopulates it
  document.getElementById('relatedTickets').hidden = true; // reset/hide until (if) repopulated below
  clearSelectedCommentFile();
  document.getElementById('attachFileRow').hidden = task.source !== 'iris';
  if (task.source === 'iris') {
    ticketInfoBox.hidden = false;
    document.getElementById('ticketInfoBody').innerHTML = '<p class="task-sub">Loading ticket info…</p>';
    try {
      const info = await api(`/iris/ticket/${task.id}`);
      state.commentFiles = info.commentFiles || {};
      state.ticketAssignees = info.assignees || [];
      renderTicketInfo(info);
      renderRelatedTickets(info.relatedOpenTickets || []);
      renderNotifyPicker();
    } catch (err) {
      document.getElementById('ticketInfoBody').innerHTML = `<p class="task-sub">Failed to load ticket info: ${escapeHtml(err.message)}</p>`;
    }
  } else {
    ticketInfoBox.hidden = true;
  }

  await loadComments(taskId);
}

// Lets you narrow who gets notified about a comment, instead of always
// relying on IRIS's default (in practice: everyone else on the ticket).
// Checked by default for everyone -- that matches the existing implicit
// behavior, so not touching it changes nothing.
function renderNotifyPicker() {
  const picker = document.getElementById('notifyPicker');
  const list = document.getElementById('notifyPickerList');
  if (!state.ticketAssignees.length) {
    picker.hidden = true;
    list.innerHTML = '';
    return;
  }
  picker.hidden = false;
  list.innerHTML = state.ticketAssignees.map((u) => `
    <label class="notify-item">
      <input type="checkbox" value="${u.id}" checked />
      ${escapeHtml(u.name)}
    </label>`).join('');
}

function selectedNotifyIds() {
  return [...document.querySelectorAll('#notifyPickerList input[type=checkbox]:checked')].map((cb) => cb.value);
}

// ---- Comment file attachment ----

function clearSelectedCommentFile() {
  state.selectedCommentFile = null;
  document.getElementById('commentFileInput').value = '';
  document.getElementById('selectedFileInfo').hidden = true;
  document.getElementById('attachFileName').value = '';
}

document.getElementById('chooseFileBtn').addEventListener('click', () => {
  document.getElementById('commentFileInput').click();
});
document.getElementById('commentFileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  state.selectedCommentFile = file;
  document.getElementById('attachFileName').value = file.name;
  document.getElementById('selectedFileInfo').hidden = false;
});
document.getElementById('removeFileBtn').addEventListener('click', clearSelectedCommentFile);

// Uploads the raw file bytes (not through api(), which always sends JSON)
// and returns the fileId IRIS wants as extended_files[].tmp_name when
// posting the comment. name is the (possibly user-edited) display name --
// separate from the File object's own original name.
async function uploadCommentFile(taskId, file, name) {
  const res = await fetch(`/api/iris/ticket/${taskId}/upload?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    body: file,
  });
  if (!res.ok) throw new Error(`upload -> ${res.status}`);
  const { fileId } = await res.json();
  return fileId;
}

// A copy-to-clipboard button next to a value -- used for DBA/MID, the two
// fields most likely to get pasted somewhere else (a search box, a note to
// a coworker, etc.). data-copy-value carries the raw value since the
// visible text may later get replaced by a "Copied" flash.
function copyButtonHtml(value) {
  return `<button type="button" class="copy-btn" data-copy-value="${escapeHtml(value)}" title="Copy">⧉</button>`;
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  try {
    await navigator.clipboard.writeText(btn.dataset.copyValue);
    const original = btn.textContent;
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = original; }, 1000);
  } catch (err) {
    console.error('Copy to clipboard failed:', err);
  }
});

function renderTicketInfo(info) {
  const box = document.getElementById('ticketInfoBody');
  const dba = info.merchantId ? state.dbaCache[info.merchantId] : null;
  const rows = [
    ['Status', info.status],
    ['Priority', info.priority],
    ['Type', info.type],
    ['Group', info.group],
    ['DBA', info.merchantId ? (dba || '…') : ''],
    ['Merchant ID', info.merchantId],
    ['Assigned to', (info.assignedUsers || []).join(', ')],
    ['Due', info.due],
    ['Created', info.createdAt ? `${new Date(info.createdAt).toLocaleString()} by ${info.createdBy || 'Unknown'}` : ''],
    ['Resolved', info.resolvedAt ? `${new Date(info.resolvedAt).toLocaleString()} by ${info.resolvedBy || 'Unknown'}` : ''],
  ].filter(([, v]) => v);

  box.innerHTML = `
    ${info.description ? `<p class="ticket-description">${highlightMentions(escapeHtml(info.description))}</p>` : ''}
    <dl class="ticket-fields">
      ${rows.map(([label, value]) => {
        const copyable = label === 'DBA' || label === 'Merchant ID';
        return `<dt>${escapeHtml(label)}</dt><dd class="${copyable ? 'ticket-field-copyable' : ''}">${escapeHtml(value)}${copyable && value !== '…' ? copyButtonHtml(value) : ''}</dd>`;
      }).join('')}
    </dl>
    ${(info.files || []).length ? `<div class="attachments">${info.files.map(attachmentChipHtml).join('')}</div>` : ''}`;

  wireAttachmentChips(box);

  // DBA is resolved from the same client-side cache the task list uses --
  // if this merchant hasn't been looked up yet, fetch it and patch the row
  // in place once it resolves, same pattern as fetchMissingDbas().
  if (info.merchantId && !dba) {
    api(`/iris/merchants?mids=${info.merchantId}`)
      .then((result) => {
        Object.assign(state.dbaCache, result);
        const resolved = result[info.merchantId];
        if (!resolved || state.activeTaskId == null) return;
        const dbaDt = [...box.querySelectorAll('dt')].find((el) => el.textContent === 'DBA');
        if (!dbaDt) return;
        dbaDt.nextElementSibling.innerHTML = `${escapeHtml(resolved)}${copyButtonHtml(resolved)}`;
      })
      .catch((err) => console.error('Failed to load DBA for ticket info:', err));
  }
}

function renderRelatedTickets(related) {
  const box = document.getElementById('relatedTickets');
  if (!related.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  document.getElementById('relatedTicketsList').innerHTML = related.map((t) => `
    <li class="related-ticket-item" data-related-task="${t.id}">
      <span class="related-ticket-title" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
      ${t.type ? `<span class="related-ticket-type">${escapeHtml(t.type)}</span>` : ''}
    </li>`).join('');

  document.querySelectorAll('[data-related-task]').forEach((li) => {
    li.addEventListener('click', () => openRelatedTicket(li.dataset.relatedTask));
  });
}

// Related tickets are always status='open', but the currently-loaded
// state.tasks might not include it -- e.g. you're viewing Done/Resolved, or
// Open with an active search narrowing the server-side result set. Rather
// than silently no-op, switch to a clean Open-tab view first so the click
// always actually navigates there.
async function openRelatedTicket(id) {
  if (!state.tasks.some((t) => t.id === id)) {
    state.search = '';
    document.getElementById('searchInput').value = '';
    activateTabUI('open');
    await loadTasks();
  }
  openDetail(id);
}

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentChipHtml(file) {
  return `
    <button type="button" class="attachment-chip" data-attachment-id="${file.id}" data-name="${escapeHtml(file.name)}">
      📎 <span class="attachment-name">${escapeHtml(file.name)}</span>
      <span class="attachment-size">${formatBytes(file.size)}</span>
    </button>`;
}

function wireAttachmentChips(container) {
  container.querySelectorAll('.attachment-chip').forEach((chip) => {
    chip.addEventListener('click', () => openAttachment(chip.dataset.attachmentId, chip.dataset.name));
  });
}

function openAttachment(attachmentId, name) {
  const url = `/api/iris/ticket/${state.activeTaskId}/attachment/${attachmentId}?name=${encodeURIComponent(name)}`;
  if (/\.pdf$/i.test(name)) {
    document.getElementById('pdfViewerName').textContent = name;
    document.getElementById('pdfViewerDownload').href = url;
    document.getElementById('pdfViewerFrame').src = url;
    document.getElementById('pdfViewer').hidden = false;
    document.getElementById('pdfViewer').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

function closePdfViewer() {
  document.getElementById('pdfViewer').hidden = true;
  document.getElementById('pdfViewerFrame').src = '';
}
document.getElementById('pdfViewerClose').addEventListener('click', closePdfViewer);

function setMissiveThreadCollapsed(collapsed) {
  document.getElementById('missiveMessages').hidden = collapsed;
  document.getElementById('missiveThreadCaret').textContent = collapsed ? '▸' : '▾';
}
document.getElementById('missiveThreadToggle').addEventListener('click', () => {
  setMissiveThreadCollapsed(!document.getElementById('missiveMessages').hidden);
});

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
  // best-effort background refresh from source, then re-render -- failures
  // here shouldn't block the UI (the locally-cached comments are already
  // showing), but they shouldn't be invisible either.
  api(`/comments/task/${taskId}/sync`, { method: 'POST' })
    .then(async (result) => {
      if (result?.synced) {
        const fresh = await api(`/comments/task/${taskId}`);
        renderComments(fresh);
      }
    })
    .catch((err) => console.error('Failed to refresh comments from source:', err));
}

function renderComments(comments) {
  const list = document.getElementById('commentList');
  if (!comments.length) {
    list.innerHTML = '<li class="task-sub">No comments yet.</li>';
    return;
  }
  list.innerHTML = comments
    .map((c) => {
      const files = state.commentFiles[c.remote_id];
      return `
      <li class="comment-item${mentionsMe(c.body) ? ' comment-item-mentioned' : ''}">
        <div class="comment-item-meta">${escapeHtml(c.author || 'Unknown')} · ${parseSqliteUtc(c.created_at).toLocaleString()} ${c.origin === 'iris' ? '· from IRIS' : ''}</div>
        <div>${highlightMentions(escapeHtml(c.body))}</div>
        ${files?.length ? `<div class="attachments">${files.map(attachmentChipHtml).join('')}</div>` : ''}
      </li>`;
    })
    .join('');
  wireAttachmentChips(list);
}

document.getElementById('drawerClose').addEventListener('click', closeDetail);
function closeDetail() {
  document.getElementById('detailContent').hidden = true;
  document.getElementById('detailEmpty').hidden = false;
  document.querySelector('#taskList .task-item.active')?.classList.remove('active');
  state.activeTaskId = null;
  closePdfViewer();
}

document.getElementById('statusSelect').addEventListener('change', async (e) => {
  if (!state.activeTaskId) return;
  await api(`/tasks/${state.activeTaskId}`, { method: 'PATCH', body: JSON.stringify({ status: e.target.value }) });
  await Promise.all([loadTasks(), loadCounts()]);
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
  const notify = state.ticketAssignees.length ? selectedNotifyIds() : undefined;

  const btn = document.getElementById('postCommentBtn');
  btn.disabled = true;
  try {
    let extendedFiles;
    if (state.selectedCommentFile) {
      btn.textContent = 'Uploading file…';
      const name = document.getElementById('attachFileName').value.trim() || state.selectedCommentFile.name;
      const fileId = await uploadCommentFile(state.activeTaskId, state.selectedCommentFile, name);
      extendedFiles = [{ tmp_name: fileId, title: name }];
    }
    btn.textContent = 'Posting…';
    await api(`/comments/task/${state.activeTaskId}`, { method: 'POST', body: JSON.stringify({ body, notify, extendedFiles }) });
    textarea.value = '';
    document.getElementById('templateSelect').value = '';
    clearSelectedCommentFile();
    await loadComments(state.activeTaskId);
  } catch (err) {
    alert(`Failed to post comment: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Post comment';
  }
});

// ---- New task modal ----
document.getElementById('newTaskBtn').addEventListener('click', () => {
  document.getElementById('newTaskModal').hidden = false;
});
document.getElementById('newTaskClose').addEventListener('click', () => {
  document.getElementById('newTaskModal').hidden = true;
});
document.querySelector('#newTaskModal .modal-backdrop').addEventListener('click', () => {
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
  await loadCounts();
});

// ---- Saved views (persisted client-side; this is a single-user tool) ----

const VIEWS_KEY = 'furry-disco:views';
const DEFAULT_VIEW_KEY = 'furry-disco:defaultViewId';

function loadViewsFromStorage() {
  try {
    state.views = JSON.parse(localStorage.getItem(VIEWS_KEY) || '[]');
  } catch {
    state.views = [];
  }
}

function persistViews() {
  localStorage.setItem(VIEWS_KEY, JSON.stringify(state.views));
}

function renderViewSelect() {
  const sel = document.getElementById('viewSelect');
  const defaultId = localStorage.getItem(DEFAULT_VIEW_KEY);
  sel.innerHTML = '<option value="">Views…</option>' +
    state.views.map((v) => `<option value="${v.id}">${escapeHtml(v.name)}${v.id === defaultId ? ' ★' : ''}</option>`).join('');
}

function applyView(view) {
  activateTabUI(view.tab);
  // Mutate the existing Sets rather than reassigning state.typeFilters /
  // state.priorityFilters -- the multiselect filter UI closures captured
  // those exact Set objects by reference at setup time, so a reassignment
  // here would desync the checkboxes from what's actually being filtered.
  state.typeFilters.clear();
  (view.typeFilters || []).forEach((v) => state.typeFilters.add(v));
  state.priorityFilters.clear();
  (view.priorityFilters || []).forEach((v) => state.priorityFilters.add(v));
  state.search = view.search || '';
  document.getElementById('searchInput').value = state.search;
  state.sort = view.sort || 'added';
  document.getElementById('sortSelect').value = state.sort;
  loadTasks();
}

document.getElementById('viewSelect').addEventListener('change', (e) => {
  const view = state.views.find((v) => v.id === e.target.value);
  if (view) applyView(view);
});

document.getElementById('saveViewBtn').addEventListener('click', () => {
  document.getElementById('saveViewName').value = '';
  document.getElementById('saveViewDefault').checked = false;
  document.getElementById('saveViewModal').hidden = false;
});
document.getElementById('saveViewClose').addEventListener('click', () => {
  document.getElementById('saveViewModal').hidden = true;
});
document.querySelector('#saveViewModal .modal-backdrop').addEventListener('click', () => {
  document.getElementById('saveViewModal').hidden = true;
});
document.getElementById('saveViewConfirm').addEventListener('click', () => {
  const name = document.getElementById('saveViewName').value.trim();
  if (!name) return;
  const id = crypto.randomUUID();
  state.views.push({
    id,
    name,
    tab: state.tab,
    typeFilters: [...state.typeFilters],
    priorityFilters: [...state.priorityFilters],
    search: state.search,
    sort: state.sort,
  });
  persistViews();
  if (document.getElementById('saveViewDefault').checked) {
    localStorage.setItem(DEFAULT_VIEW_KEY, id);
  }
  renderViewSelect();
  document.getElementById('viewSelect').value = id;
  document.getElementById('saveViewModal').hidden = true;
});

document.getElementById('manageViewsBtn').addEventListener('click', () => {
  renderManageViews();
  document.getElementById('manageViewsModal').hidden = false;
});
document.getElementById('manageViewsClose').addEventListener('click', () => {
  document.getElementById('manageViewsModal').hidden = true;
});
document.querySelector('#manageViewsModal .modal-backdrop').addEventListener('click', () => {
  document.getElementById('manageViewsModal').hidden = true;
});

function renderManageViews() {
  const list = document.getElementById('viewsManageList');
  const defaultId = localStorage.getItem(DEFAULT_VIEW_KEY);
  if (!state.views.length) {
    list.innerHTML = '<p class="task-sub">No saved views yet.</p>';
    return;
  }
  list.innerHTML = state.views.map((v) => `
    <li class="views-manage-item">
      <span>${escapeHtml(v.name)}</span>
      <div class="views-manage-actions">
        <button type="button" data-set-default="${v.id}" class="btn btn-ghost">${v.id === defaultId ? '★ Default' : '☆ Set default'}</button>
        <button type="button" data-delete-view="${v.id}" class="btn btn-ghost">Delete</button>
      </div>
    </li>`).join('');

  list.querySelectorAll('[data-set-default]').forEach((btn) => {
    btn.addEventListener('click', () => {
      localStorage.setItem(DEFAULT_VIEW_KEY, btn.dataset.setDefault);
      renderManageViews();
      renderViewSelect();
    });
  });
  list.querySelectorAll('[data-delete-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.deleteView;
      state.views = state.views.filter((v) => v.id !== id);
      persistViews();
      if (localStorage.getItem(DEFAULT_VIEW_KEY) === id) localStorage.removeItem(DEFAULT_VIEW_KEY);
      renderManageViews();
      renderViewSelect();
    });
  });
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

// ---- Boot ----
loadViewsFromStorage();
renderViewSelect();
const defaultViewId = localStorage.getItem(DEFAULT_VIEW_KEY);
const defaultView = state.views.find((v) => v.id === defaultViewId);
if (defaultView) {
  applyView(defaultView);
  document.getElementById('viewSelect').value = defaultView.id;
} else {
  loadTasks();
}
loadCounts();
loadTemplates();
