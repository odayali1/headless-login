const DEFAULT_TIMEOUT_MS = Number(process.env.LOGIN_JOB_TIMEOUT_MS || 10 * 60 * 1000);
/** Delay between starting each parallel Camoufox (avoids slamming MSA at once). */
const PARALLEL_STAGGER_MS = Number(process.env.LOGIN_PARALLEL_STAGGER_MS || 45_000);
/** Hard ceiling — residential rotating can go higher; mobile should stay at 1–2. */
const PARALLEL_MAX = 10;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function envParallel() {
  const raw = process.env.LOGIN_PARALLEL;
  const n = raw == null || raw === '' ? 1 : Number(raw);
  if (!Number.isFinite(n)) return 1;
  const requested = Math.min(PARALLEL_MAX, Math.max(1, Math.trunc(n)));
  // Parallel >1 needs an explicit force flag (mobile same-IP is unsafe; residential rotating is OK).
  if (requested > 1 && process.env.LOGIN_PARALLEL_FORCE !== '1') {
    return 1;
  }
  return requested;
}

export function withTimeout(promise, ms, label = 'Job') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${Math.round(ms / 60_000)} min`);
      err.code = 'QUEUE_TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Login / re-login job queue.
 * Default concurrency 1 (safe). Set LOGIN_PARALLEL=N + LOGIN_PARALLEL_FORCE=1 for parallel Camoufox.
 * Prefer residential rotating IPv4 for N>2. (SMART_REFRESH_CAMOUFOX_PARALLEL is separate.)
 */
export function createLoginQueue({
  broadcast,
  onTimeout,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  concurrency = envParallel(),
} = {}) {
  const max = Math.min(PARALLEL_MAX, Math.max(1, Number(concurrency) || 1));
  /** @type {Map<string, { jobId: string|null, label: string, startedAt: number }>} */
  const running = new Map();
  /** @type {Array<{ key: string, fn: Function, label?: string, jobId?: string, resolve: Function, reject: Function }>} */
  const waiters = [];
  let waiting = 0;
  let paused = false;
  let pauseWaiters = [];
  let seq = 0;

  function getStatus() {
    const currents = [...running.values()];
    return {
      busy: running.size > 0,
      paused,
      /** First running job — kept for older UI. */
      current: currents[0] ? { ...currents[0] } : null,
      /** All running jobs (LOGIN_PARALLEL > 1). */
      currentJobs: currents.map((c) => ({ ...c })),
      parallel: max,
      running: running.size,
      waiting,
      timeoutMin: Math.round(timeoutMs / 60_000),
      /** True when a browser login job is actively running (not merely queued). */
      blocksCamoufox: running.size > 0,
    };
  }

  function broadcastStatus() {
    broadcast?.('queue-status', getStatus());
  }

  function setPaused(next) {
    paused = !!next;
    if (!paused && pauseWaiters.length) {
      const waitersToResume = pauseWaiters;
      pauseWaiters = [];
      for (const resume of waitersToResume) resume();
    }
    broadcastStatus();
    if (!paused) pump();
    return getStatus();
  }

  function waitIfPaused() {
    if (!paused) return Promise.resolve();
    return new Promise((resolve) => {
      pauseWaiters.push(resolve);
    });
  }

  async function pump() {
    while (running.size < max && waiters.length) {
      if (paused) break;

      if (max > 1 && running.size >= 1 && PARALLEL_STAGGER_MS > 0) {
        const lastStarted = Math.max(0, ...[...running.values()].map((r) => r.startedAt || 0));
        const since = Date.now() - lastStarted;
        if (since < PARALLEL_STAGGER_MS) {
          const wait = PARALLEL_STAGGER_MS - since;
          console.log(
            `[queue] Staggering parallel login ${Math.round(wait / 1000)}s (${running.size}/${max} running)`
          );
          await sleep(wait);
        }
      }

      const item = waiters.shift();
      waiting = waiters.length;
      const { key, fn, label, jobId, resolve, reject } = item;

      const startedAt = Date.now();
      running.set(key, { jobId: jobId || null, label: label || jobId || 'login', startedAt });
      broadcastStatus();

      (async () => {
        try {
          while (paused) {
            await waitIfPaused();
          }
          await withTimeout(Promise.resolve().then(fn), timeoutMs, label || jobId || 'Login job');
          resolve();
        } catch (err) {
          if (err.code === 'QUEUE_TIMEOUT') {
            onTimeout?.({ jobId, label, err });
          }
          console.error('[queue]', label || jobId || 'job', err.message);
          reject(err);
        } finally {
          running.delete(key);
          broadcastStatus();
          pump().catch((err) => console.error('[queue] pump', err.message));
        }
      })();
    }
    broadcastStatus();
  }

  function enqueue(fn, { label, jobId } = {}) {
    const key = `${jobId || 'job'}:${++seq}`;
    waiting = waiters.length + 1;
    broadcastStatus();

    return new Promise((resolve, reject) => {
      waiters.push({ key, fn, label, jobId, resolve, reject });
      waiting = waiters.length;
      broadcastStatus();
      pump().catch((err) => console.error('[queue] pump', err.message));
    });
  }

  return { enqueue, getStatus, setPaused, withTimeout, timeoutMs, parallel: max };
}
