import { Router } from 'express';
import { listProxyPresets, getProxyPresetById, parseProxyUrl } from '../settings.js';
import { TRUECALLER_DIR } from './config.js';
import {
  deleteAccount,
  getParallel,
  getProxyPresetId,
  getProxyUrl,
  listTokenAccounts,
  setProxyPresetId,
  setProxyUrl,
  upsertAccount,
} from './store.js';
import { signupMicrosoftAccount } from './signup.js';
import { getTokenPayload, searchWithAccount } from './search.js';
import { collectEmails, eligiblePage, eligibleStats } from './eligible.js';
import {
  cancelQueue,
  getJob,
  jobLog,
  listJobs,
  pauseQueue,
  queueStatus,
  setBatchRunner,
  setParallel,
  startBatch,
  subscribe,
  summarize,
  updateJob,
} from './jobs.js';

async function runTruecallerJob(email, job) {
  try {
    jobLog(job.id, 'start', 'Isolated Truecaller signup — Outlook profiles will not be written.');
    const result = await signupMicrosoftAccount(email, {
      jobId: job.id,
      log: (step, message) => jobLog(job.id, step, message),
    });
    updateJob(job.id, {
      status: 'success',
      message: job.kind === 'refresh' ? 'Truecaller token refreshed' : 'Truecaller token captured',
      result: {
        hasToken: !!result.jwt,
        name: result.name,
        tcEmail: result.tcEmail,
        countryCode: result.countryCode,
      },
    });
  } catch (err) {
    upsertAccount(email, { status: 'failed', last_error: err.message });
    updateJob(job.id, { status: 'failed', message: err.message });
    throw err;
  }
}

setBatchRunner(runTruecallerJob);

function proxyHost(proxy) {
  if (!proxy) return null;
  try {
    const u = new URL(proxy.includes('://') ? proxy : `http://${proxy}`);
    return `${u.hostname}:${u.port || ''}`;
  } catch {
    return 'set';
  }
}

function settingsPayload() {
  const proxy = getProxyUrl();
  return {
    ok: true,
    proxyConfigured: !!proxy,
    proxyUrl: proxy,
    proxyHost: proxyHost(proxy),
    proxyPreset: getProxyPresetId() || '',
    presets: listProxyPresets(),
    parallel: getParallel(),
    queue: queueStatus(),
  };
}

function applyProxyPreset(id) {
  const preset = getProxyPresetById(id);
  if (!preset) throw new Error(`Unknown proxy preset: ${id}`);
  if (preset.kind === 'aws-api') {
    throw new Error(
      'AWS API / FireProx is Outlook-only. Truecaller needs an HTTP or SOCKS proxy (residential or datacenter).'
    );
  }
  setProxyUrl(preset.url);
  setProxyPresetId(preset.id);
  return preset.id;
}

function queueFromBody(req, defaultScope) {
  const scope = String(req.body?.scope || defaultScope || 'selected').trim() || 'selected';
  const emails = Array.isArray(req.body?.emails)
    ? req.body.emails
    : req.body?.email
      ? [req.body.email]
      : [];
  const group = String(req.body?.group || '').trim();
  const search = String(req.body?.search || req.body?.q || '').trim();
  const limit = Number(req.body?.limit) || 0;
  return { scope, emails, group, search, limit };
}

export function createTruecallerRouter() {
  const router = Router();

  router.get('/status', (_req, res) => {
    const st = settingsPayload();
    res.json({
      ok: true,
      isolated: true,
      dataDir: TRUECALLER_DIR,
      proxyConfigured: st.proxyConfigured,
      proxyHost: st.proxyHost,
      proxyPreset: st.proxyPreset,
      parallel: st.parallel,
      queue: st.queue,
      notes: [
        'Never writes Outlook profiles or cookies.',
        'Never uses the main Outlook/mobile proxy or login queue.',
        'If Microsoft asks for a password or MFA, signup aborts.',
        'Do not click accounts one by one — use Sign up all matching / Refresh expired.',
        'Thunderbird IMAP tokens (client 9e5f94bc-…) cannot sign in to Truecaller.',
      ],
    });
  });

  router.get('/settings', (_req, res) => {
    res.json(settingsPayload());
  });

  router.post('/settings', (req, res) => {
    try {
      const presetId = String(req.body?.presetId || req.body?.proxyPreset || '').trim();
      const url = String(req.body?.proxyUrl || req.body?.proxy_url || '').trim();
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'parallel')) {
        setParallel(req.body.parallel);
      }
      if (presetId) {
        applyProxyPreset(presetId);
      } else if (Object.prototype.hasOwnProperty.call(req.body || {}, 'proxyUrl') || Object.prototype.hasOwnProperty.call(req.body || {}, 'proxy_url')) {
        if (url) parseProxyUrl(url);
        setProxyUrl(url);
        setProxyPresetId('');
      }
      res.json(settingsPayload());
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  router.get('/stats', async (req, res) => {
    try {
      const stats = await eligibleStats({
        group: String(req.query.group || '').trim(),
        search: String(req.query.q || req.query.search || '').trim(),
      });
      res.json({ ok: true, ...stats, queue: queueStatus() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/eligible', async (req, res) => {
    try {
      const page = await eligiblePage({
        page: req.query.page,
        limit: req.query.limit,
        group: String(req.query.group || '').trim(),
        search: String(req.query.q || req.query.search || '').trim(),
        tcStatus: String(req.query.status || req.query.tcStatus || '').trim(),
      });
      const stats = await eligibleStats({
        group: page.group,
        search: page.search,
      });
      res.json({ ok: true, ...page, stats, queue: queueStatus() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/accounts', (req, res) => {
    const q = String(req.query.q || req.query.search || '').trim();
    const limit = Number(req.query.limit) || 80;
    res.json({ ok: true, accounts: listTokenAccounts({ q, limit }) });
  });

  router.get('/accounts/:email/token', (req, res) => {
    const payload = getTokenPayload(decodeURIComponent(req.params.email));
    if (!payload) return res.status(404).json({ ok: false, error: 'No Truecaller token for this email.' });
    res.json({ ok: true, ...payload });
  });

  router.delete('/accounts/:email', (req, res) => {
    const email = decodeURIComponent(req.params.email);
    deleteAccount(email);
    res.json({ ok: true, email, note: 'Removed Truecaller record only. Outlook profile was not touched.' });
  });

  router.get('/jobs', (_req, res) => {
    res.json({ ok: true, jobs: listJobs({ logs: true }), queue: queueStatus() });
  });

  router.get('/jobs/:id', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ ok: false, error: 'Job not found.' });
    res.json({ ok: true, job: summarize(job, { logs: true }) });
  });

  router.get('/queue', (_req, res) => {
    res.json({ ok: true, queue: queueStatus() });
  });

  router.post('/queue/pause', (req, res) => {
    const paused = req.body?.paused !== false && req.body?.paused !== 'false';
    res.json({ ok: true, queue: pauseQueue(paused) });
  });

  router.post('/queue/resume', (_req, res) => {
    res.json({ ok: true, queue: pauseQueue(false) });
  });

  router.post('/queue/cancel', (_req, res) => {
    res.json({ ok: true, queue: cancelQueue() });
  });

  router.post('/queue/parallel', (req, res) => {
    const n = setParallel(req.body?.parallel ?? req.body?.n);
    res.json({ ok: true, parallel: n, queue: queueStatus() });
  });

  router.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write('event: hello\ndata: {"ok":true}\n\n');
    res.write(`event: queue\ndata: ${JSON.stringify(queueStatus())}\n\n`);
    res.write(`event: jobs\ndata: ${JSON.stringify({ jobs: listJobs({ logs: true }) })}\n\n`);
    const unsub = subscribe(res);
    req.on('close', unsub);
  });

  async function queueScope(req, res, kind, defaultScope) {
    if (!getProxyUrl()) {
      return res.status(400).json({ ok: false, error: 'Set the Truecaller proxy first (preset or custom URL).' });
    }
    const parsed = queueFromBody(req, defaultScope);
    if (parsed.scope === 'preview' || req.body?.preview) {
      const emails = await collectEmails(parsed);
      return res.json({
        ok: true,
        preview: true,
        count: emails.length,
        sample: emails.slice(0, 8),
        scope: parsed.scope,
      });
    }
    const emails = await collectEmails(parsed);
    if (!emails.length) {
      return res.status(400).json({ ok: false, error: 'No matching accounts to queue.' });
    }
    const queue = startBatch(emails, kind);
    res.json({
      ok: true,
      queued: emails.length,
      scope: parsed.scope,
      queue,
      note: 'Isolated Truecaller queue — Outlook profiles and the main login queue are not used.',
    });
  }

  router.post('/signup', (req, res) => queueScope(req, res, 'signup', 'selected'));
  router.post('/refresh', (req, res) => queueScope(req, res, 'refresh', 'selected'));

  router.post('/search', async (req, res) => {
    try {
      const email = String(req.body?.email || '').trim();
      const country = String(req.body?.country || req.body?.countryCode || '').trim();
      const number = String(req.body?.number || req.body?.phone || '').trim();
      if (!email || !number) return res.status(400).json({ ok: false, error: 'email and number are required.' });
      const result = await searchWithAccount(email, country, number);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  return router;
}
