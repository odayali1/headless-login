/**
 * Shared Camoufox concurrency for smart-refresh + manual Refresh buttons.
 * Manual refresh used the serial login queue → second account waited forever.
 */

function envInt(name, fallback, { min = 1, max = 100 } = {}) {
  const raw = process.env[name];
  const n = raw == null || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

const MAX_PARALLEL = envInt('SMART_REFRESH_CAMOUFOX_PARALLEL', 3, { min: 1, max: 4 });

let running = 0;
const waiters = [];

export function getCamoufoxPoolStatus() {
  return { running, waiting: waiters.length, max: MAX_PARALLEL };
}

/**
 * Run fn when a Camoufox slot is free. Priority jobs jump the queue (manual Refresh).
 * @returns {Promise<T>}
 */
export function withCamoufoxSlot(fn, { priority = false } = {}) {
  return new Promise((resolve, reject) => {
    const item = { fn, resolve, reject };
    if (priority) waiters.unshift(item);
    else waiters.push(item);
    pump();
  });
}

function pump() {
  while (running < MAX_PARALLEL && waiters.length) {
    const item = waiters.shift();
    running++;
    Promise.resolve()
      .then(item.fn)
      .then(item.resolve, item.reject)
      .finally(() => {
        running--;
        pump();
      });
  }
}
