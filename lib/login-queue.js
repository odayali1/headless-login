import { getLoginParallel, LOGIN_PARALLEL_MAX } from './settings.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.LOGIN_JOB_TIMEOUT_MS || 10 * 60 * 1000);
/** Delay between starting each parallel Camoufox (avoids slamming MSA at once). */
const PARALLEL_STAGGER_MS = Number(process.env.LOGIN_PARALLEL_STAGGER_MS || 8_000);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
 * Concurrency from settings (dashboard) or LOGIN_PARALLEL seed. Max LOGIN_PARALLEL_MAX.
 *
 * CRITICAL: only one pump() may run at a time. Concurrent pumps used to overshoot
 * LOGIN_PARALLEL badly (hundreds of Camoufox) during bulk re-login enqueue.
 */
export function createLoginQueue({
  broadcast,
  onTimeout,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  concurrency = getLoginParallel(),
} = {}) {
  let max = Math.min(LOGIN_PARALLEL_MAX, Math.max(1, Number(concurrency) || 1));
  /** @type {Map<string, { jobId: string|null, label: string, startedAt: number }>} */
  const running = new Map();
  /** @type {Array<{ key: string, fn: Function, label?: string, jobId?: string, resolve: Function, reject: Function }>} */
  const waiters = [];
  let waiting = 0;
  let paused = false;
  let pauseWaiters = [];
  let seq = 0;
  /** Single-flight — prevents parallel pump() from starting more than `max` jobs. */
  let pumpActive = false;
  let pumpAgain = false;

  function getStatus() {
    const currents = [...running.values()];
    return {
      busy: running.size > 0,
      paused,
      current: currents[0] ? { ...currents[0] } : null,
      currentJobs: currents.map((c) => ({ ...c })),
      parallel: max,
      running: running.size,
      waiting,
      timeoutMin: Math.round(timeoutMs / 60_000),
      blocksCamoufox: running.size > 0,
      parallelLocked: /^(1|true|yes|on)$/i.test(String(process.env.LOGIN_PARALLEL_LOCK || '').trim()),
      parallelMax: LOGIN_PARALLEL_MAX,
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
    if (!paused) schedulePump();
    return getStatus();
  }

  /** Change Camoufox login concurrency live (1…LOGIN_PARALLEL_MAX). Does not kill running jobs. */
  function setParallel(n) {
    const next = Math.min(LOGIN_PARALLEL_MAX, Math.max(1, Math.trunc(Number(n) || 1)));
    const prev = max;
    max = next;
    if (prev !== next) {
      console.log(`[queue] Login parallel → ${next} (was ${prev})`);
      broadcastStatus();
      if (next > prev) schedulePump();
    }
    return getStatus();
  }

  function waitIfPaused() {
    if (!paused) return Promise.resolve();
    return new Promise((resolve) => {
      pauseWaiters.push(resolve);
    });
  }

  function schedulePump() {
    pump().catch((err) => console.error('[queue] pump', err.message));
  }

  async function pump() {
    if (pumpActive) {
      pumpAgain = true;
      return;
    }
    pumpActive = true;
    pumpAgain = false;
    try {
      while (running.size < max && waiters.length) {
        if (paused) break;

        // Re-check after any await — another finish cannot start extras while we hold the lock,
        // but stagger sleep must not leave us above max if max was lowered mid-wait.
        if (max > 1 && running.size >= 1 && PARALLEL_STAGGER_MS > 0) {
          const lastStarted = Math.max(0, ...[...running.values()].map((r) => r.startedAt || 0));
          const since = Date.now() - lastStarted;
          if (since < PARALLEL_STAGGER_MS) {
            const wait = PARALLEL_STAGGER_MS - since;
            console.log(
              `[queue] Staggering parallel login ${Math.round(wait / 1000)}s (${running.size}/${max} running)`
            );
            await sleep(wait);
            if (paused || running.size >= max || !waiters.length) break;
          }
        }

        if (running.size >= max || !waiters.length) break;

        const item = waiters.shift();
        waiting = waiters.length;
        const { key, fn, label, jobId, resolve, reject } = item;

        const startedAt = Date.now();
        running.set(key, { jobId: jobId || null, label: label || jobId || 'login', startedAt });
        broadcastStatus();

        // Slot stays occupied until fn fully settles (login + token + success/fail).
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
            schedulePump();
          }
        })();
      }
    } finally {
      pumpActive = false;
      broadcastStatus();
      if (pumpAgain || (running.size < max && waiters.length && !paused)) {
        schedulePump();
      }
    }
  }

  function enqueue(fn, { label, jobId } = {}) {
    const key = `${jobId || 'job'}:${++seq}`;
    waiting = waiters.length + 1;
    broadcastStatus();

    return new Promise((resolve, reject) => {
      waiters.push({ key, fn, label, jobId, resolve, reject });
      waiting = waiters.length;
      broadcastStatus();
      schedulePump();
    });
  }

  return {
    enqueue,
    getStatus,
    setPaused,
    setParallel,
    withTimeout,
    timeoutMs,
    get parallel() {
      return max;
    },
  };
}
