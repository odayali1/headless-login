const jobs = new Map();
let accounts = [];
let accountStats = { total: 0, available: 0, needs_refresh: 0, failed: 0, softban: 0, mfa_required: 0, other: 0 };
let smartRefreshState = { enabled: true };
let jobStats = { queued: 0, starting: 0, running: 0, success: 0, failed: 0, mfa_required: 0, total: 0 };
let queueState = { busy: false, current: null, waiting: 0, timeoutMin: 10 };
let showFinishedJobs = false;
let renderScheduled = false;
let logModalState = { email: null, target: null, jobId: null };
let groups = [];
let accountFilters = { group: '', health: '', search: '' };

const ACTIVE = new Set(['queued', 'starting', 'running']);

const els = {
  obscuraStatus: document.getElementById('obscuraStatus'),
  proxyToggle: document.getElementById('proxyToggle'),
  proxyLabel: document.getElementById('proxyLabel'),
  singleForm: document.getElementById('singleForm'),
  email: document.getElementById('email'),
  password: document.getElementById('password'),
  target: document.getElementById('target'),
  singleGroup: document.getElementById('singleGroup'),
  loginBtn: document.getElementById('loginBtn'),
  batchInput: document.getElementById('batchInput'),
  batchTarget: document.getElementById('batchTarget'),
  batchGroup: document.getElementById('batchGroup'),
  batchSkipBackupEmail: document.getElementById('batchSkipBackupEmail'),
  batchBtn: document.getElementById('batchBtn'),
  jobsList: document.getElementById('jobsList'),
  queueBanner: document.getElementById('queueBanner'),
  clearBtn: document.getElementById('clearBtn'),
  cancelQueuedBtn: document.getElementById('cancelQueuedBtn'),
  fillTestBatchBtn: document.getElementById('fillTestBatchBtn'),
  accountsBody: document.getElementById('accountsBody'),
  refreshAccountsBtn: document.getElementById('refreshAccountsBtn'),
  groupFilter: document.getElementById('groupFilter'),
  healthFilter: document.getElementById('healthFilter'),
  searchInput: document.getElementById('searchInput'),
  assignGroupInput: document.getElementById('assignGroupInput'),
  assignGroupBtn: document.getElementById('assignGroupBtn'),
  groupRefreshBtn: document.getElementById('groupRefreshBtn'),
  filteredRefreshBtn: document.getElementById('filteredRefreshBtn'),
  filteredReloginBtn: document.getElementById('filteredReloginBtn'),
  groupReloginBtn: document.getElementById('groupReloginBtn'),
  groupSoftbanBtn: document.getElementById('groupSoftbanBtn'),
  groupExportBtn: document.getElementById('groupExportBtn'),
  logModal: document.getElementById('logModal'),
  logModalTitle: document.getElementById('logModalTitle'),
  logModalClose: document.getElementById('logModalClose'),
  logJobSelect: document.getElementById('logJobSelect'),
  logModalMeta: document.getElementById('logModalMeta'),
  logModalBody: document.getElementById('logModalBody'),
  statAvailable: document.getElementById('statAvailable'),
  statNeedsRefresh: document.getElementById('statNeedsRefresh'),
  statFailed: document.getElementById('statFailed'),
  statSoftban: document.getElementById('statSoftban'),
  statMfa: document.getElementById('statMfa'),
  statOther: document.getElementById('statOther'),
  statTotal: document.getElementById('statTotal'),
  smartRefreshToggle: document.getElementById('smartRefreshToggle'),
  smartRefreshLabel: document.getElementById('smartRefreshLabel'),
  exportTokensBtn: document.getElementById('exportTokensBtn'),
  exportFailedRefreshBtn: document.getElementById('exportFailedRefreshBtn'),
  importApiKey: document.getElementById('importApiKey'),
  importZipFile: document.getElementById('importZipFile'),
  importDataBtn: document.getElementById('importDataBtn'),
  importStatus: document.getElementById('importStatus'),
};

let proxyState = { enabled: true };

function renderAccountStats() {
  const s = accountStats;
  const other =
    s.other ??
    Math.max(0, (s.total || 0) - (s.available || 0) - (s.needs_refresh || 0) - (s.failed || 0) - (s.softban || 0) - (s.mfa_required || 0));
  if (els.statAvailable) els.statAvailable.textContent = s.available ?? 0;
  if (els.statNeedsRefresh) els.statNeedsRefresh.textContent = s.needs_refresh ?? 0;
  if (els.statFailed) els.statFailed.textContent = s.failed ?? 0;
  if (els.statSoftban) els.statSoftban.textContent = s.softban ?? 0;
  if (els.statMfa) els.statMfa.textContent = s.mfa_required ?? 0;
  if (els.statOther) els.statOther.textContent = other;
  if (els.statTotal) els.statTotal.textContent = s.total ?? 0;
}

function renderSmartRefreshPill() {
  if (!els.smartRefreshToggle) return;
  const on = smartRefreshState.enabled;
  els.smartRefreshToggle.className = `status-pill smart-refresh-pill ${on ? 'online' : 'offline'}`;
  els.smartRefreshLabel.textContent = on ? 'Smart refresh ON' : 'Smart refresh OFF';
}

function renderGroupFilter() {
  if (!els.groupFilter) return;
  const current = accountFilters.group || '';
  const opts = ['<option value="">All groups</option>'].concat(
    groups.map((g) => `<option value="${escapeHtml(g.group_name)}">${escapeHtml(g.group_name)} (${g.count})</option>`)
  );
  els.groupFilter.innerHTML = opts.join('');
  els.groupFilter.value = current;
}

async function loadGroups() {
  const res = await fetch('/api/groups');
  groups = await res.json();
  renderGroupFilter();
}

function syncGroupsFromAccounts(list) {
  const counts = new Map();
  for (const acc of list || []) {
    const g = String(acc.group || '').trim();
    if (!g) continue;
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  groups = [...counts.entries()].map(([group_name, count]) => ({ group_name, count })).sort((a, b) =>
    a.group_name.localeCompare(b.group_name)
  );
  renderGroupFilter();
}

async function loadSmartRefresh() {
  const res = await fetch('/api/smart-refresh');
  smartRefreshState = await res.json();
  renderSmartRefreshPill();
}

els.smartRefreshToggle?.addEventListener('click', async () => {
  const res = await fetch('/api/smart-refresh/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: !smartRefreshState.enabled }),
  });
  smartRefreshState = await res.json();
  renderSmartRefreshPill();
});

function downloadExport(type) {
  const group = accountFilters.group ? `?group=${encodeURIComponent(accountFilters.group)}` : '';
  window.location.href = `/api/accounts/export/${type}${group}`;
}

els.exportTokensBtn?.addEventListener('click', () => downloadExport('tokens'));
els.exportFailedRefreshBtn?.addEventListener('click', () => downloadExport('failed-refresh'));

if (els.importApiKey) {
  const savedKey = sessionStorage.getItem('importApiKey');
  if (savedKey) els.importApiKey.value = savedKey;
}

els.importDataBtn?.addEventListener('click', async () => {
  const file = els.importZipFile?.files?.[0];
  const key = els.importApiKey?.value?.trim();
  if (!file) {
    alert('Choose data-backup.zip first.');
    return;
  }
  if (!key) {
    alert('Enter your API key (same as API_KEY in server env).');
    return;
  }
  if (!confirm('This overwrites /app/data with the zip contents and restarts the server. Continue?')) return;

  els.importDataBtn.disabled = true;
  els.importStatus.textContent = 'Uploading…';

  try {
    const buf = await file.arrayBuffer();
    const res = await fetch('/api/data/import', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/zip',
      },
      body: buf,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Import failed (${res.status})`);

    sessionStorage.setItem('importApiKey', key);
    els.importStatus.textContent = `Restored ${data.profileCount} profiles, ${data.accountCount} DB accounts. Restarting…`;
    setTimeout(() => location.reload(), 5000);
  } catch (err) {
    els.importStatus.textContent = err.message;
    els.importDataBtn.disabled = false;
  }
});

function renderProxyPill() {
  if (!els.proxyToggle) return;
  const on = proxyState.enabled;
  els.proxyToggle.className = `status-pill proxy-pill ${on ? 'online' : 'offline'}`;
  const ipInfo = on && proxyState.host
    ? `${proxyState.host}:${proxyState.port} · ${proxyState.accountsOnCurrentIp}/${proxyState.rotateAfter} on IP`
    : on ? 'Proxy ON' : 'Proxy OFF (direct — not recommended)';
  els.proxyLabel.textContent = ipInfo;
}

async function loadProxy() {
  const res = await fetch('/api/proxy');
  proxyState = await res.json();
  renderProxyPill();
}

els.proxyToggle?.addEventListener('click', async () => {
  const next = !proxyState.enabled;
  if (!next && !confirm('Turn proxy OFF? Traffic may use VPS IP (not recommended).')) return;
  const res = await fetch('/api/proxy/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: next }),
  });
  proxyState = await res.json();
  renderProxyPill();
});

function accountApiPath(email, target, action) {
  const enc = encodeURIComponent(email);
  return `/api/accounts/${enc}/${target}${action ? `/${action}` : ''}`;
}

async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    if (data.proxy) proxyState = { ...proxyState, ...data.proxy };
    renderProxyPill();
    const online = data.camoufox;
    els.obscuraStatus.className = `status-pill ${online ? 'online' : 'offline'}`;
    els.obscuraStatus.querySelector('span:last-child').textContent = online
      ? 'Camoufox ready'
      : 'Run npm run camoufox:fetch';
  } catch {
    els.obscuraStatus.className = 'status-pill offline';
    els.obscuraStatus.querySelector('span:last-child').textContent = 'Server unreachable';
  }
}

function parseBatch(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const sep = line.includes(':') ? ':' : line.includes(',') ? ',' : null;
      if (!sep) return null;
      const idx = line.indexOf(sep);
      return {
        email: line.slice(0, idx).trim(),
        password: line.slice(idx + 1).trim(),
      };
    })
    .filter((a) => a?.email && a?.password);
}

function mergeJob(job) {
  const existing = jobs.get(job.id) || {};
  if (ACTIVE.has(job.status)) {
    jobs.set(job.id, {
      ...existing,
      ...job,
      logs: job.logs?.length ? job.logs : existing.logs || [],
    });
  } else {
    jobs.set(job.id, { ...existing, ...job });
  }
}

function scheduleRenderJobs() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderJobs();
  });
}

function getBatchProgress() {
  const list = [...jobs.values()].filter((j) => j.batchId);
  if (!list.length) return null;

  const batchIds = [...new Set(list.map((j) => j.batchId))];
  const activeBatchId =
    list.find((j) => ACTIVE.has(j.status))?.batchId ||
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.batchId;
  const batchId = activeBatchId || batchIds[0];
  const inBatch = list.filter((j) => j.batchId === batchId);

  return {
    batchId,
    total: inBatch.length,
    done: inBatch.filter((j) => j.status === 'success').length,
    failed: inBatch.filter((j) => j.status === 'failed' || j.status === 'mfa_required' || j.status === 'backup_email_required').length,
    queued: inBatch.filter((j) => j.status === 'queued').length,
    running: inBatch.find((j) => j.status === 'running' || j.status === 'starting') || null,
  };
}

function renderQueueBanner() {
  if (!els.queueBanner) return;

  const batch = getBatchProgress();
  const active = (jobStats.running || 0) + (jobStats.starting || 0) + (jobStats.queued || 0);
  const currentLabel = queueState.current?.label?.replace(/ batch$/, '') || '';

  if (batch) {
    const pct = batch.total ? Math.min(100, Math.round((batch.done / batch.total) * 100)) : 0;
    const runningEmail = batch.running?.email || currentLabel || '—';
    const stateClass = queueState.busy ? 'busy' : active > 0 ? 'waiting' : 'done';
    const statusLine = queueState.busy
      ? `Processing <strong>${escapeHtml(runningEmail)}</strong>`
      : batch.queued > 0
        ? '<span class="queue-warn">Queue paused — waiting to resume</span>'
        : '<strong>Batch finished</strong> — check Session only accounts for Re-login';

    els.queueBanner.innerHTML = `
      <div class="queue-banner ${stateClass}">
        <div class="queue-banner-head">
          <span class="queue-banner-title">Batch</span>
          <span class="queue-banner-pct">${batch.done} / ${batch.total} complete · ${pct}%</span>
        </div>
        <div class="progress-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
          <div class="progress-fill" style="width:${pct}%"></div>
        </div>
        <div class="queue-banner-detail">${statusLine}
          ${batch.failed ? ` · <span class="queue-err">${batch.failed} failed</span>` : ''}
          ${batch.queued ? ` · ${batch.queued} in queue` : ''}
        </div>
      </div>`;
    return;
  }

  if (queueState.busy && currentLabel) {
    els.queueBanner.innerHTML = `
      <div class="queue-banner busy">
        <div class="queue-banner-head"><span class="queue-banner-title">Queue active</span></div>
        <div class="queue-banner-detail">Processing <strong>${escapeHtml(currentLabel)}</strong></div>
      </div>`;
    return;
  }

  if (active > 0) {
    els.queueBanner.innerHTML = `
      <div class="queue-banner waiting">
        <div class="queue-banner-detail"><span class="queue-warn">Queue idle</span> — ${active} job(s) waiting. Try Cancel queued or refresh the page.</div>
      </div>`;
    return;
  }

  els.queueBanner.innerHTML = `
    <div class="queue-banner idle">
      <div class="queue-banner-detail muted">Queue idle — no logins running</div>
    </div>`;
}

function renderJobsStatsBar() {
  const active = jobStats.running + jobStats.starting + jobStats.queued;
  const processing = queueState.busy && queueState.current?.label
    ? `<span class="stat-pill warn-stat" title="Currently running on the login queue">Now: <strong>${escapeHtml(queueState.current.label)}</strong></span>`
    : '';
  const stuckHint = !queueState.busy && active > 0
    ? `<span class="stat-pill warn-stat" title="Jobs are queued but nothing is processing — try Cancel queued or restart the server">Queue idle</span>`
    : '';
  return `
    <div class="jobs-stats">
      <span class="stat-pill active-stat" title="Queued + running">Active <strong>${active}</strong></span>
      ${processing}
      ${stuckHint}
      <span class="stat-pill success-stat">Success <strong>${jobStats.success}</strong></span>
      <span class="stat-pill failed-stat">Failed <strong>${jobStats.failed}</strong></span>
      ${jobStats.mfa_required ? `<span class="stat-pill warn-stat">MFA <strong>${jobStats.mfa_required}</strong></span>` : ''}
      ${jobStats.cancelled ? `<span class="stat-pill muted-stat">Cancelled <strong>${jobStats.cancelled}</strong></span>` : ''}
      <span class="stat-pill muted-stat">Tracked <strong>${jobStats.total}</strong></span>
    </div>
  `;
}

function renderJobCard(job, showLogs) {
  const logs = showLogs && job.logs?.length
    ? job.logs.map((l) => `<div>[${escapeHtml(l.step)}] ${escapeHtml(l.message)}</div>`).join('')
    : job.lastLog
      ? `<div class="job-logs-compact">[${escapeHtml(job.lastLog.step)}] ${escapeHtml(job.lastLog.message)}</div>`
      : job.logCount
        ? `<div class="job-logs-compact muted">${job.logCount} log line(s) — open account Log to view</div>`
        : '';

  const screenshot = job.result?.screenshot
    ? `<div class="job-screenshot"><img src="/${job.result.screenshot}" alt="Screenshot" loading="lazy" /></div>`
    : '';

  const extra = job.result?.profileFile
    ? `<div class="job-meta">Profile: ${escapeHtml(job.result.profileFile)} · ${job.result.cookieCount} cookies${job.result.hasToken ? ' · token captured' : ''}${job.result.reusedProfile ? ' · reused' : ''}</div>`
    : '';

  return `
    <article class="job ${showLogs ? 'job-active' : 'job-compact'}" data-id="${job.id}">
      <div class="job-header">
        <div>
          <div class="job-email">${escapeHtml(job.email)}</div>
          <div class="job-meta">${escapeHtml(job.target)} · ${escapeHtml(job.engine || 'camoufox')} · ${formatTime(job.createdAt)}</div>
        </div>
        <span class="badge ${job.status}">${job.status.replace('_', ' ')}</span>
      </div>
      <div class="job-message">${escapeHtml(job.message || '')}</div>
      ${extra}
      ${logs ? `<div class="job-logs">${logs}</div>` : ''}
      ${screenshot}
    </article>
  `;
}

function renderJobs() {
  renderQueueBanner();

  const list = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = list.filter((j) => ACTIVE.has(j.status));
  const finished = list.filter((j) => !ACTIVE.has(j.status));
  const recentFinished = finished.slice(0, 20);
  const runningNow = active.filter((j) => j.status === 'running' || j.status === 'starting');
  const queuedOnly = active.filter((j) => j.status === 'queued');

  if (list.length === 0 && jobStats.total === 0) {
    els.jobsList.innerHTML = `${renderJobsStatsBar()}<p class="empty">No jobs yet. Submit credentials above to start.</p>`;
    return;
  }

  let html = renderJobsStatsBar();

  if (runningNow.length) {
    html += '<div class="jobs-section-label">Running now</div>';
    html += runningNow.map((j) => renderJobCard(j, true)).join('');
  }

  if (queuedOnly.length) {
    html += `<div class="queue-compact"><div class="jobs-section-label">Waiting <span class="muted">(${queuedOnly.length})</span></div>`;
    const show = queuedOnly.slice(0, 8);
    html += '<ul class="queue-wait-list">';
    html += show.map((j) => `<li><span class="badge queued">queued</span> ${escapeHtml(j.email)}</li>`).join('');
    html += '</ul>';
    if (queuedOnly.length > 8) {
      html += `<p class="hint">${queuedOnly.length - 8} more in queue — use account <strong>Log</strong> for details.</p>`;
    }
    html += '</div>';
  }

  if (finished.length) {
    const show = showFinishedJobs || finished.length <= 3;
    if (show) {
      html += `<div class="jobs-section-label">Recent finished <span class="muted">(${finished.length})</span></div>`;
      html += (showFinishedJobs ? recentFinished : finished.slice(0, 3))
        .map((j) => renderJobCard(j, false))
        .join('');
    }
    if (finished.length > 3 && !showFinishedJobs) {
      html += `<button type="button" class="btn ghost show-finished-btn" id="showFinishedBtn">Show last ${Math.min(20, finished.length)} finished (${finished.length} total)</button>`;
    } else if (finished.length > 20 && showFinishedJobs) {
      html += `<p class="hint">Showing 20 of ${finished.length} finished jobs. Older runs cleared automatically on server.</p>`;
    }
  }

  els.jobsList.innerHTML = html;
  document.getElementById('showFinishedBtn')?.addEventListener('click', () => {
    showFinishedJobs = true;
    renderJobs();
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function renderAccounts() {
  const filtered = accounts.filter((acc) => {
    if (accountFilters.group && (acc.group || '') !== accountFilters.group) return false;
    if (accountFilters.health && (acc.health || '') !== accountFilters.health) return false;
    if (accountFilters.search && !String(acc.email || '').toLowerCase().includes(accountFilters.search.toLowerCase())) return false;
    return true;
  });

  if (!filtered.length) {
    els.accountsBody.innerHTML = '<tr><td colspan="10" class="empty">No accounts match current filters.</td></tr>';
    return;
  }

  els.accountsBody.innerHTML = filtered
    .map((acc) => {
      const tokenPreview = acc.accessToken
        ? `${acc.accessToken.slice(0, 24)}…`
        : '—';
      const copyBtn = acc.accessToken
        ? `<button type="button" class="btn small copy" data-account-id="${escapeHtml(acc.id)}">Copy</button>`
        : '';
      const refreshBtn = `<button type="button" class="btn small refresh" data-action="refresh" data-email="${escapeHtml(acc.email)}" data-target="${escapeHtml(acc.target)}">Refresh token</button>`;
      const reloginBtn = `<button type="button" class="btn small relogin" data-action="relogin" data-email="${escapeHtml(acc.email)}" data-target="${escapeHtml(acc.target)}">Re-login</button>`;
      const logBtn = `<button type="button" class="btn small logview" data-action="log" data-email="${escapeHtml(acc.email)}" data-target="${escapeHtml(acc.target)}">Log</button>`;
      const deleteBtn = `<button type="button" class="btn small delete" data-action="delete" data-email="${escapeHtml(acc.email)}" data-target="${escapeHtml(acc.target)}">Delete</button>`;
      const checkSoftbanBtn = `<button type="button" class="btn small softban-check" data-action="check-softban" data-email="${escapeHtml(acc.email)}" data-target="${escapeHtml(acc.target)}">Check</button>`;
      const softbanBadge = `<span class="badge softban_${escapeHtml(acc.softbanStatus || 'unchecked')}" title="${escapeHtml(acc.softbanMessage || '')}">${escapeHtml(acc.softbanLabel || 'Not checked')}</span>`;
      return `
        <tr>
          <td>${escapeHtml(acc.email)}</td>
          <td><code class="scope-tag">${escapeHtml(acc.group || '—')}</code></td>
          <td>${escapeHtml(acc.target)}</td>
          <td><span class="badge health_${escapeHtml(acc.health || acc.status)}">${escapeHtml(acc.healthLabel || acc.statusLabel)}</span></td>
          <td>${softbanBadge}</td>
          <td>${formatTime(acc.lastLoginAt)}</td>
          <td>${formatTime(acc.tokenExpiresAt)}</td>
          <td><code class="scope-tag">${escapeHtml(acc.tokenScope || '—')}</code></td>
          <td>
            <div class="token-cell">
              <span class="token-preview" title="${acc.accessToken ? 'Token saved' : 'No token'}">${escapeHtml(tokenPreview)}</span>
              ${copyBtn}
            </div>
          </td>
          <td>
            <div class="account-actions">
              ${checkSoftbanBtn}
              ${logBtn}
              ${refreshBtn}
              ${reloginBtn}
              ${deleteBtn}
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

async function loadAccounts() {
  const res = await fetch('/api/accounts');
  accounts = await res.json();
  syncGroupsFromAccounts(accounts);
  renderAccounts();
  const statsRes = await fetch('/api/accounts/stats');
  accountStats = await statsRes.json();
  renderAccountStats();
}

async function openAccountLog(email, target) {
  logModalState = { email, target, jobId: null };
  els.logModalTitle.textContent = `Log — ${email}`;
  els.logModal.hidden = false;

  const res = await fetch(accountApiPath(email, target, 'jobs'));
  const jobList = await res.json();

  if (!jobList.length) {
    els.logJobSelect.innerHTML = '<option value="">No jobs yet</option>';
    els.logModalMeta.textContent = '';
    els.logModalBody.innerHTML = '<p class="empty">No login jobs for this account yet.</p>';
    return;
  }

  els.logJobSelect.innerHTML = jobList
    .map((j) => {
      const label = `${formatTime(j.createdAt)} · ${j.status} — ${j.message || ''}`.slice(0, 80);
      return `<option value="${j.id}">${escapeHtml(label)}</option>`;
    })
    .join('');

  logModalState.jobId = jobList[0].id;
  els.logJobSelect.value = jobList[0].id;
  await loadJobLogIntoModal(jobList[0].id);
}

async function loadJobLogIntoModal(jobId) {
  logModalState.jobId = jobId;
  els.logModalBody.innerHTML = '<p class="empty">Loading log…</p>';

  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (!res.ok) {
    els.logModalBody.innerHTML = '<p class="empty">Could not load job.</p>';
    return;
  }

  const job = await res.json();
  mergeJob(job);

  els.logModalMeta.innerHTML = `
    <span class="badge ${job.status}">${escapeHtml(job.status)}</span>
    <span class="muted">${escapeHtml(job.target)} · ${formatTime(job.createdAt)}</span>
    ${job.logCount ? `<span class="muted"> · ${job.logCount} lines</span>` : ''}
  `;

  const lines = (job.logs || [])
    .map((l) => `<div><span class="log-time">${formatTime(l.at)}</span> [${escapeHtml(l.step)}] ${escapeHtml(l.message)}</div>`)
    .join('');

  const screenshot = job.result?.screenshot
    ? `<div class="job-screenshot"><img src="/${job.result.screenshot}" alt="Screenshot" loading="lazy" /></div>`
    : '';

  els.logModalBody.innerHTML = `
    <div class="job-message">${escapeHtml(job.message || '')}</div>
    <div class="log-modal-lines">${lines || '<p class="empty">No log lines.</p>'}</div>
    ${screenshot}
  `;
  els.logModalBody.scrollTop = els.logModalBody.scrollHeight;
}

function closeLogModal() {
  els.logModal.hidden = true;
  logModalState = { email: null, target: null, jobId: null };
}

els.logModalClose?.addEventListener('click', closeLogModal);
els.logModal?.addEventListener('click', (e) => {
  if (e.target === els.logModal) closeLogModal();
});
els.logJobSelect?.addEventListener('change', () => {
  if (els.logJobSelect.value) loadJobLogIntoModal(els.logJobSelect.value);
});

els.accountsBody.addEventListener('click', async (e) => {
  const copyBtn = e.target.closest('[data-account-id]');
  if (copyBtn) {
    const acc = accounts.find((a) => a.id === copyBtn.dataset.accountId);
    if (!acc?.accessToken) return alert('No token for this account.');
    try {
      await navigator.clipboard.writeText(acc.accessToken);
      const prev = copyBtn.textContent;
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = prev; }, 1500);
    } catch (err) {
      alert(err.message);
    }
    return;
  }

  const actionBtn = e.target.closest('[data-action]');
  if (!actionBtn) return;

  const { action, email, target } = actionBtn.dataset;

  if (action === 'log') {
    openAccountLog(email, target);
    return;
  }

  if (action === 'delete') {
    if (!confirm(`Delete ${email}?\n\nRemoves saved profile, credentials, session, and cancels any queued login for this account.`)) return;
    actionBtn.disabled = true;
    try {
      const res = await fetch(accountApiPath(email, target), { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      for (const [id, job] of jobs) {
        if (job.email === email && job.target === target && job.status === 'queued') {
          jobs.set(id, { ...job, status: 'cancelled', message: 'Cancelled' });
        }
      }
      scheduleRenderJobs();
      await loadAccounts();
    } catch (err) {
      alert(err.message);
    } finally {
      actionBtn.disabled = false;
    }
    return;
  }

  if (action === 'check-softban') {
    actionBtn.disabled = true;
    const prev = actionBtn.textContent;
    actionBtn.textContent = '…';
    try {
      const res = await fetch(accountApiPath(email, target, 'check-softban'), { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Check failed');
      await loadAccounts();
      if (data.status === 'softban') {
        alert(`${email}: SOFTBAN detected\n${data.message}`);
      } else if (data.status === 'clean') {
        alert(`${email}: OK — not softbanned`);
      } else {
        alert(`${email}: ${data.message || data.status}`);
      }
    } catch (err) {
      alert(err.message);
    } finally {
      actionBtn.textContent = prev;
      actionBtn.disabled = false;
    }
    return;
  }

  if (action === 'refresh') {
    actionBtn.disabled = true;
    try {
      const res = await fetch(accountApiPath(email, target, 'refresh-token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine: 'auto' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Refresh failed');
    } catch (err) {
      alert(err.message);
    } finally {
      actionBtn.disabled = false;
    }
    return;
  }

  if (action === 'relogin') {
    const acc = accounts.find((a) => a.email === email && a.target === target);
    if (!acc?.hasStoredPassword) {
      return alert('No saved password for this account. Log in once from the form above.');
    }
    if (!confirm(`Re-login ${email} using saved password?`)) return;
    actionBtn.disabled = true;
    try {
      const res = await fetch(accountApiPath(email, target, 'relogin'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engine: 'auto',
          skipBackupEmail: els.batchSkipBackupEmail?.checked !== false,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Re-login failed');
    } catch (err) {
      alert(err.message);
    } finally {
      actionBtn.disabled = false;
    }
  }
});

els.refreshAccountsBtn.addEventListener('click', () => loadAccounts());

function currentFilteredAccounts() {
  const NEEDS_TOKEN = new Set(['session_only', 'needs_refresh', 'failed']);
  return accounts.filter((acc) => {
    if (accountFilters.group && (acc.group || '') !== accountFilters.group) return false;
    if (accountFilters.health === 'needs_token') {
      if (!NEEDS_TOKEN.has(acc.health || '')) return false;
    } else if (accountFilters.health && (acc.health || '') !== accountFilters.health) return false;
    if (accountFilters.search && !String(acc.email || '').toLowerCase().includes(accountFilters.search.toLowerCase())) return false;
    return true;
  });
}

els.groupFilter?.addEventListener('change', () => {
  accountFilters.group = els.groupFilter.value || '';
  renderAccounts();
});
els.healthFilter?.addEventListener('change', () => {
  accountFilters.health = els.healthFilter.value || '';
  renderAccounts();
});
els.searchInput?.addEventListener('input', () => {
  accountFilters.search = els.searchInput.value || '';
  renderAccounts();
});

els.assignGroupBtn?.addEventListener('click', async () => {
  const group = String(els.assignGroupInput?.value || '').trim();
  const selected = currentFilteredAccounts();
  if (!selected.length) return alert('No accounts in current filter.');
  const payload = {
    group,
    accounts: selected.map((a) => ({ email: a.email, target: a.target })),
  };
  const res = await fetch('/api/groups/assign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error || 'Assign group failed');
  await loadAccounts();
});

async function runGroupAction(action) {
  const group = accountFilters.group || String(els.assignGroupInput?.value || '').trim();
  if (!group) return alert('Pick a group from filter or type a group name first.');
  const res = await fetch(`/api/groups/${encodeURIComponent(group)}/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error || 'Group action failed');
  await loadAccounts();
}

async function runFilteredAction(action) {
  const selected = currentFilteredAccounts();
  if (!selected.length) return alert('No accounts match the current filter.');
  const withPassword = selected.filter((a) => a.hasStoredPassword);
  if (action === 'relogin' && withPassword.length === 0) {
    return alert('No filtered accounts have a stored password. Re-login needs the password saved in the database.');
  }
  const count = action === 'relogin' ? withPassword.length : selected.length;
  const verb = action === 'relogin' ? 'Re-login' : 'Refresh token for';
  if (!confirm(`${verb} ${count} account(s) matching the current filter?`)) return;
  const list = (action === 'relogin' ? withPassword : selected).map((a) => ({ email: a.email, target: a.target }));
  const res = await fetch('/api/accounts/bulk-action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action,
      accounts: list,
      skipBackupEmail: els.batchSkipBackupEmail?.checked !== false,
    }),
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error || 'Bulk action failed');
  await loadAccounts();
}

els.filteredRefreshBtn?.addEventListener('click', () => runFilteredAction('refresh'));
els.filteredReloginBtn?.addEventListener('click', () => runFilteredAction('relogin'));
els.groupRefreshBtn?.addEventListener('click', () => runGroupAction('refresh'));
els.groupReloginBtn?.addEventListener('click', () => runGroupAction('relogin'));
els.groupSoftbanBtn?.addEventListener('click', () => runGroupAction('check-softban'));
els.groupExportBtn?.addEventListener('click', () => {
  const group = accountFilters.group || String(els.assignGroupInput?.value || '').trim();
  if (!group) return alert('Pick or type a group first.');
  window.location.href = `/api/accounts/export/tokens?group=${encodeURIComponent(group)}`;
});

els.singleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.loginBtn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: els.email.value,
        password: els.password.value,
        target: els.target.value,
        group: els.singleGroup?.value || '',
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    els.password.value = '';
  } catch (err) {
    alert(err.message);
  } finally {
    els.loginBtn.disabled = false;
  }
});

els.batchBtn.addEventListener('click', async () => {
  const batchAccounts = parseBatch(els.batchInput.value);
  if (batchAccounts.length === 0) {
    alert('No valid accounts found. Use email:password per line.');
    return;
  }
  if (batchAccounts.length > 50 && !confirm(`Start batch login for ${batchAccounts.length} accounts? They run one at a time.`)) {
    return;
  }
  els.batchBtn.disabled = true;
  try {
    const res = await fetch('/api/login/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accounts: batchAccounts,
        target: els.batchTarget.value,
        group: els.batchGroup?.value || '',
        skipBackupEmail: els.batchSkipBackupEmail?.checked !== false,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Batch failed');
    els.batchInput.value = '';
    showFinishedJobs = false;
  } catch (err) {
    alert(err.message);
  } finally {
    els.batchBtn.disabled = false;
  }
});

els.fillTestBatchBtn?.addEventListener('click', () => {
  const lines = Array.from({ length: 5 }, (_, i) => {
    const n = i + 1;
    return `bulktest${n}@outlook.com:ChangeMe${n}!`;
  });
  els.batchInput.value = lines.join('\n');
  els.batchInput.focus();
});

els.cancelQueuedBtn?.addEventListener('click', async () => {
  const queued = jobStats.queued || 0;
  if (!queued) return alert('No queued jobs to cancel.');
  if (!confirm(`Cancel ${queued} queued job(s)? Running job will finish; the rest will be skipped.`)) return;
  try {
    const res = await fetch('/api/jobs/cancel-queued', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await res.json();
    if (data.stats) jobStats = data.stats;
    for (const [id, job] of jobs) {
      if (job.status === 'queued') {
        jobs.set(id, { ...job, status: 'cancelled', message: 'Cancelled' });
      }
    }
    renderJobs();
  } catch (err) {
    alert(err.message);
  }
});

els.clearBtn.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/jobs/clear-finished', { method: 'POST' });
    const data = await res.json();
    if (data.stats) jobStats = data.stats;
    for (const [id, job] of jobs) {
      if (!ACTIVE.has(job.status) && job.status !== 'cancelled') jobs.delete(id);
    }
    for (const [id, job] of jobs) {
      if (job.status === 'cancelled') jobs.delete(id);
    }
    showFinishedJobs = false;
    renderJobs();
  } catch {
    for (const [id, job] of jobs) {
      if (!ACTIVE.has(job.status) && job.status !== 'cancelled') jobs.delete(id);
    }
    for (const [id, job] of jobs) {
      if (job.status === 'cancelled') jobs.delete(id);
    }
    renderJobs();
  }
});

function onJobLog(payload) {
  const job = jobs.get(payload.id);
  if (!job) return;
  if (!job.logs) job.logs = [];
  job.logs.push({ step: payload.step, message: payload.message, at: payload.at });
  if (job.logs.length > 200) job.logs.shift();
  job.logCount = payload.logCount;
  job.message = payload.message;

  if (logModalState.jobId === payload.id && !els.logModal.hidden) {
    const line = document.createElement('div');
    line.innerHTML = `<span class="log-time">${formatTime(payload.at)}</span> [${escapeHtml(payload.step)}] ${escapeHtml(payload.message)}`;
    const container = els.logModalBody.querySelector('.log-modal-lines');
    if (container) {
      container.appendChild(line);
      els.logModalBody.scrollTop = els.logModalBody.scrollHeight;
    }
  }

  scheduleRenderJobs();
}

function connectSSE() {
  const es = new EventSource('/api/events');

  es.addEventListener('connected', (e) => {
    const data = JSON.parse(e.data);
    for (const job of data.jobs || []) mergeJob(job);
    if (data.jobStats) jobStats = data.jobStats;
    if (data.queue) queueState = data.queue;
    if (data.accounts) {
      accounts = data.accounts;
      syncGroupsFromAccounts(accounts);
      renderAccounts();
    }
    if (data.accountStats) {
      accountStats = data.accountStats;
      renderAccountStats();
    }
    if (data.smartRefresh) {
      smartRefreshState = data.smartRefresh;
      renderSmartRefreshPill();
    }
    if (data.proxy) {
      proxyState = data.proxy;
      renderProxyPill();
    }
    renderJobs();
  });

  es.addEventListener('batch', (e) => {
    const data = JSON.parse(e.data);
    for (const job of data.jobs || []) mergeJob(job);
    scheduleRenderJobs();
  });

  es.addEventListener('job-stats', (e) => {
    jobStats = JSON.parse(e.data);
    scheduleRenderJobs();
  });

  es.addEventListener('queue-status', (e) => {
    queueState = JSON.parse(e.data);
    scheduleRenderJobs();
  });

  es.addEventListener('proxy', (e) => {
    proxyState = JSON.parse(e.data);
    renderProxyPill();
  });

  es.addEventListener('job', (e) => {
    const job = JSON.parse(e.data);
    mergeJob(job);
    scheduleRenderJobs();
    checkHealth();
    if (job.status === 'success' || job.status === 'failed') loadAccounts();
  });

  es.addEventListener('job-log', (e) => {
    onJobLog(JSON.parse(e.data));
  });

  es.addEventListener('accounts', (e) => {
    accounts = JSON.parse(e.data);
    syncGroupsFromAccounts(accounts);
    renderAccounts();
  });

  es.addEventListener('account-stats', (e) => {
    accountStats = JSON.parse(e.data);
    renderAccountStats();
  });

  es.onerror = () => {
    es.close();
    setTimeout(connectSSE, 3000);
  };
}

checkHealth();
loadProxy();
loadSmartRefresh();
setInterval(checkHealth, 15_000);
connectSSE();

fetch('/api/jobs?limit=100')
  .then((r) => r.json())
  .then((data) => {
    if (Array.isArray(data)) {
      for (const job of data) mergeJob(job);
    } else {
      if (data.stats) jobStats = data.stats;
      for (const job of data.jobs || []) mergeJob(job);
    }
    renderJobs();
  });

loadAccounts();
