import { TARGETS } from './microsoft-login.js';

export function createRefreshJobQueue({
  createJob,
  updateJob,
  jobLog,
  enqueueLogin,
  beforeAccountLogin,
  afterAccountLoginSuccess,
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

    enqueueLogin(
      async () => {
        try {
          updateJob(id, { status: 'running', message: 'Refreshing LiveProfileCard token…' });
          await beforeAccountLogin((step, message) => jobLog(id, step, message));
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
          await afterAccountLoginSuccess?.();
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
      { jobId: id, label: `${email} refresh` }
    );

    return { id, status: 'queued', duplicate: false, message: 'Refresh queued.' };
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
