const MAX_JOBS = 3000;
const MAX_LOG_LINES = 150;
const ACTIVE_STATUSES = new Set(['queued', 'starting', 'running']);

export function createJobsStore({ broadcast }) {
  const jobs = new Map();
  const accountIndex = new Map();

  function accountKey(email, target) {
    return `${String(email).toLowerCase()}::${target}`;
  }

  function addToIndex(job) {
    const key = accountKey(job.email, job.target);
    let ids = accountIndex.get(key) || [];
    ids = [job.id, ...ids.filter((i) => i !== job.id)];
    accountIndex.set(key, ids.slice(0, 50));
  }

  function summarize(job, { logs = false, screenshot = false } = {}) {
    const active = ACTIVE_STATUSES.has(job.status);
    const out = {
      id: job.id,
      email: job.email,
      target: job.target,
      engine: job.engine,
      status: job.status,
      message: job.message,
      batchId: job.batchId || null,
      batchGroup: job.batchGroup || null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt || null,
      logCount: job.logs?.length || 0,
    };

    if (job.result) {
      out.result = {
        profileFile: job.result.profileFile,
        cookieCount: job.result.cookieCount,
        hasToken: job.result.hasToken,
        reusedProfile: job.result.reusedProfile,
      };
      if (screenshot) out.result.screenshot = job.result.screenshot;
    }

    if (logs || active) {
      out.logs = job.logs || [];
    } else if (job.logs?.length) {
      out.lastLog = job.logs[job.logs.length - 1];
    }

    return out;
  }

  function stats() {
    const s = {
      queued: 0,
      starting: 0,
      running: 0,
      success: 0,
      failed: 0,
      mfa_required: 0,
      cancelled: 0,
      total: jobs.size,
    };
    for (const j of jobs.values()) {
      if (Object.prototype.hasOwnProperty.call(s, j.status)) s[j.status]++;
    }
    return s;
  }

  function isCancelled(id) {
    const job = jobs.get(id);
    return job?.status === 'cancelled';
  }

  function cancelJob(id) {
    const job = jobs.get(id);
    if (!job || job.status !== 'queued') return false;
    job.status = 'cancelled';
    job.message = 'Cancelled';
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    broadcast('job', summarize(job));
    broadcast('job-stats', stats());
    return true;
  }

  function cancelQueued({ email, target } = {}) {
    let n = 0;
    for (const job of jobs.values()) {
      if (job.status !== 'queued') continue;
      if (email && job.email !== email) continue;
      if (target && job.target !== target) continue;
      job.status = 'cancelled';
      job.message = 'Cancelled';
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      broadcast('job', summarize(job));
      n++;
    }
    if (n) broadcast('job-stats', stats());
    return n;
  }

  function prune() {
    if (jobs.size <= MAX_JOBS) return;
    const finished = [...jobs.values()]
      .filter((j) => !ACTIVE_STATUSES.has(j.status))
      .sort((a, b) => (a.updatedAt || '').localeCompare(b.updatedAt || ''));
    for (const j of finished) {
      if (jobs.size <= Math.floor(MAX_JOBS * 0.9)) break;
      jobs.delete(j.id);
      for (const [key, ids] of accountIndex) {
        accountIndex.set(
          key,
          ids.filter((id) => id !== j.id)
        );
      }
    }
  }

  function registerJob(fields) {
    const job = {
      logs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...fields,
    };
    jobs.set(job.id, job);
    addToIndex(job);
    prune();
    return job;
  }

  function updateJob(id, patch) {
    const job = jobs.get(id);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    const active = ACTIVE_STATUSES.has(job.status);
    broadcast('job', summarize(job, { logs: active, screenshot: active }));
    broadcast('job-stats', stats());
    return job;
  }

  function jobLog(id, step, message) {
    const job = jobs.get(id);
    if (!job) return;
    const entry = { step, message, at: new Date().toISOString() };
    job.logs.push(entry);
    if (job.logs.length > MAX_LOG_LINES) {
      job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
    }
    job.message = message;
    job.updatedAt = entry.at;
    broadcast('job-log', { id, step, message, at: entry.at, logCount: job.logs.length });
    return job;
  }

  function listSummaries({ limit = 100, activeOnly = false } = {}) {
    let list = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (activeOnly) list = list.filter((j) => ACTIVE_STATUSES.has(j.status));
    return list.slice(0, limit).map((j) => summarize(j));
  }

  function getJob(id, { full = false } = {}) {
    const job = jobs.get(id);
    if (!job) return null;
    return full ? job : summarize(job, { logs: true, screenshot: true });
  }

  function jobsForAccount(email, target, limit = 25) {
    const ids = accountIndex.get(accountKey(email, target)) || [];
    return ids
      .slice(0, limit)
      .map((id) => jobs.get(id))
      .filter(Boolean)
      .map((j) => summarize(j));
  }

  function clearFinished() {
    let n = 0;
    for (const [id, j] of jobs) {
      if (!ACTIVE_STATUSES.has(j.status)) {
        jobs.delete(id);
        n++;
      }
    }
    for (const [key, ids] of accountIndex) {
      accountIndex.set(key, ids.filter((id) => jobs.has(id)));
    }
    broadcast('job-stats', stats());
    return n;
  }

  function broadcastBatch(batchId, jobSummaries, meta = {}) {
    broadcast('batch', { batchId, total: jobSummaries.length, jobs: jobSummaries, ...meta });
    broadcast('job-stats', stats());
  }

  function findActiveJob(email, target, { jobKind } = {}) {
    const ids = accountIndex.get(accountKey(email, target)) || [];
    for (const id of ids) {
      const job = jobs.get(id);
      if (!job || !ACTIVE_STATUSES.has(job.status)) continue;
      if (jobKind && job.jobKind !== jobKind) continue;
      return job;
    }
    return null;
  }

  return {
    jobs,
    registerJob,
    updateJob,
    jobLog,
    summarize,
    stats,
    listSummaries,
    getJob,
    jobsForAccount,
    clearFinished,
    broadcastBatch,
    isCancelled,
    cancelJob,
    cancelQueued,
    findActiveJob,
  };
}
