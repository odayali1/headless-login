import express from 'express';

import path from 'node:path';

import { fileURLToPath } from 'node:url';

import { v4 as uuidv4 } from 'uuid';

import { isCamoufoxAvailable } from './lib/camoufox-browser.js';
import { ensureCamoufoxInstalled } from './lib/ensure-camoufox.js';

import { loginMicrosoft, TARGETS } from './lib/microsoft-login.js';

import { listAccounts, listAccountsPage, filterAccounts, invalidateAccountsCache, toPublicAccount } from './lib/accounts.js';
import { computeAccountStats } from './lib/account-health.js';
import { exportCsv } from './lib/account-export.js';
import {
  getSmartRefreshStatus,
  isSmartRefreshEnabled,
  setSmartRefreshEnabled,
  syncSmartRefreshRuntime,
  waitForSmartRefreshHttpQuiet,
} from './lib/smart-refresh.js';

import { markProfileFailed, loadProfile, CANONICAL_TARGET, deleteAllProfilesForEmail } from './lib/profile.js';

import { refreshAccountToken } from './lib/account-actions.js';

import { checkAccountSoftban } from './lib/softban-check.js';

import {
  saveAccountCredentials,
  getAccountPassword,
  getAccountPasswordWithFallback,
  deleteAccountCredentials,
  setAccountGroup,
  listGroups,
  getAccountRecord,
  hasStoredPassword,
} from './lib/db.js';

import { runStartupMigrations } from './lib/migrate.js';
import { ensureEnvWebhook, notifyAccountTokenUpdated } from './lib/sync-webhooks.js';

import { batchDelayMs, sleep } from './lib/anti-detect.js';

import { beforeAccountLogin, afterAccountLoginSuccess, beforeAccountRefresh, rotateProxyIp, endLoginProxyExclusive, beginLoginProxyExclusive, GCT_429_SETTLE_MS } from './lib/proxy.js';

import { getProxyStatus, setProxyEnabled, getProxyUrl, parseProxyUrl, isIproxyWifiSplitMode, isMobileRelayProxy, getProxyHttpUrl, getProxyPreferMode } from './lib/settings.js';
import { getBandwidthStats, resetBandwidthStats } from './lib/bandwidth-stats.js';
import { closeLocalProxy } from './lib/proxy-local.js';

import { resolveEngine } from './lib/browser.js';

import { createJobsStore } from './lib/jobs-store.js';

import { createLoginQueue } from './lib/login-queue.js';

import { requireApiKey } from './lib/api-auth.js';

import { createApiV1Router } from './lib/api-v1.js';

import { createRefreshJobQueue } from './lib/refresh-job.js';

import { firefoxProfileDir } from './lib/camoufox-browser.js';

import { importDataBackup } from './lib/data-import.js';

import { DATA_DIR } from './lib/db.js';

import { repairAllLaunchOptions } from './lib/camoufox-browser.js';



const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

const PORT = process.env.PORT || 3847;



app.use(express.json({ limit: '1mb' }));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/SYNC-API.md', (_req, res) => {
  res.type('text/markdown').sendFile(path.join(__dirname, 'SYNC-API.md'));
});

app.use('/screenshots', express.static(path.join(__dirname, 'screenshots')));



const sseClients = new Set();

function broadcast(event, data) {

  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  for (const res of sseClients) {

    res.write(payload);

  }

}

const jobStore = createJobsStore({ broadcast });

const { registerJob, updateJob, jobLog, stats: jobStats, listSummaries, getJob, jobsForAccount, clearFinished, broadcastBatch, summarize, isCancelled, cancelJob, cancelQueued, findActiveJob } = jobStore;

const loginQueue = createLoginQueue({
  broadcast,
  onTimeout: ({ jobId, err }) => {
    if (!jobId) return;
    const job = getJob(jobId, { full: true });
    if (!job || !['queued', 'starting', 'running'].includes(job.status)) return;
    updateJob(jobId, { status: 'failed', message: err.message, finishedAt: new Date().toISOString() });
    broadcastAccounts();
  },
});

const { enqueue: enqueueLogin, getStatus: getQueueStatus, setPaused: setLoginQueuePaused } = loginQueue;
{
  const raw = process.env.LOGIN_PARALLEL;
  const requested = raw == null || raw === '' ? 1 : Number(raw);
  const capped =
    Number.isFinite(requested) &&
    Math.trunc(requested) > 1 &&
    process.env.LOGIN_PARALLEL_FORCE !== '1' &&
    loginQueue.parallel === 1;
  console.log(
    `[queue] Login parallel: ${loginQueue.parallel}${capped ? ' (LOGIN_PARALLEL=2 capped — set LOGIN_PARALLEL_FORCE=1 to allow 2)' : raw ? ` (LOGIN_PARALLEL=${raw})` : ''}`
  );
}



app.get('/api/health', async (_req, res) => {

  const camoufox = await isCamoufoxAvailable();

  const proxy = getProxyStatus();

  res.json({

    ok: true,

    camoufox,

    proxy,

    engine: 'camoufox',

    targets: Object.keys(TARGETS),

    api_v1: '/api/v1',

    api_auth: !!process.env.API_KEY?.trim(),

  });

});



function proxyStatusPayload() {
  return { ...getProxyStatus(), bandwidth: getBandwidthStats() };
}

app.get('/api/proxy', (_req, res) => {

  res.json(proxyStatusPayload());

});



app.post('/api/bandwidth/reset', (_req, res) => {

  resetBandwidthStats();

  res.json({ ok: true, bandwidth: getBandwidthStats() });

});



app.post('/api/proxy/toggle', (req, res) => {

  const enabled = req.body?.enabled;

  setProxyEnabled(enabled !== false);

  const status = proxyStatusPayload();

  broadcast('proxy', status);

  res.json(status);

});



app.post('/api/proxy/rotate', async (_req, res) => {

  try {

    await rotateProxyIp((step, message) => console.log(`[${step}]`, message));

    const status = proxyStatusPayload();

    broadcast('proxy', status);

    res.json(status);

  } catch (err) {

    res.status(500).json({ error: err.message });

  }

});



let accountsBroadcastTimer = null;
let accountsBroadcastInFlight = false;
let accountsBroadcastAgain = false;
let accountsStatsSeq = 0;

function broadcastAccounts() {
  invalidateAccountsCache();
  if (accountsBroadcastInFlight) {
    accountsBroadcastAgain = true;
    return;
  }
  clearTimeout(accountsBroadcastTimer);
  // Longer debounce under bulk cookie/Camoufox refresh — avoid scanning ~1k profiles every 300ms.
  accountsBroadcastTimer = setTimeout(() => {
    flushAccountStatsBroadcast().catch(() => {});
  }, 2_500);
}

async function flushAccountStatsBroadcast() {
  accountsBroadcastInFlight = true;
  accountsBroadcastAgain = false;
  try {
    // Fresh rebuild once (cache was invalidated); do not force a second bust.
    const accounts = await listAccounts();
    broadcast('account-stats', {
      ...computeAccountStats(accounts),
      seq: ++accountsStatsSeq,
    });
  } catch {
    // ignore
  }
  accountsBroadcastInFlight = false;
  if (accountsBroadcastAgain) {
    accountsBroadcastAgain = false;
    clearTimeout(accountsBroadcastTimer);
    accountsBroadcastTimer = setTimeout(() => {
      flushAccountStatsBroadcast().catch(() => {});
    }, 2_500);
  }
}



app.get('/api/accounts/stats', async (_req, res) => {
  const accounts = await listAccounts();
  res.json(computeAccountStats(accounts));
});

app.get('/api/groups', (_req, res) => {
  res.json(listGroups());
});

app.post('/api/groups/assign', async (req, res) => {
  const { group = '', accounts = [] } = req.body || {};
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return res.status(400).json({ error: 'Provide accounts: [{ email, target }...]' });
  }
  for (const acc of accounts) {
    if (!acc?.email || !acc?.target) continue;
    setAccountGroup(acc.email, acc.target, group);
  }
  broadcastAccounts();
  res.json({ ok: true, updated: accounts.length, group: String(group || '').trim() || null });
});



app.get('/api/accounts/export/:type', async (req, res) => {

  const type = req.params.type;

  if (!['tokens', 'failed-refresh'].includes(type)) {

    return res.status(400).json({ error: 'Use type tokens or failed-refresh' });

  }

  try {

    const group = req.query.group ? String(req.query.group) : undefined;
    const { filename, body, count } = await exportCsv(type, { group });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    res.send(body);

  } catch (err) {

    res.status(500).json({ error: err.message });

  }

});



app.get('/api/smart-refresh', (_req, res) => {

  res.json(getSmartRefreshStatus());

});



const smartRefreshRuntime = {
  log: (msg) => console.log(msg),
  onRefreshed: broadcastAccounts,
  isLoginQueueBusy: () => getQueueStatus().running > 0,
  getLoginQueueStatus: () => getQueueStatus(),
  pauseLoginQueue: (paused) => {
    setLoginQueuePaused(!!paused);
    broadcast('queue-status', getQueueStatus());
  },
};

app.post('/api/smart-refresh/toggle', async (req, res) => {
  const enabled = req.body?.enabled !== false;
  setSmartRefreshEnabled(enabled);

  if (enabled) {
    const camoufox = await isCamoufoxAvailable();
    if (!camoufox) {
      setSmartRefreshEnabled(false);
      return res.status(503).json({
        ...getSmartRefreshStatus(),
        error: 'Camoufox not available — smart refresh cannot run on this host.',
      });
    }
  }

  syncSmartRefreshRuntime(smartRefreshRuntime);
  const status = getSmartRefreshStatus();
  broadcast('smart-refresh', status);
  res.json(status);
});



app.get('/api/accounts', async (req, res) => {
  const { page, limit, group, health, search } = req.query || {};
  if (page || limit || group || health || search) {
    return res.json(
      await listAccountsPage({
        page,
        limit,
        group: String(group || ''),
        health: String(health || ''),
        search: String(search || ''),
      })
    );
  }
  const all = await listAccounts();
  res.json({
    accounts: all.map((acc) => toPublicAccount(acc)),
    total: all.length,
    page: 1,
    limit: all.length,
    pages: 1,
  });
});

app.get('/api/accounts/emails', async (req, res) => {
  const { group = '', health = '', search = '' } = req.query || {};
  const filtered = filterAccounts(await listAccounts(), {
    group: String(group || ''),
    health: String(health || ''),
    search: String(search || ''),
  });
  res.json({
    accounts: filtered.map((a) => ({
      email: a.email,
      target: a.target,
      hasStoredPassword: a.hasStoredPassword,
    })),
    total: filtered.length,
  });
});



app.get('/api/accounts/:email/:target/token', async (req, res) => {
  const data = await loadProfile(req.params.email, req.params.target);
  const token = data?.tokens;
  if (!token?.access_token) {
    return res.status(404).json({ error: 'No access token for this account.' });
  }
  res.json({
    email: req.params.email,
    target: req.params.target,
    access_token: token.access_token,
    expires_at: token.expires_at || null,
  });
});



app.delete('/api/accounts/:email/:target', async (req, res) => {

  const { email, target } = req.params;

  const fs = await import('node:fs/promises');

  const { deleteAllProfilesForEmail, CANONICAL_TARGET } = await import('./lib/profile.js');

  try {

    await deleteAllProfilesForEmail(email);

  } catch {

    // profile may not exist

  }

  try {

    await fs.rm(firefoxProfileDir(email, CANONICAL_TARGET), { recursive: true, force: true });

  } catch {

    // firefox profile may not exist

  }

  deleteAccountCredentials(email);

  cancelQueued({ email, target: CANONICAL_TARGET });

  broadcastAccounts();

  res.json({ ok: true });

});



function createJob(email, target, engine, message = 'Queued…', { cancelPrevious = true, jobKind = 'login' } = {}) {

  if (cancelPrevious) cancelQueued({ email: email.trim(), target });

  const id = uuidv4();

  const job = registerJob({

    id,

    email: email.trim(),

    target,

    engine: resolveEngine(engine),

    status: 'queued',

    message,

    jobKind,

  });

  broadcast('job', summarize(job, { logs: true }));

  broadcast('job-stats', jobStats());

  return id;

}



const queueRefreshJob = createRefreshJobQueue({

  createJob,

  updateJob,

  jobLog,

  enqueueLogin,

  beforeAccountRefresh,

  refreshAccountToken,

  broadcastAccounts,

  findActiveJob,

});



app.use(

  '/api/v1',

  requireApiKey,

  createApiV1Router({

    queueRefreshJob,

    getJob,

    getQueueStatus,

    jobStats,

  })

);



const zipImportBody = express.raw({

  type: ['application/zip', 'application/octet-stream'],

  limit: '150mb',

});



app.post('/api/data/import', requireApiKey, zipImportBody, async (req, res) => {

  try {

    if (!req.body?.length) {

      return res.status(400).json({ ok: false, error: 'Empty body — upload a .zip file.' });

    }

    const result = importDataBackup(req.body, DATA_DIR);
    await repairAllLaunchOptions();

    res.json({ ok: true, message: 'Data restored. Server restarting…', ...result });

    setTimeout(() => process.exit(0), 1500);

  } catch (err) {

    res.status(500).json({ ok: false, error: err.message });

  }

});



app.post('/api/accounts/:email/:target/refresh-token', async (req, res) => {

  const { email, target } = req.params;

  if (!TARGETS[target]) {

    return res.status(400).json({ error: 'Invalid target.' });

  }



  const queued = queueRefreshJob(email, target);

  res.status(202).json({ id: queued.id, status: queued.status, duplicate: queued.duplicate });

});



app.post('/api/accounts/:email/:target/relogin', async (req, res) => {

  const { email, target } = req.params;
  const { loginAs } = req.body || {};
  const loginVia = resolveLoginVia(loginAs);
  const backupOpts = parseBackupLoginOptions(req.body);
  const regenerateFingerprint = req.body?.regenerateFingerprint === true;
  const mimicPhone = parseMimicPhoneOption(req.body);

  const stored = getAccountPasswordWithFallback(email, CANONICAL_TARGET);

  if (!stored) {
    const row = getAccountRecord(email);
    const msg = row?.password_enc
      ? 'Password is saved but cannot be decrypted on this server. Ensure data/.credentials-key was imported, or re-upload the batch CSV with passwords.'
      : 'No saved password — log in once from the form.';
    return res.status(400).json({ error: msg });
  }



  const id = createJob(email, CANONICAL_TARGET, 'camoufox', 'Re-login queued…');

  res.json({ id, status: 'queued', target: CANONICAL_TARGET, loginVia });



  enqueueLogin(() =>

    runJob(id, email, stored, loginVia, 'camoufox', true, {
      forceFresh: true,
      regenerateFingerprint,
      mimicPhone,
      ...backupOpts,
    }).catch(async (err) => {

      await markProfileFailed(email, err.message).catch(() => {});

      updateJob(id, { status: 'failed', message: err.message, finishedAt: new Date().toISOString() });

      broadcastAccounts();

    })

  , { jobId: id, label: `${email} re-login` });

});



app.post('/api/accounts/:email/:target/check-softban', async (req, res) => {

  const { email, target } = req.params;

  if (!TARGETS[target]) {

    return res.status(400).json({ error: 'Invalid target.' });

  }

  try {

    const saved = await loadProfile(email);

    if (!saved?.state) {

      return res.status(400).json({ error: 'No saved profile — log in first.' });

    }

    const result = await checkAccountSoftban(email, target, saved.state.tokens);

    broadcastAccounts();

    res.json(result);

  } catch (err) {

    res.status(500).json({ error: err.message });

  }

});

function resolveLoginVia(loginAs) {
  const override = String(loginAs || '').trim();
  if (override && TARGETS[override]) return override;
  return CANONICAL_TARGET;
}

/** skip | hub | block — hub sets backup via IMAP hub inbox */
function parseBackupLoginOptions(body = {}) {
  const mode = String(body.backupEmailMode || '').trim().toLowerCase();
  if (mode === 'hub') {
    return { skipBackupEmail: false, backupEmailMode: 'hub' };
  }
  const skip = body.skipBackupEmail !== false;
  return { skipBackupEmail: skip, backupEmailMode: skip ? 'skip' : 'block' };
}

/** true/false when client sets mimicPhone; undefined keeps the account's saved mode. */
function parseMimicPhoneOption(body = {}) {
  if (body?.mimicPhone === true) return true;
  if (body?.mimicPhone === false) return false;
  return undefined;
}

async function queueAccountsAction(
  action,
  accounts,
  { label = 'bulk', skipBackupEmail = true, backupEmailMode = 'skip', loginAs = '', regenerateFingerprint = false, mimicPhone } = {}
) {
  const backupOpts = backupEmailMode === 'hub'
    ? { skipBackupEmail: false, backupEmailMode: 'hub' }
    : { skipBackupEmail, backupEmailMode: skipBackupEmail ? 'skip' : 'block' };
  const reloginOpts = {
    ...backupOpts,
    regenerateFingerprint: regenerateFingerprint === true,
    ...(typeof mimicPhone === 'boolean' ? { mimicPhone } : {}),
  };
  const accepted = [];
  const loginVia = resolveLoginVia(loginAs);
  for (const acc of accounts) {
    const email = acc.email;
    if (action === 'delete') {
      deleteAccountCredentials(email);
      cancelQueued({ email, target: CANONICAL_TARGET });
      accepted.push({ email, target: CANONICAL_TARGET, status: 'deleted' });
      continue;
    }
    if (action === 'refresh') {
      const id = createJob(email, CANONICAL_TARGET, 'camoufox', `${label} refresh queued…`);
      accepted.push({ email, target: CANONICAL_TARGET, jobId: id });
      enqueueLogin(async () => {
        if (isCancelled(id)) return;
        try {
          updateJob(id, { status: 'running', message: 'Refreshing LiveProfileCard token…' });
          await beforeAccountRefresh((step, message) => jobLog(id, step, message));
          const result = await refreshAccountToken(email, CANONICAL_TARGET, {
            engine: 'camoufox',
            jobId: id,
            onProgress: ({ step, message }) => jobLog(id, step, message),
          });
          updateJob(id, { status: 'success', message: 'Token refreshed', result, finishedAt: new Date().toISOString() });
          broadcastAccounts();
        } catch (err) {
          updateJob(id, { status: 'failed', message: err.message, finishedAt: new Date().toISOString() });
          broadcastAccounts();
        }
      }, { jobId: id, label: `${email} ${label} refresh` });
      continue;
    }

    if (action === 'relogin') {
      const stored = getAccountPasswordWithFallback(email, CANONICAL_TARGET);
      if (!stored) continue;
      const id = createJob(email, CANONICAL_TARGET, 'camoufox', `${label} re-login queued…`);
      accepted.push({ email, target: CANONICAL_TARGET, loginVia, jobId: id });
      enqueueLogin(() =>
        runJob(id, email, stored, loginVia, 'camoufox', true, { forceFresh: true, ...reloginOpts }).catch(async (err) => {
          await markProfileFailed(email, err.message).catch(() => {});
          updateJob(id, { status: 'failed', message: err.message, finishedAt: new Date().toISOString() });
          broadcastAccounts();
        })
      , { jobId: id, label: `${email} ${label} re-login` });
      continue;
    }

    if (action === 'check-softban') {
      const id = createJob(email, CANONICAL_TARGET, 'camoufox', `${label} softban check queued…`);
      accepted.push({ email, target: CANONICAL_TARGET, jobId: id });
      enqueueLogin(async () => {
        if (isCancelled(id)) return;
        try {
          updateJob(id, { status: 'running', message: 'Checking softban status…' });
          const saved = await loadProfile(email);
          if (!saved?.state) throw new Error('No saved profile — log in first.');
          const result = await checkAccountSoftban(email, CANONICAL_TARGET, saved.state.tokens);
          updateJob(id, { status: 'success', message: result.message || 'Softban check done', result, finishedAt: new Date().toISOString() });
          broadcastAccounts();
        } catch (err) {
          updateJob(id, { status: 'failed', message: err.message, finishedAt: new Date().toISOString() });
          broadcastAccounts();
        }
      }, { jobId: id, label: `${email} softban check` });
    }
  }
  return accepted;
}

app.post('/api/accounts/bulk-action', async (req, res) => {
  const {
    action,
    accounts: list,
    skipBackupEmail = true,
    backupEmailMode = '',
    loginAs = '',
    regenerateFingerprint = false,
  } = req.body || {};
  const mimicPhone = parseMimicPhoneOption(req.body);
  if (!Array.isArray(list) || list.length === 0) {
    return res.status(400).json({ error: 'accounts array is required.' });
  }
  if (!['refresh', 'relogin', 'check-softban', 'delete'].includes(action)) {
    return res.status(400).json({ error: 'Use action: refresh, relogin, check-softban, delete' });
  }

  const normalized = list
    .map((a) => ({ email: String(a.email || '').trim(), target: a.target || 'outlook' }))
    .filter((a) => a.email && TARGETS[a.target]);

  if (normalized.length === 0) {
    return res.status(400).json({ error: 'No valid accounts in request.' });
  }

  const accepted = await queueAccountsAction(action, normalized, {
    label: 'Filtered',
    skipBackupEmail,
    backupEmailMode: String(backupEmailMode || '').trim(),
    loginAs,
    regenerateFingerprint: regenerateFingerprint === true,
    mimicPhone,
  });
  broadcastAccounts();
  res.json({ ok: true, action, count: accepted.length, accepted });
});

app.post('/api/groups/:group/action', async (req, res) => {
  const group = String(req.params.group || '').trim();
  const {
    action,
    loginAs = '',
    skipBackupEmail = true,
    backupEmailMode = '',
    regenerateFingerprint = false,
  } = req.body || {};
  const mimicPhone = parseMimicPhoneOption(req.body);
  if (!group) return res.status(400).json({ error: 'Group is required.' });
  if (!['refresh', 'relogin', 'check-softban', 'delete'].includes(action)) {
    return res.status(400).json({ error: 'Use action: refresh, relogin, check-softban, delete' });
  }

  const accounts = (await listAccounts()).filter(
    (a) => (a.group || '').toLowerCase() === group.toLowerCase()
  );
  if (accounts.length === 0) return res.status(404).json({ error: `No accounts in group "${group}"` });

  const accepted = await queueAccountsAction(action, accounts, {
    label: `Group ${group}`,
    skipBackupEmail,
    backupEmailMode: String(backupEmailMode || '').trim(),
    loginAs,
    regenerateFingerprint: regenerateFingerprint === true,
    mimicPhone,
  });

  broadcastAccounts();
  res.json({ ok: true, group, action, count: accepted.length, accepted });
});



app.get('/api/jobs', (req, res) => {

  const limit = Math.min(Number(req.query.limit) || 100, 500);

  const activeOnly = req.query.active === '1' || req.query.active === 'true';

  res.json({

    stats: jobStats(),

    jobs: listSummaries({ limit, activeOnly }),

  });

});



app.get('/api/jobs/stats', (_req, res) => {

  res.json(jobStats());

});



app.get('/api/queue/status', (_req, res) => {

  res.json({ ...getQueueStatus(), jobStats: jobStats() });

});



app.get('/api/jobs/:id', (req, res) => {

  const job = getJob(req.params.id, { full: true });

  if (!job) return res.status(404).json({ error: 'Job not found.' });

  res.json(job);

});



app.get('/api/accounts/:email/:target/jobs', (req, res) => {

  const { email, target } = req.params;

  res.json(jobsForAccount(email, target, Math.min(Number(req.query.limit) || 25, 50)));

});



app.post('/api/jobs/clear-finished', (_req, res) => {

  const cleared = clearFinished();

  res.json({ cleared, stats: jobStats() });

});



app.post('/api/jobs/cancel-queued', (req, res) => {

  const { email, target } = req.body || {};

  const cancelled = cancelQueued({ email, target });

  res.json({ cancelled, stats: jobStats(), queue: getQueueStatus() });

});



app.post('/api/jobs/pause-queue', (req, res) => {
  const paused = req.body?.paused !== false;
  const queue = setLoginQueuePaused(paused);
  broadcast('queue-status', queue);
  res.json({ ok: true, queue, stats: jobStats() });
});



app.post('/api/jobs/:id/cancel', (req, res) => {

  const ok = cancelJob(req.params.id);

  if (!ok) return res.status(400).json({ error: 'Job not found or not queued.' });

  res.json({ ok: true, stats: jobStats() });

});



app.get('/api/events', (req, res) => {

  res.setHeader('Content-Type', 'text/event-stream');

  res.setHeader('Cache-Control', 'no-cache');

  res.setHeader('Connection', 'keep-alive');

  res.flushHeaders();



  sseClients.add(res);

  listAccounts({ bustCache: true })
    .then((accounts) => {
      res.write(
        `event: connected\ndata: ${JSON.stringify({
          jobs: listSummaries({ limit: 100 }),
          jobStats: jobStats(),
          queue: getQueueStatus(),
          accountStats: { ...computeAccountStats(accounts), seq: ++accountsStatsSeq },
          smartRefresh: getSmartRefreshStatus(),
          proxy: proxyStatusPayload(),
        })}\n\n`
      );
    })
    .catch(() => {
      res.write(
        `event: connected\ndata: ${JSON.stringify({
          jobs: listSummaries({ limit: 100 }),
          jobStats: jobStats(),
          queue: getQueueStatus(),
          smartRefresh: getSmartRefreshStatus(),
          proxy: proxyStatusPayload(),
        })}\n\n`
      );
    });



  req.on('close', () => sseClients.delete(res));

});



app.post('/api/login', async (req, res) => {

  const { email, password, target = 'outlook', headless = true, group = '', skipBackupEmail = true, backupEmailMode = '' } = req.body || {};
  const backupOpts = parseBackupLoginOptions(req.body);
  const mimicPhone = parseMimicPhoneOption(req.body);



  if (!email?.trim() || !password) {

    return res.status(400).json({ error: 'Email and password are required.' });

  }

  const loginVia = target;

  if (!TARGETS[loginVia]) {

    return res.status(400).json({ error: `Invalid target. Use: ${Object.keys(TARGETS).join(', ')}` });

  }



  const id = uuidv4();

  const job = registerJob({

    id,

    email: email.trim(),

    target: CANONICAL_TARGET,

    engine: 'camoufox',

    status: 'queued',

    message: 'Waiting to start…',

  });

  broadcast('job', summarize(job, { logs: true }));

  broadcast('job-stats', jobStats());

  res.json({ id, status: 'queued', target: CANONICAL_TARGET, loginVia });



  saveAccountCredentials(email.trim(), CANONICAL_TARGET, password, 'camoufox');
  const groupName = String(group || '').trim();
  if (groupName) {
    setAccountGroup(email.trim(), CANONICAL_TARGET, groupName);
    broadcastAccounts();
  }



  enqueueLogin(() =>

    runJob(id, email.trim(), password, loginVia, 'camoufox', headless, {
      ...backupOpts,
      ...(typeof mimicPhone === 'boolean' ? { mimicPhone } : {}),
    }).catch(async (err) => {

      await markProfileFailed(email.trim(), err.message).catch(() => {});

      updateJob(id, { status: 'failed', message: err.message, error: err.stack });

      broadcastAccounts();

    })

  , { jobId: id, label: `${email.trim()} login` });

});



app.post('/api/login/batch', async (req, res) => {

  const { accounts = [], target = 'outlook', headless = true, group = '', skipBackupEmail = true, backupEmailMode = '' } = req.body || {};
  const backupOpts = parseBackupLoginOptions(req.body);
  const mimicPhone = parseMimicPhoneOption(req.body);
  const loginVia = target;
  const groupName = String(group || '').trim();

  if (!Array.isArray(accounts) || accounts.length === 0) {

    return res.status(400).json({ error: 'Provide accounts: [{ email, password }, ...]' });

  }

  if (!TARGETS[loginVia]) {
    return res.status(400).json({ error: `Invalid target. Use: ${Object.keys(TARGETS).join(', ')}` });
  }



  const ids = [];

  const validAccounts = accounts.filter((a) => a.email && a.password);

  const batchId = uuidv4();

  const batchSummaries = [];

  for (const acc of validAccounts) {

    cancelQueued({ email: acc.email.trim(), target: CANONICAL_TARGET });

    const id = uuidv4();

    const job = registerJob({

      id,

      email: acc.email.trim(),

      target: CANONICAL_TARGET,

      engine: 'camoufox',

      status: 'queued',

      message: 'Queued in batch (one at a time)…',

      batchId,

      batchGroup: groupName || null,

    });

    ids.push(id);

    batchSummaries.push(summarize(job));

  }

  if (batchSummaries.length) {

    broadcastBatch(batchId, batchSummaries, { batchGroup: groupName || null });

  }

  res.json({ ids, count: ids.length, batchId, batchGroup: groupName || null });



  for (const acc of validAccounts) {

    saveAccountCredentials(acc.email.trim(), CANONICAL_TARGET, acc.password, 'camoufox');
    if (groupName) setAccountGroup(acc.email.trim(), CANONICAL_TARGET, groupName);

  }

  if (groupName) broadcastAccounts();



  for (let i = 0; i < validAccounts.length; i++) {

    const acc = validAccounts[i];

    const id = ids[i];

    enqueueLogin(async () => {

      if (isCancelled(id)) return;

      if (i > 0) {

        const delay = batchDelayMs(i);

        updateJob(id, { message: `Waiting ${Math.round(delay / 1000)}s before next account…` });

        await sleep(delay);

      }

      if (isCancelled(id)) return;

      try {

        await runJob(id, acc.email.trim(), acc.password, loginVia, 'camoufox', headless, {
          ...backupOpts,
          ...(typeof mimicPhone === 'boolean' ? { mimicPhone } : {}),
        });

      } catch (err) {

        await markProfileFailed(acc.email.trim(), err.message).catch(() => {});

        updateJob(id, { status: 'failed', message: err.message, finishedAt: new Date().toISOString() });

        broadcastAccounts();

      }

    }, { jobId: id, label: `${acc.email.trim()} batch` });

  }

});



async function runJob(
  id,
  email,
  password,
  target,
  engine,
  headless,
  { forceFresh = false, regenerateFingerprint = false, mimicPhone, skipBackupEmail = true, backupEmailMode = 'skip' } = {}
) {

  if (isCancelled(id)) return;

  if (!getAccountPasswordWithFallback(email, CANONICAL_TARGET)) {

    updateJob(id, { status: 'cancelled', message: 'Account removed — job skipped.', finishedAt: new Date().toISOString() });

    return;

  }

  updateJob(id, { status: 'starting', message: 'Starting Camoufox…' });

  try {
  beginLoginProxyExclusive();
  // Short drain only — smart-refresh keeps Loki alive during login; full quiet is around GetCredentialType.
  await waitForSmartRefreshHttpQuiet((step, message) => jobLog(id, step, message), 20_000);
  await beforeAccountLogin((step, message) => jobLog(id, step, message));

  updateJob(id, { status: 'running', message: 'Browser ready — logging in…' });
  if (regenerateFingerprint) {
    jobLog(id, 'engine', 'Fresh Camoufox profile requested — rebuilding device fingerprint for this login…');
  }
  if (mimicPhone === true) {
    jobLog(id, 'engine', 'Phone mimic requested — unique mobile-sized Camoufox fingerprint for this account…');
  } else if (mimicPhone === false) {
    jobLog(id, 'engine', 'Desktop Camoufox fingerprint requested for this login…');
  }

  const loginArgs = {
    email,
    password,
    target,
    engine: resolveEngine(engine),
    headless,
    jobId: id,
    forceFresh,
    regenerateFingerprint: regenerateFingerprint === true,
    ...(typeof mimicPhone === 'boolean' ? { mimicPhone } : {}),
    skipBackupEmail,
    backupEmailMode,
    onEmailRetry: async () => {},
    onProgress: ({ step, message, ...extra }) => jobLog(id, step, message),
  };

  let result;
  try {
    result = await loginMicrosoft(loginArgs);
  } catch (err) {
    // Proven by Coolify logs: gct=429. Soft-reload on same IP always fails; Orbury succeeded only after gct=200.
    if (err?.code === 'GCT_429' || err?.code === 'GCT_LOOKUP' || /GetCredentialType HTTP 429|issue looking up/i.test(err?.message || '')) {
      // Phone-sized Camoufox trips GetCredentialType more often — recover on desktop like pre-phone-mimic.
      const phoneCaused = loginArgs.mimicPhone === true;
      if (phoneCaused) {
        jobLog(
          id,
          'proxy',
          `${err.code || 'GCT'} with phone mimic — rotating once, then retrying as desktop Camoufox (stops rotate loop)`
        );
      } else {
        jobLog(id, 'proxy', `${err.code || 'GCT'} — rotating to a clean IP, settling ${Math.round(GCT_429_SETTLE_MS / 1000)}s, one retry (new Camoufox device)…`);
      }
      await rotateProxyIp((step, message) => jobLog(id, step, message), { force: true, allowDuringLogin: true }).catch(() => {});
      await sleep(GCT_429_SETTLE_MS);
      await beforeAccountLogin((step, message) => jobLog(id, step, message));
      result = await loginMicrosoft({
        ...loginArgs,
        forceFresh: true,
        regenerateFingerprint: true,
        // Always leave phone mode on the recovery attempt so we don't 429→rotate again.
        mimicPhone: false,
      });
    } else {
      throw err;
    }
  }

  updateJob(id, {
    status: result.status,
    message: result.message,
    result,
    finishedAt: new Date().toISOString(),
  });

  if (result.status === 'success') {
    saveAccountCredentials(email, target, password, 'camoufox');
    await afterAccountLoginSuccess((step, message) => jobLog(id, step, message));
    broadcast('proxy', proxyStatusPayload());
    if (result.hasToken) {
      notifyAccountTokenUpdated(email, target, { reason: 'login' }).catch(() => {});
    }
  }

  broadcastAccounts();
  } finally {
    const waiting = getQueueStatus().waiting || 0;
    endLoginProxyExclusive({ queueWaiting: waiting });
  }

}



app.listen(PORT, async () => {
  await runStartupMigrations();
  ensureEnvWebhook();
  await ensureCamoufoxInstalled();
  const camoufox = await isCamoufoxAvailable();
  if (!camoufox) {
    setSmartRefreshEnabled(false);
    console.warn('[camoufox] Binary not available — smart refresh OFF. Check container logs for download errors.');
  } else {
    syncSmartRefreshRuntime(smartRefreshRuntime);
  }
  const proxy = getProxyStatus();
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`Engine: Camoufox (all operations)`);
  if (proxy.enabled && proxy.configured) {
    try {
      const p = parseProxyUrl(getProxyUrl());
      console.log(`Proxy: ON ${p.protocol}://${p.host}:${p.port}`);
      if (/fxdx\.in|iproxy/i.test(p.host)) {
        const prefer = getProxyPreferMode();
        if ((isIproxyWifiSplitMode() || isMobileRelayProxy()) && !getProxyHttpUrl()) {
          console.warn('[proxy] Mobile relay — set PROXY_HTTP_URL=http://host:16857:user:pass on Coolify');
        } else if (isMobileRelayProxy()) {
          console.log('[proxy] iProxy mobile relay — SOCKS5 :17539 default for Camoufox');
        } else if (prefer === 'http' && getProxyHttpUrl()) {
          console.log('[proxy] PROXY_PREFER=http — HTTP :16857 with SOCKS fallback');
        } else {
          console.log('[proxy] PROXY_PREFER=auto — tries SOCKS relay first, HTTP fallback if set');
        }
      }
    } catch {
      console.log(`Proxy: ON ${proxy.host}:${proxy.port}`);
    }
  } else {
    console.log('Proxy: OFF');
  }
  console.log(`Smart refresh: ${isSmartRefreshEnabled() ? 'ON' : 'OFF'}`);
  if (!camoufox) console.warn('Run: npm run camoufox:fetch');
  else console.log('Camoufox: ready');
  // Drop any stale relay left from a previous crash before first job.
  await closeLocalProxy().catch(() => {});
});
