import express from 'express';

import path from 'node:path';

import { fileURLToPath } from 'node:url';

import { v4 as uuidv4 } from 'uuid';

import { isCamoufoxAvailable } from './lib/camoufox-browser.js';

import { loginMicrosoft, TARGETS } from './lib/microsoft-login.js';

import { listAccounts } from './lib/accounts.js';
import { computeAccountStats } from './lib/account-health.js';
import { exportCsv } from './lib/account-export.js';
import { initSmartRefresh, getSmartRefreshStatus, isSmartRefreshEnabled, setSmartRefreshEnabled } from './lib/smart-refresh.js';

import { markProfileFailed } from './lib/profile.js';

import { refreshAccountToken } from './lib/account-actions.js';

import { checkAccountSoftban } from './lib/softban-check.js';

import { loadProfile } from './lib/profile.js';

import {
  saveAccountCredentials,
  getAccountPassword,
  deleteAccountCredentials,
  setAccountGroup,
  listGroups,
} from './lib/db.js';

import { runStartupMigrations } from './lib/migrate.js';

import { batchDelayMs, sleep } from './lib/anti-detect.js';

import { beforeAccountLogin, afterAccountLoginSuccess, rotateProxyIp } from './lib/proxy.js';

import { getProxyStatus, setProxyEnabled } from './lib/settings.js';

import { resolveEngine } from './lib/browser.js';

import { createJobsStore } from './lib/jobs-store.js';

import { createLoginQueue } from './lib/login-queue.js';

import { requireApiKey } from './lib/api-auth.js';

import { createApiV1Router } from './lib/api-v1.js';

import { createRefreshJobQueue } from './lib/refresh-job.js';

import { firefoxProfileDir } from './lib/camoufox-browser.js';



const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

const PORT = process.env.PORT || 3847;



app.use(express.json({ limit: '1mb' }));

app.use(express.static(path.join(__dirname, 'public')));

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

const { enqueue: enqueueLogin, getStatus: getQueueStatus } = loginQueue;



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



app.get('/api/proxy', (_req, res) => {

  res.json(getProxyStatus());

});



app.post('/api/proxy/toggle', (req, res) => {

  const enabled = req.body?.enabled;

  setProxyEnabled(enabled !== false);

  const status = getProxyStatus();

  broadcast('proxy', status);

  res.json(status);

});



app.post('/api/proxy/rotate', async (_req, res) => {

  try {

    await rotateProxyIp((step, message) => console.log(`[${step}]`, message));

    const status = getProxyStatus();

    broadcast('proxy', status);

    res.json(status);

  } catch (err) {

    res.status(500).json({ error: err.message });

  }

});



function broadcastAccounts() {

  listAccounts()

    .then((accounts) => {
      broadcast('accounts', accounts);
      broadcast('account-stats', computeAccountStats(accounts));
    })

    .catch(() => {});

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



app.post('/api/smart-refresh/toggle', (req, res) => {

  const enabled = req.body?.enabled !== false;

  setSmartRefreshEnabled(enabled);

  res.json(getSmartRefreshStatus());

});



app.get('/api/accounts', async (_req, res) => {

  res.json(await listAccounts());

});



app.get('/api/accounts/:email/:target/token', async (req, res) => {

  const accounts = await listAccounts();

  const acc = accounts.find(

    (a) => a.email === req.params.email && a.target === req.params.target

  );

  if (!acc?.accessToken) {

    return res.status(404).json({ error: 'No access token for this account.' });

  }

  res.json({

    email: acc.email,

    target: acc.target,

    access_token: acc.accessToken,

    expires_at: acc.tokenExpiresAt,

  });

});



app.delete('/api/accounts/:email/:target', async (req, res) => {

  const { email, target } = req.params;

  const fs = await import('node:fs/promises');

  const { profilePath } = await import('./lib/profile.js');

  try {

    await fs.unlink(profilePath(email, target));

  } catch {

    // profile may not exist

  }

  try {

    await fs.rm(firefoxProfileDir(email, target), { recursive: true, force: true });

  } catch {

    // firefox profile may not exist

  }

  deleteAccountCredentials(email, target);

  cancelQueued({ email, target });

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

  beforeAccountLogin,

  afterAccountLoginSuccess,

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
  const { skipBackupEmail = true } = req.body || {};

  if (!TARGETS[target]) {

    return res.status(400).json({ error: 'Invalid target.' });

  }



  const stored = getAccountPassword(email, target);

  if (!stored) {

    return res.status(400).json({ error: 'No saved password — log in once from the form.' });

  }



  const id = createJob(email, target, 'camoufox', 'Re-login queued…');

  res.json({ id, status: 'queued' });



  enqueueLogin(() =>

    runJob(id, email, stored, target, 'camoufox', true, { forceFresh: true, skipBackupEmail }).catch(async (err) => {

      await markProfileFailed(email, target, err.message).catch(() => {});

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

    const saved = await loadProfile(email, target);

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

app.post('/api/groups/:group/action', async (req, res) => {
  const group = String(req.params.group || '').trim();
  const { action, target = 'outlook' } = req.body || {};
  if (!group) return res.status(400).json({ error: 'Group is required.' });
  if (!['refresh', 'relogin', 'check-softban', 'delete'].includes(action)) {
    return res.status(400).json({ error: 'Use action: refresh, relogin, check-softban, delete' });
  }

  const accounts = (await listAccounts()).filter(
    (a) => (a.group || '').toLowerCase() === group.toLowerCase() && (!target || a.target === target)
  );
  if (accounts.length === 0) return res.status(404).json({ error: `No accounts in group "${group}"` });

  const accepted = [];
  for (const acc of accounts) {
    if (action === 'delete') {
      deleteAccountCredentials(acc.email, acc.target);
      cancelQueued({ email: acc.email, target: acc.target });
      accepted.push({ email: acc.email, target: acc.target, status: 'deleted' });
      continue;
    }
    if (action === 'refresh') {
      const id = createJob(acc.email, acc.target, 'camoufox', `Group refresh queued (${group})…`);
      accepted.push({ email: acc.email, target: acc.target, jobId: id });
      enqueueLogin(async () => {
        try {
          updateJob(id, { status: 'running', message: 'Refreshing LiveProfileCard token…' });
          await beforeAccountLogin((step, message) => jobLog(id, step, message));
          const result = await refreshAccountToken(acc.email, acc.target, {
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
      }, { jobId: id, label: `${acc.email} group refresh` });
      continue;
    }

    if (action === 'relogin') {
      const stored = getAccountPassword(acc.email, acc.target);
      if (!stored) continue;
      const id = createJob(acc.email, acc.target, 'camoufox', `Group re-login queued (${group})…`);
      accepted.push({ email: acc.email, target: acc.target, jobId: id });
      enqueueLogin(() =>
        runJob(id, acc.email, stored, acc.target, 'camoufox', true, { forceFresh: true, skipBackupEmail: true }).catch(async (err) => {
          await markProfileFailed(acc.email, acc.target, err.message).catch(() => {});
          updateJob(id, { status: 'failed', message: err.message, finishedAt: new Date().toISOString() });
          broadcastAccounts();
        })
      , { jobId: id, label: `${acc.email} group re-login` });
      continue;
    }

    if (action === 'check-softban') {
      const id = createJob(acc.email, acc.target, 'camoufox', `Softban check queued (${group})…`);
      accepted.push({ email: acc.email, target: acc.target, jobId: id });
      enqueueLogin(async () => {
        try {
          updateJob(id, { status: 'running', message: 'Checking softban status…' });
          const saved = await loadProfile(acc.email, acc.target);
          if (!saved?.state) throw new Error('No saved profile — log in first.');
          const result = await checkAccountSoftban(acc.email, acc.target, saved.state.tokens);
          updateJob(id, { status: 'success', message: result.message || 'Softban check done', result, finishedAt: new Date().toISOString() });
          broadcastAccounts();
        } catch (err) {
          updateJob(id, { status: 'failed', message: err.message, finishedAt: new Date().toISOString() });
          broadcastAccounts();
        }
      }, { jobId: id, label: `${acc.email} softban check` });
    }
  }

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

  res.json({ cancelled, stats: jobStats() });

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

  Promise.all([listAccounts()]).then(([accounts]) => {

    res.write(

      `event: connected\ndata: ${JSON.stringify({ jobs: listSummaries({ limit: 100 }), jobStats: jobStats(), queue: getQueueStatus(), accounts, accountStats: computeAccountStats(accounts), smartRefresh: getSmartRefreshStatus(), proxy: getProxyStatus() })}\n\n`

    );

  });



  req.on('close', () => sseClients.delete(res));

});



app.post('/api/login', async (req, res) => {

  const { email, password, target = 'outlook', headless = true, group = '', skipBackupEmail = true } = req.body || {};



  if (!email?.trim() || !password) {

    return res.status(400).json({ error: 'Email and password are required.' });

  }

  if (!TARGETS[target]) {

    return res.status(400).json({ error: `Invalid target. Use: ${Object.keys(TARGETS).join(', ')}` });

  }



  const id = uuidv4();

  const job = registerJob({

    id,

    email: email.trim(),

    target,

    engine: 'camoufox',

    status: 'queued',

    message: 'Waiting to start…',

  });

  broadcast('job', summarize(job, { logs: true }));

  broadcast('job-stats', jobStats());

  res.json({ id, status: 'queued' });



  saveAccountCredentials(email.trim(), target, password, 'camoufox');
  if (group) setAccountGroup(email.trim(), target, group);



  enqueueLogin(() =>

    runJob(id, email.trim(), password, target, 'camoufox', headless, { skipBackupEmail }).catch(async (err) => {

      await markProfileFailed(email.trim(), target, err.message).catch(() => {});

      updateJob(id, { status: 'failed', message: err.message, error: err.stack });

      broadcastAccounts();

    })

  , { jobId: id, label: `${email.trim()} login` });

});



app.post('/api/login/batch', async (req, res) => {

  const { accounts = [], target = 'outlook', headless = true, group = '', skipBackupEmail = true } = req.body || {};

  if (!Array.isArray(accounts) || accounts.length === 0) {

    return res.status(400).json({ error: 'Provide accounts: [{ email, password }, ...]' });

  }



  const ids = [];

  const validAccounts = accounts.filter((a) => a.email && a.password);

  const batchId = uuidv4();

  const batchSummaries = [];

  for (const acc of validAccounts) {

    cancelQueued({ email: acc.email.trim(), target });

    const id = uuidv4();

    const job = registerJob({

      id,

      email: acc.email.trim(),

      target,

      engine: 'camoufox',

      status: 'queued',

      message: 'Queued in batch (one at a time)…',

      batchId,

    });

    ids.push(id);

    batchSummaries.push(summarize(job));

  }

  if (batchSummaries.length) {

    broadcastBatch(batchId, batchSummaries);

  }

  res.json({ ids, count: ids.length, batchId });



  for (const acc of validAccounts) {

    saveAccountCredentials(acc.email.trim(), target, acc.password, 'camoufox');
    if (group) setAccountGroup(acc.email.trim(), target, group);

  }



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

        await runJob(id, acc.email.trim(), acc.password, target, 'camoufox', headless, { skipBackupEmail });

      } catch (err) {

        await markProfileFailed(acc.email.trim(), target, err.message).catch(() => {});

        updateJob(id, { status: 'failed', message: err.message, finishedAt: new Date().toISOString() });

        broadcastAccounts();

      }

    }, { jobId: id, label: `${acc.email.trim()} batch` });

  }

});



async function runJob(id, email, password, target, engine, headless, { forceFresh = false, skipBackupEmail = true } = {}) {

  if (isCancelled(id)) return;

  if (!getAccountPassword(email, target)) {

    updateJob(id, { status: 'cancelled', message: 'Account removed — job skipped.', finishedAt: new Date().toISOString() });

    return;

  }

  updateJob(id, { status: 'starting', message: 'Starting Camoufox…' });



  await beforeAccountLogin((step, message) => jobLog(id, step, message));



  updateJob(id, { status: 'running', message: 'Browser ready — logging in…' });



  const result = await loginMicrosoft({

    email,

    password,

    target,

    engine: resolveEngine(engine),

    headless,

    jobId: id,

    forceFresh,

    skipBackupEmail,

    onEmailRetry: async (attempt) => {
      if (attempt >= 2) {
        jobLog(id, 'proxy', 'Email lookup failed — rotating proxy and retrying…');
        await rotateProxyIp((step, message) => jobLog(id, step, message)).catch(() => {});
        broadcast('proxy', getProxyStatus());
      }
    },

    onProgress: ({ step, message, ...extra }) => jobLog(id, step, message),

  });



  updateJob(id, {

    status: result.status,

    message: result.message,

    result,

    finishedAt: new Date().toISOString(),

  });



  if (result.status === 'success') {

    saveAccountCredentials(email, target, password, 'camoufox');

    await afterAccountLoginSuccess();

    broadcast('proxy', getProxyStatus());

  }

  broadcastAccounts();

}



app.listen(PORT, async () => {
  await runStartupMigrations();
  initSmartRefresh({ enqueue: enqueueLogin, log: (msg) => console.log(msg), onRefreshed: broadcastAccounts });
  const proxy = getProxyStatus();
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`Engine: Camoufox (all operations)`);
  console.log(`Proxy: ${proxy.enabled ? `ON ${proxy.host}:${proxy.port}` : 'OFF'}`);
  console.log(`Smart refresh: ${isSmartRefreshEnabled() ? 'ON' : 'OFF'}`);
  const camoufox = await isCamoufoxAvailable();
  if (!camoufox) console.warn('Run: npm run camoufox:fetch');
});
