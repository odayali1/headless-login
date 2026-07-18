import { TARGETS } from './microsoft-login.js';
import { withCamoufoxSlot, getCamoufoxPoolStatus } from './camoufox-pool.js';
import { isHybridProxyEnabled } from './settings.js';
import { isLoginProxyExclusive } from './proxy.js';
import { tryBrowserlessAccountRefresh } from './account-actions.js';

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
          lokiOnly: isLoginProxyExclusive() && hybrid,
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
              ? 'Login in progress — cookie/Camoufox deferred (hybrid Loki already tried)'
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
      .then(run)
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
        ? 'Refresh started (hybrid Loki — independent of login queue).'
        : `Refresh started (HTTP first; Camoufox pool ${pool.running}/${pool.max} if needed).`,
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
