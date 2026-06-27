import { Router } from 'express';
import { TARGETS } from './microsoft-login.js';
import { listTokenRecords, getTokenRecord } from './account-tokens.js';
import { waitForJobCompletion } from './refresh-job.js';
import { isApiKeyConfigured } from './api-auth.js';

export function createApiV1Router(deps) {
  const { queueRefreshJob, getJob, getQueueStatus, jobStats } = deps;

  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      api: 'v1',
      auth: isApiKeyConfigured(),
      queue: getQueueStatus(),
      jobs: jobStats(),
    });
  });

  /** GET /api/v1/tokens — all accounts with token metadata */
  router.get('/tokens', async (req, res) => {
    try {
      const target = String(req.query.target || 'outlook');
      if (!TARGETS[target]) {
        return res.status(400).json({ ok: false, error: `Invalid target. Use: ${Object.keys(TARGETS).join(', ')}` });
      }

      const tokensOnly = req.query.tokens_only !== '0' && req.query.tokens_only !== 'false';
      const includeRefreshToken =
        req.query.include_refresh_token === '1' || req.query.include_refresh_token === 'true';

      const accounts = await listTokenRecords({
        target,
        group: String(req.query.group || ''),
        health: String(req.query.health || ''),
        tokensOnly,
        includeRefreshToken,
      });

      res.json({ ok: true, count: accounts.length, accounts });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** GET /api/v1/accounts/:email — single account token record */
  router.get('/accounts/:email', async (req, res) => {
    try {
      const email = decodeEmail(req.params.email);
      const target = String(req.query.target || 'outlook');
      if (!TARGETS[target]) {
        return res.status(400).json({ ok: false, error: 'Invalid target.' });
      }

      const includeRefreshToken =
        req.query.include_refresh_token === '1' || req.query.include_refresh_token === 'true';

      const account = await getTokenRecord(email, target, { includeRefreshToken });
      if (!account) {
        return res.status(404).json({ ok: false, error: 'Account not found.' });
      }

      res.json({ ok: true, account });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /api/v1/accounts/:email/refresh
   * Body/query: target=outlook, wait=false, timeout_ms=120000
   */
  router.post('/accounts/:email/refresh', async (req, res) => {
    try {
      const email = decodeEmail(req.params.email);
      const target = String(req.body?.target || req.query.target || 'outlook');
      const wait =
        req.body?.wait === true ||
        req.query.wait === '1' ||
        req.query.wait === 'true';
      const timeoutMs = Math.min(
        Number(req.body?.timeout_ms || req.query.timeout_ms || 120_000),
        300_000
      );

      if (!TARGETS[target]) {
        return res.status(400).json({ ok: false, error: 'Invalid target.' });
      }

      const account = await getTokenRecord(email, target);
      if (!account) {
        return res.status(404).json({ ok: false, error: 'Account not found.' });
      }
      if (!account.session_valid) {
        return res.status(400).json({
          ok: false,
          error: 'No valid session — log in or re-login from the dashboard first.',
        });
      }

      const queued = queueRefreshJob(email, target);
      const statusCode = queued.duplicate ? 202 : 202;

      if (!wait) {
        return res.status(statusCode).json({
          ok: true,
          email,
          target,
          job_id: queued.id,
          status: queued.status,
          duplicate: queued.duplicate,
          message: queued.message,
          poll_url: `/api/v1/jobs/${queued.id}`,
        });
      }

      const finished = await waitForJobCompletion(getJob, queued.id, { timeoutMs });
      const updated = await getTokenRecord(email, target);

      if (finished.status !== 'success') {
        return res.status(422).json({
          ok: false,
          email,
          target,
          job_id: queued.id,
          status: finished.status,
          message: finished.message,
          account: updated,
        });
      }

      res.json({
        ok: true,
        email,
        target,
        job_id: queued.id,
        status: finished.status,
        message: finished.message,
        account: updated,
      });
    } catch (err) {
      if (err.code === 'TIMEOUT') {
        return res.status(504).json({ ok: false, error: err.message });
      }
      if (err.code === 'INVALID_TARGET') {
        return res.status(400).json({ ok: false, error: err.message });
      }
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** GET /api/v1/jobs/:id — poll refresh/login job status */
  router.get('/jobs/:id', (req, res) => {
    const job = getJob(req.params.id, { full: false });
    if (!job) {
      return res.status(404).json({ ok: false, error: 'Job not found.' });
    }
    res.json({ ok: true, job });
  });

  return router;
}

function decodeEmail(raw) {
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return String(raw || '').trim();
  }
}
