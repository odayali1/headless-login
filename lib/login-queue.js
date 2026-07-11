const DEFAULT_TIMEOUT_MS = Number(process.env.LOGIN_JOB_TIMEOUT_MS || 10 * 60 * 1000);

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

export function createLoginQueue({ broadcast, onTimeout, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let chain = Promise.resolve();
  let current = null;
  let waiting = 0;
  let paused = false;
  let pauseWaiters = [];

  function getStatus() {
    return {
      busy: !!current,
      paused,
      current: current ? { ...current } : null,
      waiting,
      timeoutMin: Math.round(timeoutMs / 60_000),
      /** True when a browser login/refresh job is actually holding Camoufox. */
      blocksCamoufox: !!current || (waiting > 0 && !paused),
    };
  }

  function broadcastStatus() {
    broadcast?.('queue-status', getStatus());
  }

  function setPaused(next) {
    paused = !!next;
    if (!paused && pauseWaiters.length) {
      const waiters = pauseWaiters;
      pauseWaiters = [];
      for (const resume of waiters) resume();
    }
    broadcastStatus();
    return getStatus();
  }

  function waitIfPaused() {
    if (!paused) return Promise.resolve();
    return new Promise((resolve) => {
      pauseWaiters.push(resolve);
    });
  }

  function enqueue(fn, { label, jobId } = {}) {
    waiting++;
    broadcastStatus();

    const run = chain.then(async () => {
      waiting--;
      broadcastStatus();

      while (paused) {
        await waitIfPaused();
      }

      const startedAt = Date.now();
      current = { jobId: jobId || null, label: label || jobId || 'login', startedAt };
      broadcastStatus();

      try {
        await withTimeout(Promise.resolve().then(fn), timeoutMs, label || jobId || 'Login job');
      } catch (err) {
        if (err.code === 'QUEUE_TIMEOUT') {
          onTimeout?.({ jobId, label, err });
        }
        throw err;
      } finally {
        current = null;
        broadcastStatus();
      }
    });

    chain = run.catch((err) => {
      console.error('[queue]', label || jobId || 'job', err.message);
    });

    return run;
  }

  return { enqueue, getStatus, setPaused, withTimeout, timeoutMs };
}
