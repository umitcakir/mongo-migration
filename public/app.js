'use strict';

const state = {
  connections: [],
  collections: [],
  jobId: null,
  eventSource: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3500);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

/* ---------- wizard navigation ---------- */

function goToStep(step) {
  const target = Number(step);
  $$('.step').forEach((el) => el.classList.toggle('active', Number(el.dataset.step) === target));
  $$('.panel').forEach((el) => el.classList.toggle('active', Number(el.dataset.panel) === target));
  if (target === 3) loadCollections();
  if (target === 5) renderSummary();
}

$$('.step').forEach((el) => el.addEventListener('click', () => goToStep(el.dataset.step)));
$$('.next, .back').forEach((el) => el.addEventListener('click', () => goToStep(el.dataset.goto)));

/* ---------- connections ---------- */

async function loadConnections() {
  state.connections = await api('/api/connections');
  renderConnections();
  renderConnectionSelects();
}

function renderConnections() {
  const list = $('#connection-list');
  list.innerHTML = '';
  if (!state.connections.length) {
    list.innerHTML = '<li><span class="host">No connections yet.</span></li>';
    return;
  }
  for (const conn of state.connections) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.innerHTML = `<div>${escapeHtml(conn.name)}</div><div class="host">${escapeHtml(conn.host)}</div>`;
    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      await api(`/api/connections/${conn.id}`, { method: 'DELETE' });
      await loadConnections();
    });
    li.append(info, remove);
    list.append(li);
  }
}

function renderConnectionSelects() {
  for (const id of ['#source-conn', '#target-conn']) {
    const select = $(id);
    const previous = select.value;
    select.innerHTML = '';
    for (const conn of state.connections) {
      const option = document.createElement('option');
      option.value = conn.id;
      option.textContent = `${conn.name} (${conn.host})`;
      select.append(option);
    }
    if (state.connections.some((c) => c.id === previous)) select.value = previous;
  }
  loadDatabases('#source-conn', '#source-db');
  loadDatabases('#target-conn', '#target-db-options');
}

$('#connection-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button');
  button.disabled = true;
  try {
    await api('/api/connections', {
      method: 'POST',
      body: JSON.stringify({ name: $('#conn-name').value, uri: $('#conn-uri').value }),
    });
    $('#conn-name').value = '';
    $('#conn-uri').value = '';
    await loadConnections();
    toast('Connection added');
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
});

/* ---------- databases & collections ---------- */

async function loadDatabases(connSelector, targetSelector) {
  const connectionId = $(connSelector).value;
  const target = $(targetSelector);
  if (!connectionId) {
    target.innerHTML = '';
    return;
  }
  try {
    const databases = await api(`/api/connections/${connectionId}/databases`);
    target.innerHTML = '';
    for (const db of databases) {
      const option = document.createElement('option');
      option.value = db.name;
      option.textContent = db.name;
      target.append(option);
    }
  } catch (err) {
    toast(err.message, true);
  }
}

$('#source-conn').addEventListener('change', () => loadDatabases('#source-conn', '#source-db'));
$('#target-conn').addEventListener('change', () => loadDatabases('#target-conn', '#target-db-options'));
$('#source-db').addEventListener('change', () => {
  if (!$('#target-db').value) $('#target-db').value = $('#source-db').value;
});

async function loadCollections() {
  const connectionId = $('#source-conn').value;
  const database = $('#source-db').value;
  const tbody = $('#collection-rows');
  if (!connectionId || !database) {
    tbody.innerHTML = '<tr><td colspan="4">Pick a source server and database first.</td></tr>';
    return;
  }
  tbody.innerHTML = '<tr><td colspan="4">Loading…</td></tr>';
  try {
    state.collections = await api(`/api/connections/${connectionId}/databases/${encodeURIComponent(database)}/collections`);
    renderCollections();
  } catch (err) {
    tbody.innerHTML = '';
    toast(err.message, true);
  }
}

function renderCollections() {
  const tbody = $('#collection-rows');
  tbody.innerHTML = '';
  if (!state.collections.length) {
    tbody.innerHTML = '<tr><td colspan="4">No collections found.</td></tr>';
    return;
  }
  for (const collection of state.collections) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" class="pick" checked /></td>
      <td>${escapeHtml(collection.name)}</td>
      <td>${collection.count === null ? '?' : collection.count.toLocaleString()}</td>
      <td><input type="text" class="target-name" value="${escapeHtml(collection.name)}" /></td>`;
    tr.dataset.source = collection.name;
    tbody.append(tr);
  }
}

$('#select-all').addEventListener('click', () => $$('.pick').forEach((el) => (el.checked = true)));
$('#select-none').addEventListener('click', () => $$('.pick').forEach((el) => (el.checked = false)));
$('#reload-collections').addEventListener('click', loadCollections);

/* ---------- job spec ---------- */

function buildSpec() {
  const tasks = $$('#collection-rows tr')
    .filter((tr) => tr.querySelector('.pick')?.checked)
    .map((tr) => ({
      sourceDatabase: $('#source-db').value,
      sourceCollection: tr.dataset.source,
      targetDatabase: $('#target-db').value || $('#source-db').value,
      targetCollection: tr.querySelector('.target-name').value.trim() || tr.dataset.source,
    }));

  return {
    sourceConnectionId: $('#source-conn').value,
    targetConnectionId: $('#target-conn').value,
    mode: $('#opt-mode').value,
    batchSize: Number($('#opt-batch').value) || 1000,
    copyIndexes: $('#opt-indexes').checked,
    continueOnError: $('#opt-continue').checked,
    tasks,
  };
}

function connectionLabel(id) {
  const conn = state.connections.find((c) => c.id === id);
  return conn ? `${conn.name} (${conn.host})` : '—';
}

function renderSummary() {
  const spec = buildSpec();
  const lines = [
    `Source server : ${connectionLabel(spec.sourceConnectionId)}`,
    `Target server : ${connectionLabel(spec.targetConnectionId)}`,
    `Write mode    : ${spec.mode}`,
    `Batch size    : ${spec.batchSize}`,
    `Copy indexes  : ${spec.copyIndexes}`,
    '',
    `Collections (${spec.tasks.length}):`,
    ...spec.tasks.map((t) => `  ${t.sourceDatabase}.${t.sourceCollection}  ->  ${t.targetDatabase}.${t.targetCollection}`),
  ];
  $('#summary').textContent = lines.join('\n');
}

/* ---------- run ---------- */

$('#start-job').addEventListener('click', async () => {
  const spec = buildSpec();
  if (!spec.sourceConnectionId || !spec.targetConnectionId) return toast('Select both servers', true);
  if (!spec.tasks.length) return toast('Select at least one collection', true);
  if (spec.mode === 'drop' && !confirm('Drop mode deletes the target collections before copying. Continue?')) return;

  try {
    const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify(spec) });
    state.jobId = job.id;
    $('#start-job').disabled = true;
    $('#cancel-job').disabled = false;
    $('#job-log').textContent = '';
    state.transientErrors = [];
    showErrors([]);
    subscribe(job.id);
    renderJob(job);
  } catch (err) {
    toast(err.message, true);
  }
});

$('#cancel-job').addEventListener('click', async () => {
  if (!state.jobId) return;
  await api(`/api/jobs/${state.jobId}/cancel`, { method: 'POST' }).catch((err) => toast(err.message, true));
});

$('#start-over').addEventListener('click', () => {
  if ($('#cancel-job').disabled === false && !confirm('A migration is still running. Leave it and start over?')) return;
  state.eventSource?.close();
  state.eventSource = null;
  state.jobId = null;
  state.collections = [];
  $('#start-job').disabled = false;
  $('#cancel-job').disabled = true;
  $('#job-status').textContent = '';
  $('#job-status').className = 'badge';
  $('#progress-list').innerHTML = '';
  $('#job-overall').hidden = true;
  $('#job-log').textContent = '';
  state.transientErrors = [];
  showErrors([]);
  $('#summary').textContent = '';
  $('#collection-rows').innerHTML = '';
  $('#target-db').value = '';
  goToStep(1);
});

function subscribe(jobId) {
  state.eventSource?.close();
  const source = new EventSource(`/api/jobs/${jobId}/events`);
  state.eventSource = source;
  source.onmessage = (event) => {
    const job = JSON.parse(event.data);
    state.lastJob = job;
    renderJob(job);
    if (job.status !== 'running') {
      source.close();
      state.eventSource = null;
      $('#start-job').disabled = false;
      $('#cancel-job').disabled = true;
      toast(`Migration ${job.status.replace(/_/g, ' ')}`, job.status !== 'completed');
    }
  };
  source.onerror = () => {
    source.close();
    if (state.eventSource !== source) return;
    state.eventSource = null;
    state.transientErrors = [{ level: 'warn', message: 'Lost the progress stream. Falling back to polling…' }];
    pollJob(jobId);
  };
}

async function pollJob(jobId) {
  try {
    const job = await api(`/api/jobs/${jobId}`);
    state.lastJob = job;
    renderJob(job);
    if (job.status === 'running') {
      setTimeout(() => pollJob(jobId), 2000);
      return;
    }
    $('#start-job').disabled = false;
    $('#cancel-job').disabled = true;
    toast(`Migration ${job.status.replace(/_/g, ' ')}`, job.status !== 'completed');
  } catch (err) {
    state.transientErrors = [{ level: 'error', message: `Cannot reach the migration server: ${err.message}` }];
    showErrors(state.transientErrors);
    $('#start-job').disabled = false;
    $('#cancel-job').disabled = true;
  }
}

function showErrors(entries, append = false) {
  const box = $('#job-errors');
  const items = append ? [...(box._entries || []), ...entries] : entries;
  box._entries = items;

  if (!items.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = `<h4>Problems (${items.length})</h4><ul>${items
    .map((item) => `<li class="${item.level}">${escapeHtml(item.message)}</li>`)
    .join('')}</ul>`;
}

function renderJob(job) {
  const badge = $('#job-status');
  badge.textContent = job.status.replace(/_/g, ' ');
  badge.className = `badge ${job.status}`;

  const problems = [
    ...job.tasks
      .filter((task) => task.error)
      .map((task) => ({ level: 'error', message: `${task.sourceDatabase}.${task.sourceCollection}: ${task.error}` })),
    ...job.log
      .filter((entry) => entry.level === 'error' || entry.level === 'warn')
      .map((entry) => ({ level: entry.level, message: entry.message })),
  ];
  showErrors(dedupe([...(state.transientErrors || []), ...problems]));

  const container = $('#progress-list');
  container.innerHTML = '';
  for (const task of job.tasks) {
    const total = Math.max(task.total, task.copied);
    const percent = total ? Math.min(100, Math.round((task.copied / total) * 100)) : task.status === 'done' ? 100 : 0;
    const elapsed = elapsedSeconds(task.startedAt, task.finishedAt, job.serverTime);
    const rate = elapsed > 0 ? task.copied / elapsed : 0;
    const remaining = Math.max(0, total - task.copied);

    const details = [
      `${percent}%`,
      task.phase ? task.phase : null,
      `read ${task.read.toLocaleString()}`,
      `written ${task.copied.toLocaleString()} / ${task.countExact ? '' : '~'}${total.toLocaleString()}`,
      task.status === 'running' && rate > 0 ? `${Math.round(rate).toLocaleString()} docs/s` : null,
      task.status === 'running' && rate > 0 && remaining > 0 ? `ETA ${formatDuration(remaining / rate)}` : null,
      elapsed > 0 ? `elapsed ${formatDuration(elapsed)}` : null,
      task.failed ? `${task.failed.toLocaleString()} skipped` : null,
      task.targetCount !== null && task.targetCount !== undefined ? `target now ${task.targetCount.toLocaleString()}` : null,
      task.indexesCopied ? `${task.indexesCopied} indexes` : null,
    ].filter(Boolean);

    const div = document.createElement('div');
    div.className = `task ${task.status}`;
    div.innerHTML = `
      <div class="task-head">
        <span>${escapeHtml(task.sourceDatabase)}.${escapeHtml(task.sourceCollection)} → ${escapeHtml(task.targetDatabase)}.${escapeHtml(task.targetCollection)}</span>
        <span class="status-tag">${task.status}</span>
      </div>
      <div class="bar"><span style="width:${percent}%"></span></div>
      <div class="task-meta">${details.map(escapeHtml).join(' · ')}</div>
      ${task.error ? `<div class="host">${escapeHtml(task.error)}</div>` : ''}`;
    container.append(div);
  }

  renderOverall(job);

  $('#job-log').textContent = job.log.map((entry) => `[${entry.level}] ${entry.at.slice(11, 19)} ${entry.message}`).join('\n');
  $('#job-log').scrollTop = $('#job-log').scrollHeight;
}

function renderOverall(job) {
  const box = $('#job-overall');
  const totals = job.totals || { total: 0, copied: 0, failed: 0, done: 0, tasks: job.tasks.length };
  const total = Math.max(totals.total, totals.copied);
  const percent = total ? Math.min(100, Math.round((totals.copied / total) * 100)) : 0;
  const elapsed = elapsedSeconds(job.startedAt, job.finishedAt, job.serverTime);
  const rate = elapsed > 0 ? totals.copied / elapsed : 0;
  const remaining = Math.max(0, total - totals.copied);

  const details = [
    `${totals.done}/${totals.tasks} collections`,
    `read ${(totals.read || 0).toLocaleString()}`,
    `written ${totals.copied.toLocaleString()} / ~${total.toLocaleString()}`,
    rate > 0 ? `${Math.round(rate).toLocaleString()} docs/s avg` : null,
    job.status === 'running' && rate > 0 && remaining > 0 ? `ETA ${formatDuration(remaining / rate)}` : null,
    `elapsed ${formatDuration(elapsed)}`,
    totals.failed ? `${totals.failed.toLocaleString()} skipped` : null,
    job.status === 'running' ? `last update ${new Date().toLocaleTimeString()}` : null,
  ].filter(Boolean);

  box.hidden = false;
  box.innerHTML = `
    <div class="task-head"><strong>Overall progress</strong><span class="status-tag">${percent}%</span></div>
    <div class="bar"><span style="width:${percent}%"></span></div>
    <div class="task-meta">${details.map(escapeHtml).join(' · ')}</div>`;
}

function elapsedSeconds(startedAt, finishedAt, serverTime) {
  if (!startedAt) return 0;
  const end = finishedAt ? Date.parse(finishedAt) : Date.parse(serverTime || new Date().toISOString());
  return Math.max(0, (end - Date.parse(startedAt)) / 1000);
}

function formatDuration(seconds) {
  const value = Math.round(seconds);
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m ${value % 60}s`;
  return `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.level}|${item.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

loadConnections().catch((err) => toast(err.message, true));

api('/api/health')
  .then((health) => {
    $('#server-info').textContent = `· server v${health.version} (pid ${health.pid}, started ${new Date(health.startedAt).toLocaleTimeString()})`;
  })
  .catch(() => {});
