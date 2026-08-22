const $ = (id) => document.getElementById(id);

const filters = {
  page: 1,
  limit: 50,
  q: '',
  group: '',
  status: 'not_signed_up',
};

let lastReload = 0;
const jobsById = new Map();
let seenLogKeys = new Set();

function jobLine(job) {
  const last = job.lastLog || (job.logs && job.logs[job.logs.length - 1]);
  return last
    ? `[${job.email}] ${last.step}: ${last.message}`
    : `[${job.email}] ${job.status}: ${job.message}`;
}

function ingestJob(job) {
  if (!job?.id) return;
  const prev = jobsById.get(job.id);
  jobsById.set(job.id, { ...prev, ...job, logs: job.logs || prev?.logs || [] });
  const lines = job.logs?.length
    ? job.logs.map((l) => `[${job.email}] ${l.step}: ${l.message}`)
    : [jobLine(job)];
  for (const line of lines) {
    if (seenLogKeys.has(line)) continue;
    seenLogKeys.add(line);
    appendLog(line);
  }
  if (seenLogKeys.size > 800) seenLogKeys = new Set([...seenLogKeys].slice(-400));
  renderJobs();
}

function renderJobs() {
  const box = $('jobsList');
  if (!box) return;
  const list = [...jobsById.values()].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  if (!list.length) {
    box.innerHTML = '<p class="empty">No Truecaller jobs yet. Queue signups above — this list is independent of Outlook smart-refresh.</p>';
    return;
  }
  box.innerHTML = list
    .slice(0, 30)
    .map((j) => {
      const last = j.lastLog || (j.logs && j.logs[j.logs.length - 1]);
      const detail = last ? `${last.step}: ${last.message}` : j.message || '';
      return `<div class="job-card">
        <div class="job-head">
          <span class="badge ${escapeHtml(j.status)}">${escapeHtml(j.status)}</span>
          <span class="mono">${escapeHtml(j.email)}</span>
        </div>
        <p class="hint">${escapeHtml(detail)}</p>
      </div>`;
    })
    .join('');
}

async function loadJobs() {
  const data = await api('/jobs');
  renderQueue(data.queue);
  for (const job of data.jobs || []) ingestJob(job);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function api(path, opts = {}) {
  const res = await fetch(`/api/truecaller${path}`, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
  return data;
}

function tcBadge(row) {
  const status = row?.tcStatus || (row?.truecaller ? null : 'not_signed_up');
  if (status === 'signed_up' || (row?.truecaller?.hasToken && !row?.truecaller?.expired)) {
    return '<span class="badge health_available">signed up</span>';
  }
  if (status === 'expired' || row?.truecaller?.expired) {
    return '<span class="badge health_token_expired">token expired</span>';
  }
  if (status === 'failed' || row?.truecaller?.status === 'failed') {
    return `<span class="badge health_failed">failed</span>`;
  }
  if (status === 'signing_up') return '<span class="badge health_needs_refresh">signing up</span>';
  return '<span class="badge health_not_logged_in">not signed up</span>';
}

function appendLog(line) {
  const box = $('jobLog');
  const prev = box.textContent === 'Waiting…' ? '' : box.textContent;
  const next = `${prev}${prev ? '\n' : ''}${line}`;
  const lines = next.split('\n');
  box.textContent = lines.slice(-250).join('\n');
  box.scrollTop = box.scrollHeight;
}

function renderQueue(q) {
  const wrap = $('queueBanner');
  if (!q || (!q.total && !q.running && !q.queued)) {
    wrap.innerHTML = '';
    return;
  }
  const done = q.success + q.failed;
  const pct = q.total ? Math.round((done / q.total) * 100) : 0;
  const cls = q.paused ? 'waiting' : q.done ? 'done' : q.running || q.queued ? 'busy' : '';
  wrap.innerHTML = `<div class="queue-banner ${cls}">
    <div class="queue-banner-head">
      <span class="queue-banner-title">${q.paused ? 'Paused' : q.done ? 'Batch finished' : 'Truecaller queue'}</span>
      <span class="queue-banner-pct">${pct}%</span>
    </div>
    <div class="queue-banner-detail">${q.kind || 'signup'} · parallel ${q.parallel} · ${done}/${q.total} finished · ${q.queued} waiting · ${q.running} running</div>
    <div class="batch-summary-stats">
      <span class="batch-stat ok">${q.success} ok</span>
      <span class="batch-stat err">${q.failed} failed</span>
      <span class="batch-stat pending">${q.queued} queued</span>
      <span class="batch-stat muted">${q.running} running</span>
    </div>
  </div>`;
}

function renderStats(stats) {
  if (!stats) return;
  $('statEligible').textContent = stats.eligible ?? 0;
  $('statNotSigned').textContent = stats.not_signed_up ?? 0;
  $('statSigned').textContent = stats.signed_up ?? 0;
  $('statExpired').textContent = stats.expired ?? 0;
  $('statFailed').textContent = stats.failed ?? 0;
  $('statNoSession').textContent = stats.noSession ?? 0;
  $('statOutlook').textContent = stats.outlookTotal ?? 0;
  const group = $('groupFilter');
  const current = filters.group;
  const names = stats.groups || [];
  group.innerHTML = `<option value="">All groups</option>${names
    .map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`)
    .join('')}`;
  if ([...group.options].some((o) => o.value === current)) group.value = current;
  for (const card of document.querySelectorAll('#tcStatsGrid .stat-card[data-status]')) {
    const wanted = filters.status || 'all';
    card.classList.toggle('active', card.dataset.status === wanted);
  }
}

async function loadStatus() {
  const st = await api('/settings');
  const pill = $('proxyPill');
  pill.classList.toggle('online', st.proxyConfigured);
  pill.classList.toggle('offline', !st.proxyConfigured);
  pill.querySelector('span:last-child').textContent = st.proxyConfigured
    ? `Proxy ${st.proxyHost || 'on'}`
    : 'Proxy not set';
  if (st.proxyUrl && !$('proxyUrl').value) $('proxyUrl').value = st.proxyUrl;
  const preset = $('proxyPreset');
  if (Array.isArray(st.presets) && st.presets.length) {
    const cur = preset.value;
    preset.innerHTML = st.presets
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
      .join('');
    const wanted = st.proxyPreset || cur;
    if (wanted && [...preset.options].some((o) => o.value === wanted)) preset.value = wanted;
  }
  if (st.parallel && [...$('tcParallel').options].some((o) => Number(o.value) === Number(st.parallel))) {
    $('tcParallel').value = String(st.parallel);
  }
  renderQueue(st.queue);
}

async function loadEligible() {
  const qs = new URLSearchParams({
    page: String(filters.page),
    limit: String(filters.limit),
    q: filters.q,
    group: filters.group,
    status: filters.status,
  });
  const data = await api(`/eligible?${qs}`);
  renderStats(data.stats);
  renderQueue(data.queue);
  const body = $('eligibleBody');
  if (!data.accounts.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty">No accounts match this filter. Failed signups are under the Failed card — they leave this “not signed up” list.</td></tr>';
  } else {
    body.innerHTML = data.accounts
      .map((a) => {
        const exp = a.truecaller?.expiresAt ? new Date(a.truecaller.expiresAt).toLocaleString() : '—';
        const err = a.truecaller?.lastError || '';
        return `<tr>
          <td><input type="checkbox" data-email="${escapeHtml(a.email)}" /></td>
          <td class="mono">${escapeHtml(a.email)}</td>
          <td>${escapeHtml(a.group || '—')}</td>
          <td>${escapeHtml(a.outlookHealth || a.outlookStatus || 'session')}</td>
          <td>${tcBadge(a)}</td>
          <td class="mono" title="${escapeHtml(err)}">${escapeHtml(err ? err.slice(0, 140) : '—')}</td>
          <td>${escapeHtml(exp)}</td>
          <td>
            <button type="button" class="btn small" data-copy="${escapeHtml(a.email)}" ${a.truecaller?.hasToken ? '' : 'disabled'}>Copy token</button>
          </td>
        </tr>`;
      })
      .join('');
  }
  $('selectPage').checked = false;
  $('pageNum').textContent = `${data.page} / ${data.pages}`;
  $('pageInfo').textContent = `${data.total.toLocaleString()} matching · showing ${data.accounts.length}`;
  $('pageHint').textContent =
    filters.status === 'not_signed_up'
      ? `${(data.stats?.not_signed_up ?? data.total).toLocaleString()} Outlook sessions have no Truecaller token. Failed signups leave this list — click the Failed card to see the error. Coolify: filter [truecaller:].`
      : `${data.total.toLocaleString()} accounts match the current filters.`;
  filters.page = data.page;
  $('prevPageBtn').disabled = data.page <= 1;
  $('nextPageBtn').disabled = data.page >= data.pages;
  fillSearchList(data.accounts);
}

function fillSearchList(accounts) {
  const withToken = (accounts || []).filter((a) => a.truecaller?.hasToken && !a.truecaller?.expired);
  $('searchEmailList').innerHTML = withToken
    .map((a) => `<option value="${escapeHtml(a.email)}"></option>`)
    .join('');
}

function selectedEmails() {
  return [...document.querySelectorAll('#eligibleBody input[type="checkbox"]:checked')].map((el) => el.dataset.email);
}

function queueLimit() {
  const n = Number($('queueLimit').value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function queueWork(path, body, confirmCount) {
  if (confirmCount && confirmCount > 25) {
    const ok = window.confirm(
      `Queue ${confirmCount.toLocaleString()} accounts on the isolated Truecaller queue?\n\nOutlook profiles and the main login queue will not be used. You can pause or cancel remaining work.`
    );
    if (!ok) return;
  }
  const data = await api(path, { method: 'POST', body: JSON.stringify(body) });
  appendLog(`Queued ${data.queued} ${path.replace('/', '')} job(s). Isolated Camoufox — Outlook profiles will not be written.`);
  renderQueue(data.queue);
  loadJobs().catch((err) => appendLog(err.message));
}

async function previewThenQueue(path, body) {
  const preview = await api(path, {
    method: 'POST',
    body: JSON.stringify({ ...body, preview: true }),
  });
  if (!preview.count) {
    appendLog('No matching accounts to queue.');
    return;
  }
  await queueWork(path, body, preview.count);
}

$('saveProxyBtn').addEventListener('click', async () => {
  try {
    await api('/settings', { method: 'POST', body: JSON.stringify({ proxyUrl: $('proxyUrl').value.trim() }) });
    $('proxySaved').textContent = 'Saved. Outlook proxy was not changed.';
    await loadStatus();
  } catch (err) {
    $('proxySaved').textContent = err.message;
  }
});

$('proxyPreset').addEventListener('change', async () => {
  const id = $('proxyPreset').value;
  $('proxyPreset').disabled = true;
  try {
    const data = await api('/settings', { method: 'POST', body: JSON.stringify({ presetId: id }) });
    $('proxySaved').textContent = `Truecaller now uses ${id}. Outlook login proxy was not changed.`;
    if (data.proxyUrl) $('proxyUrl').value = data.proxyUrl;
    await loadStatus();
  } catch (err) {
    $('proxySaved').textContent = err.message;
  }
  $('proxyPreset').disabled = false;
});

$('tcParallel').addEventListener('change', async () => {
  try {
    await api('/queue/parallel', {
      method: 'POST',
      body: JSON.stringify({ parallel: Number($('tcParallel').value) }),
    });
  } catch (err) {
    appendLog(err.message);
  }
});

$('refreshBtn').addEventListener('click', () => loadEligible().catch((err) => appendLog(err.message)));

$('searchInput').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    filters.q = $('searchInput').value.trim();
    filters.page = 1;
    loadEligible().catch((err) => appendLog(err.message));
  }
});
$('searchInput').addEventListener('change', () => {
  filters.q = $('searchInput').value.trim();
  filters.page = 1;
  loadEligible().catch((err) => appendLog(err.message));
});
$('groupFilter').addEventListener('change', () => {
  filters.group = $('groupFilter').value;
  filters.page = 1;
  loadEligible().catch((err) => appendLog(err.message));
});
$('statusFilter').addEventListener('change', () => {
  filters.status = $('statusFilter').value;
  filters.page = 1;
  loadEligible().catch((err) => appendLog(err.message));
});
$('prevPageBtn').addEventListener('click', () => {
  filters.page = Math.max(1, filters.page - 1);
  loadEligible().catch((err) => appendLog(err.message));
});
$('nextPageBtn').addEventListener('click', () => {
  filters.page += 1;
  loadEligible().catch((err) => appendLog(err.message));
});
$('selectPage').addEventListener('change', () => {
  const on = $('selectPage').checked;
  for (const el of document.querySelectorAll('#eligibleBody input[type="checkbox"]')) el.checked = on;
});

document.querySelectorAll('#tcStatsGrid .stat-card[data-status]').forEach((card) => {
  card.addEventListener('click', () => {
    if (!card.dataset.status) return;
    filters.status = card.dataset.status === 'all' ? '' : card.dataset.status;
    $('statusFilter').value = filters.status;
    filters.page = 1;
    loadEligible().catch((err) => appendLog(err.message));
  });
});

$('signupMatchingBtn').addEventListener('click', async () => {
  try {
    await previewThenQueue('/signup', {
      scope: filters.status || 'all',
      group: filters.group,
      search: filters.q,
      limit: queueLimit(),
    });
  } catch (err) {
    appendLog(`Signup error: ${err.message}`);
  }
});

$('signupSelectedBtn').addEventListener('click', async () => {
  const emails = selectedEmails();
  if (!emails.length) return alert('Select at least one account on this page.');
  try {
    await queueWork('/signup', { scope: 'selected', emails }, emails.length);
  } catch (err) {
    appendLog(`Signup error: ${err.message}`);
  }
});

$('refreshExpiredBtn').addEventListener('click', async () => {
  try {
    await previewThenQueue('/refresh', {
      scope: 'expired',
      group: filters.group,
      search: filters.q,
      limit: queueLimit(),
    });
  } catch (err) {
    appendLog(`Refresh error: ${err.message}`);
  }
});

$('refreshSelectedBtn').addEventListener('click', async () => {
  const emails = selectedEmails();
  if (!emails.length) return alert('Select at least one account on this page.');
  try {
    await queueWork('/refresh', { scope: 'selected', emails }, emails.length);
  } catch (err) {
    appendLog(`Refresh error: ${err.message}`);
  }
});

$('pauseQueueBtn').addEventListener('click', async () => {
  try {
    const data = await api('/queue/pause', { method: 'POST', body: JSON.stringify({ paused: true }) });
    renderQueue(data.queue);
  } catch (err) {
    appendLog(err.message);
  }
});
$('resumeQueueBtn').addEventListener('click', async () => {
  try {
    const data = await api('/queue/resume', { method: 'POST', body: '{}' });
    renderQueue(data.queue);
  } catch (err) {
    appendLog(err.message);
  }
});
$('cancelQueueBtn').addEventListener('click', async () => {
  if (!window.confirm('Cancel remaining Truecaller jobs? The current running account(s) will finish.')) return;
  try {
    const data = await api('/queue/cancel', { method: 'POST', body: '{}' });
    renderQueue(data.queue);
    appendLog('Cancelled remaining Truecaller queue.');
  } catch (err) {
    appendLog(err.message);
  }
});

$('searchBtn').addEventListener('click', async () => {
  $('searchResult').textContent = 'Searching…';
  try {
    const data = await api('/search', {
      method: 'POST',
      body: JSON.stringify({
        email: $('searchEmail').value,
        country: $('searchCountry').value,
        number: $('searchNumber').value,
      }),
    });
    $('searchResult').textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    $('searchResult').textContent = err.message;
  }
});

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-copy]');
  if (!btn) return;
  try {
    const data = await api(`/accounts/${encodeURIComponent(btn.dataset.copy)}/token`);
    await navigator.clipboard.writeText(data.jwt || data.innerToken || '');
    appendLog(`Copied Truecaller JWT for ${btn.dataset.copy}`);
  } catch (err) {
    appendLog(err.message);
  }
});

function connectEvents() {
  const es = new EventSource('/api/truecaller/events');
  es.addEventListener('queue', (ev) => {
    try {
      renderQueue(JSON.parse(ev.data));
    } catch {
      // ignore
    }
  });
  es.addEventListener('jobs', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      for (const job of data.jobs || []) ingestJob(job);
    } catch {
      // ignore
    }
  });
  es.addEventListener('job', (ev) => {
    try {
      const job = JSON.parse(ev.data);
      ingestJob(job);
      if (job.status === 'success' || job.status === 'failed') {
        const now = Date.now();
        if (now - lastReload > 4000) {
          lastReload = now;
          loadEligible().catch(() => {});
        }
      }
    } catch {
      // ignore
    }
  });
  es.onerror = () => {
    const hint = $('liveHint');
    if (hint) hint.textContent = 'Live stream interrupted — still polling Truecaller jobs every 2s. Filter Coolify for [truecaller:].';
  };
}

connectEvents();
setInterval(() => {
  loadJobs().catch(() => {});
}, 2000);

loadStatus().catch((err) => appendLog(err.message));
loadJobs().catch((err) => appendLog(err.message));
loadEligible().catch((err) => appendLog(err.message));
