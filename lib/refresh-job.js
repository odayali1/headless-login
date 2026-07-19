import { TARGETS } from './microsoft-login.js';
import { withCamoufoxSlot, getCamoufoxPoolStatus } from './camoufox-pool.js';
import { isHybridProxyEnabled } from './settings.js';
import { isLoginProxyExclusive } from './proxy.js';
import { tryBrowserlessAccountRefresh } from './account-actions.js';

/** Cap concurrent manual refresh jobs so they don't stampede the proxy one-at-a-time via overload. */
const REFRESH_JOB_PARALLEL = Math.min(
  8,
  Math.max(2, Number(process.env.REFRESH_JOB_PARALLEL || 6) || 6)
);
let refreshJobsRunning = 0;
/** @type {Array<() => void>} */
const refreshJobWaiters = [];

async function withRefreshJobSlot(fn) {
  while (refreshJobsRunning >= REFRESH_JOB_PARALLEL) {
    await new Promise((resolve) => refreshJobWaiters.push(resolve));
  }
  refreshJobsRunning += 1;
  try {
    return await fn();
  } finally {
    refreshJobsRunning = Math.max(0, refreshJobsRunning - 1);
    const next = refreshJobWaiters.shift();
    if (next) next();
  }
}

export function createRefreshJobQueue({
  createJob,
  updateJob,
  jobLog,
  enqueueLogin: _enqueueLoginIgnored,
  beforeAccountRefresh,
  refreshAccountToken,
  broadcastAccounts,
  findActiveJob,
}) {
  return function queueRefreshJob(email, target) {
    if (!TARGETS[target]) {
      const err = new Error(`Invalid target: ${target}`);
      err.code = 'INVALID_TARGET';
      throw err;
    }

    const existing = findActiveJob(email, target, { jobKind: 'refresh' });
    if (existing) {
      return {
        id: existing.id,
        status: existing.status,
        duplicate: true,
        message: 'Refresh already queued or running for this account.',
      };
    }

    const id = createJob(email, target, 'camoufox', 'Refreshing token…', {
      cancelPrevious: true,
      jobKind: 'refresh',
    });

    const pool = getCamoufoxPoolStatus();
    const hybrid = isHybridProxyEnabled();
    const log = (step, message) => jobLog(id, step, message);

    /**
     * 1) HTTP/Loki immediately — no Camoufox slot, no login-queue wait (hybrid = residential).
     * 2) Camoufox only if needed and login is not owning the mobile IP.
     */
    const run = async () => {
      try {
        updateJob(id, { status: 'running', message: 'Refreshing LiveProfileCard token…' });
        await beforeAccountRefresh(log);

        const browserless = await tryBrowserlessAccountRefresh(email, target, {
          jobId: id,
          onProgress: ({ step, message }) => log(step, message),
          lokiOnly: false,
        });

        if (browserless.fromCache || (browserless.success && browserless.result)) {
          const result = browserless.result || { status: 'success', via: 'cache' };
          updateJob(id, {
            status: 'success',
            message: 'Token refreshed',
            result,
            finishedAt: new Date().toISOString(),
          });
          broadcastAccounts();
          return;
        }

        if (browserless.deferred || browserless.skippedHttp || browserless.deferredCookie) {
          updateJob(id, {
            status: 'cancelled',
            message: isLoginProxyExclusive()
              ? hybrid
                ? 'Login in progress — Camoufox deferred (hybrid HTTP/cookie already tried)'
                : 'Login in progress — cookie/Camoufox deferred'
              : 'Refresh deferred',
            finishedAt: new Date().toISOString(),
          });
          broadcastAccounts();
          return;
        }

        // Needs Camoufox — wait until login is not exclusive.
        if (isLoginProxyExclusive()) {
          updateJob(id, {
            status: 'cancelled',
            message: 'Login in progress — Camoufox refresh deferred',
            finishedAt: new Date().toISOString(),
          });
          broadcastAccounts();
          return;
        }

        await withCamoufoxSlot(
          async () => {
            if (isLoginProxyExclusive()) {
              updateJob(id, {
                status: 'cancelled',
                message: 'Login in progress — Camoufox refresh deferred',
                finishedAt: new Date().toISOString(),
              });
              broadcastAccounts();
              return;
            }
            updateJob(id, { status: 'running', message: 'Camoufox session refresh…' });
            const result = await refreshAccountToken(email, target, {
              engine: 'camoufox',
              jobId: id,
              skipBrowserless: true,
              onProgress: ({ step, message }) => log(step, message),
            });
            updateJob(id, {
              status: 'success',
              message: 'Token refreshed',
              result,
              finishedAt: new Date().toISOString(),
            });
            broadcastAccounts();
          },
          { priority: true }
        );
      } catch (err) {
        const deferred =
          err?.code === 'REFRESH_DEFERRED' || /refresh deferred|login in progress/i.test(err?.message || '');
        updateJob(id, {
          status: deferred ? 'cancelled' : 'failed',
          message: err.message,
          finishedAt: new Date().toISOString(),
        });
        broadcastAccounts();
      }
    };

    Promise.resolve()
      .then(() => withRefreshJobSlot(run))
      .catch((err) => {
        updateJob(id, {
          status: 'failed',
          message: err.message,
          finishedAt: new Date().toISOString(),
        });
        broadcastAccounts();
      });

    return {
      id,
      status: 'queued',
      duplicate: false,
      message: hybrid
        ? `Refresh queued (up to ${REFRESH_JOB_PARALLEL} parallel; hybrid Loki + cookie).`
        : `Refresh queued (up to ${REFRESH_JOB_PARALLEL} parallel; Camoufox pool ${pool.running}/${pool.max} if needed).`,
    };
  };
}

const ACTIVE = new Set(['queued', 'starting', 'running']);

export async function waitForJobCompletion(getJob, jobId, { timeoutMs = 120_000, pollMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = getJob(jobId, { full: true });
    if (!job) {
      const err = new Error('Job not found.');
      err.code = 'JOB_NOT_FOUND';
      throw err;
    }
    if (!ACTIVE.has(job.status)) {
      return job;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const err = new Error(`Refresh timed out after ${Math.round(timeoutMs / 1000)}s.`);
  err.code = 'TIMEOUT';
  throw err;
}
