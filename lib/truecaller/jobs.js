/**
 * Isolated Truecaller job queue. Does not share the Outlook login queue.
 * Holds a worklist of emails (OK at ~53k) and only materializes recent job logs.
 */
import { v4 as uuidv4 } from 'uuid';
import { getParallel, setParallel as persistParallel } from './store.js';

const jobs = new Map();
const listeners = new Set();
const MAX_JOBS = 400;

let work = emptyWork();
let parallel = getParallel();
let runnerFn = null;

function emptyWork(kind = 'signup') {
  return {
    emails: [],
    next: 0,
    kind,
    paused: false,
    cancelled: false,
    running: 0,
    success: 0,
    failed: 0,
    startedAt: null,
  };
}

export function subscribe(res) {
  listeners.add(res);
  return () => listeners.delete(res);
}

function emit(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) {
    try {
      res.write(payload);
    } catch {
      listeners.delete(res);
    }
  }
}

export function queueStatus() {
  const queued = Math.max(0, work.emails.length - work.next);
  return {
    kind: work.kind,
    paused: work.paused,
    cancelled: work.cancelled,
    parallel,
    queued,
    running: work.running,
    success: work.success,
    failed: work.failed,
    total: work.emails.length,
    startedAt: work.startedAt,
    done: work.emails.length > 0 && queued === 0 && work.running === 0,
  };
}

function emitQueue() {
  emit('queue', queueStatus());
}

export function createJob({ email, kind = 'signup' }) {
  const job = {
    id: uuidv4(),
    email,
    kind,
    status: 'queued',
    message: 'Queued',
    logs: [],
    result: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: null,
  };
  jobs.set(job.id, job);
  while (jobs.size > MAX_JOBS) {
    const first = jobs.keys().next().value;
    jobs.delete(first);
  }
  emit('job', summarize(job));
  return job;
}

export function jobLog(jobId, step, message) {
  const job = jobs.get(jobId);
  if (!job) return;
  const line = { t: new Date().toISOString(), step, message: String(message || '') };
  job.logs.push(line);
  if (job.logs.length > 80) job.logs.splice(0, job.logs.length - 80);
  job.message = line.message;
  job.updatedAt = line.t;
  emit('job', summarize(job, { logs: true }));
}

export function updateJob(jobId, patch) {
  const job = jobs.get(jobId);
  if (!job) return null;
  Object.assign(job, patch);
  job.updatedAt = new Date().toISOString();
  if (patch.status && ['success', 'failed', 'cancelled'].includes(patch.status)) {
    job.finishedAt = job.updatedAt;
  }
  emit('job', summarize(job, { logs: true }));
  return job;
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function listJobs() {
  return [...jobs.values()]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 80)
    .map((j) => summarize(j));
}

export function summarize(job, { logs = false } = {}) {
  const out = {
    id: job.id,
    email: job.email,
    kind: job.kind,
    status: job.status,
    message: job.message,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
    result: job.result,
  };
  if (logs) out.logs = job.logs;
  else if (job.logs?.length) out.lastLog = job.logs[job.logs.length - 1];
  return out;
}

export function setParallel(n) {
  parallel = persistParallel(n);
  emitQueue();
  pump();
  return parallel;
}

export function getQueueParallel() {
  return parallel;
}

export function pauseQueue(paused = true) {
  work.paused = !!paused;
  emitQueue();
  if (!work.paused) pump();
  return queueStatus();
}

export function cancelQueue() {
  work.cancelled = true;
  work.emails = work.emails.slice(0, work.next);
  emitQueue();
  return queueStatus();
}

export function setBatchRunner(fn) {
  runnerFn = fn;
}

/**
 * Append emails to the isolated Truecaller worklist.
 * @param {string[]} emails
 * @param {'signup'|'refresh'} kind
 */
export function startBatch(emails, kind = 'signup') {
  const list = [...new Set(emails.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
  if (!list.length) return queueStatus();

  const idle = work.cancelled || (work.emails.length > 0 && work.next >= work.emails.length && work.running === 0);
  if (idle) work = emptyWork(kind);

  work.kind = kind;
  work.cancelled = false;
  work.paused = false;
  if (!work.startedAt) work.startedAt = new Date().toISOString();

  const already = new Set(work.emails);
  for (const email of list) {
    if (!already.has(email)) {
      already.add(email);
      work.emails.push(email);
    }
  }
  emitQueue();
  pump();
  return queueStatus();
}

function pump() {
  if (!runnerFn) return;
  if (work.paused || work.cancelled) return;
  while (work.running < parallel && work.next < work.emails.length) {
    const email = work.emails[work.next++];
    work.running += 1;
    emitQueue();
    const job = createJob({ email, kind: work.kind });
    updateJob(job.id, { status: 'running', message: 'Starting…' });
    Promise.resolve()
      .then(() => runnerFn(email, job))
      .then(() => {
        work.success += 1;
      })
      .catch(() => {
        work.failed += 1;
      })
      .finally(() => {
        work.running = Math.max(0, work.running - 1);
        emitQueue();
        pump();
      });
  }
}

/** Back-compat single enqueue used by older callers. */
export function enqueue(fn) {
  return Promise.resolve().then(fn);
}
