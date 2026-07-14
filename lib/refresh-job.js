import { TARGETS } from './microsoft-login.js';
import { withCamoufoxSlot, getCamoufoxPoolStatus } from './camoufox-pool.js';

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
    // Shared Camoufox pool with smart-refresh — NOT the serial login queue.
    // Priority so a manual double-click Refresh can run next to (or ahead of) smart backlog.
    withCamoufoxSlot(
      async () => {
        try {
          updateJob(id, { status: 'running', message: 'Refreshing LiveProfileCard token…' });
          await beforeAccountRefresh((step, message) => jobLog(id, step, message));
          const result = await refreshAccountToken(email, target, {
            engine: 'camoufox',
            jobId: id,
            onProgress: ({ step, message }) => jobLog(id, step, message),
          });
          updateJob(id, {
            status: 'success',
            message: 'Token refreshed',
            result,
            finishedAt: new Date().toISOString(),
          });
          broadcastAccounts();
        } catch (err) {
          updateJob(id, {
            status: 'failed',
            message: err.message,
            finishedAt: new Date().toISOString(),
          });
          broadcastAccounts();
        }
      },
      { priority: true }
    ).catch((err) => {
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
      message: `Refresh queued (Camoufox pool ${pool.running}/${pool.max}).`,
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
