import { listAccountsDueForRefresh } from './account-export.js';
import { refreshAccountToken, tryBrowserlessAccountRefresh } from './account-actions.js';
import { beforeAccountRefresh } from './proxy.js';
import { isSmartRefreshEnabled, setSmartRefreshEnabled } from './settings.js';
import { isCamoufoxAvailable } from './camoufox-browser.js';
import { markProfileRefreshFailed } from './profile.js';
import { invalidateAccountsCache } from './accounts.js';

const CHECK_INTERVAL_MS = Number(process.env.SMART_REFRESH_INTERVAL_MS || 30_000);
const FAIL_BACKOFF_MS = Number(process.env.SMART_REFRESH_FAIL_BACKOFF_MS || 10 * 60 * 1000);
const REFRESH_SUCCESS_COOLDOWN_MS = Number(process.env.SMART_REFRESH_SUCCESS_COOLDOWN_MS || 20 * 60 * 1000);
const BROWSERLESS_PARALLEL = Math.min(
  8,
  Math.max(1, Number(process.env.SMART_REFRESH_BROWSERLESS_PARALLEL || 6))
);
const CAMOUFOX_PARALLEL = Math.min(
  3,
  Math.max(1, Number(process.env.SMART_REFRESH_CAMOUFOX_PARALLEL || 1))
);
const MAX_CAMOUFOX_PER_TICK = Math.min(
  CAMOUFOX_PARALLEL,
  Math.max(1, Number(process.env.SMART_REFRESH_MAX_CAMOUFOX_PER_TICK || CAMOUFOX_PARALLEL))
);
const TICK_BATCH_SIZE = Math.min(
  60,
  Math.max(BROWSERLESS_PARALLEL, Number(process.env.SMART_REFRESH_TICK_BATCH_SIZE || 30))
);

const inFlight = new Set();
const camoufoxRunning = new Set();
const lastFailAt = new Map();
const lastSuccessAt = new Map();

let timer = null;
let deferredTick = null;
let logFn = console.log;
let onRefreshed = null;
let refreshedBroadcastTimer = null;
let tickRunning = false;

export function stopSmartRefresh() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (deferredTick) {
    clearTimeout(deferredTick);
    deferredTick = null;
  }
}

export function initSmartRefresh({ log, onRefreshed: cb }) {
  if (log) logFn = log;
  onRefreshed = cb || null;
  stopSmartRefresh();
  timer = setInterval(() => tick().catch((err) => logFn('[smart-refresh]', err.message)), CHECK_INTERVAL_MS);
  deferredTick = setTimeout(() => {
    deferredTick = null;
    tick().catch(() => {});
  }, 10_000);
}

export function syncSmartRefreshRuntime(deps) {
  if (!isSmartRefreshEnabled()) {
    stopSmartRefresh();
    return false;
  }
  if (!deps) return false;
  initSmartRefresh(deps);
  return true;
}

export function getSmartRefreshStatus() {
  return {
    enabled: isSmartRefreshEnabled(),
    inFlight: inFlight.size,
    camoufoxRunning: camoufoxRunning.size,
    checkIntervalSec: CHECK_INTERVAL_MS / 1000,
    browserlessParallel: BROWSERLESS_PARALLEL,
    camoufoxParallel: CAMOUFOX_PARALLEL,
    maxCamoufoxPerTick: MAX_CAMOUFOX_PER_TICK,
    tickBatchSize: TICK_BATCH_SIZE,
  };
}

export { setSmartRefreshEnabled, isSmartRefreshEnabled };

function filterEligible(due, now) {
  const eligible = [];
  for (const acc of due) {
    const key = `${acc.email}::${acc.target}`;
    if (inFlight.has(key)) continue;

    const failedAt = lastFailAt.get(acc.email);
    if (failedAt && now - failedAt < FAIL_BACKOFF_MS) continue;

    const succeededAt = lastSuccessAt.get(acc.email);
    if (succeededAt && now - succeededAt < REFRESH_SUCCESS_COOLDOWN_MS) continue;

    eligible.push(acc);
  }
  return eligible;
}

async function runParallel(items, concurrency, fn) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function runBrowserlessLane(accounts) {
  if (!accounts.length) return [];

  logFn(`[smart-refresh] Fast lane: ${accounts.length} account(s), ${BROWSERLESS_PARALLEL} parallel (HTTP only)`);

  return runParallel(accounts, BROWSERLESS_PARALLEL, async (acc) => {
    const key = `${acc.email}::${acc.target}`;
    inFlight.add(key);
    try {
      const result = await tryBrowserlessAccountRefresh(acc.email, acc.target, {
        jobId: `smart-bl-${Date.now()}`,
        onProgress: ({ step, message }) => logFn(`[smart-refresh:${acc.email}] [${step}] ${message}`),
      });
      if (result.success && !result.result?.stillNeedsRefresh) {
        lastFailAt.delete(acc.email);
        lastSuccessAt.set(acc.email, Date.now());
        logFn(`[smart-refresh] OK ${acc.email} (browserless)`);
        return { acc, ok: true };
      }
      return { acc, ok: false };
    } catch (err) {
      logFn(`[smart-refresh] FAIL ${acc.email} (browserless): ${err.message}`);
      return { acc, ok: false };
    } finally {
      inFlight.delete(key);
    }
  });
}

async function runCamoufoxRefresh(acc) {
  const key = `${acc.email}::${acc.target}`;
  inFlight.add(key);
  camoufoxRunning.add(key);
  logFn(`[smart-refresh] Slow lane: ${acc.email} (Camoufox)`);

  try {
    await beforeAccountRefresh((step, message) =>
      logFn(`[smart-refresh:${acc.email}] [${step}] ${message}`)
    );
    await refreshAccountToken(acc.email, acc.target, {
      engine: 'camoufox',
      jobId: `smart-${Date.now()}`,
      skipBrowserless: true,
      onProgress: ({ step, message }) => logFn(`[smart-refresh:${acc.email}] [${step}] ${message}`),
    });
    lastFailAt.delete(acc.email);
    lastSuccessAt.set(acc.email, Date.now());
    logFn(`[smart-refresh] OK ${acc.email} (Camoufox)`);
    return { acc, ok: true };
  } catch (err) {
    lastFailAt.set(acc.email, Date.now());
    await markProfileRefreshFailed(acc.email, err.message).catch(() => {});
    invalidateAccountsCache();
    logFn(`[smart-refresh] FAIL ${acc.email}: ${err.message}`);
    return { acc, ok: false };
  } finally {
    inFlight.delete(key);
    camoufoxRunning.delete(key);
    invalidateAccountsCache();
  }
}

async function runCamoufoxLane(accounts) {
  if (!accounts.length) return;

  const freeSlots = Math.max(0, CAMOUFOX_PARALLEL - camoufoxRunning.size);
  const batch = accounts.slice(0, Math.min(MAX_CAMOUFOX_PER_TICK, freeSlots));

  if (!batch.length) {
    if (accounts.length > 0) {
      logFn(
        `[smart-refresh] Camoufox pool full (${camoufoxRunning.size}/${CAMOUFOX_PARALLEL}) — ${accounts.length} deferred`
      );
    }
    return;
  }

  logFn(
    `[smart-refresh] Slow lane: starting ${batch.length} Camoufox job(s) (up to ${CAMOUFOX_PARALLEL} parallel)`
  );

  for (const acc of batch) {
    runCamoufoxRefresh(acc).then(() => scheduleRefreshedBroadcast()).catch(() => {});
  }
}

async function tick() {
  if (!isSmartRefreshEnabled()) return;
  if (tickRunning) return;
  if (!(await isCamoufoxAvailable())) {
    logFn('[smart-refresh] Skipped — Camoufox binary not available on this host');
    return;
  }

  const due = await listAccountsDueForRefresh();
  if (!due.length) return;

  tickRunning = true;
  try {
    const now = Date.now();
    const eligible = filterEligible(due, now);
    if (!eligible.length) return;

    if (due.length > eligible.length) {
      logFn(`[smart-refresh] ${due.length} due, ${eligible.length} eligible this tick`);
    }

    const browserlessBatch = eligible.slice(0, TICK_BATCH_SIZE);
    const browserlessResults = await runBrowserlessLane(browserlessBatch);

    const needsCamoufox = browserlessResults.filter((r) => !r.ok).map((r) => r.acc);
    if (needsCamoufox.length) {
      runCamoufoxLane(needsCamoufox);
    }

    scheduleRefreshedBroadcast();
  } finally {
    tickRunning = false;
  }
}

function scheduleRefreshedBroadcast() {
  if (!onRefreshed) return;
  if (refreshedBroadcastTimer) clearTimeout(refreshedBroadcastTimer);
  refreshedBroadcastTimer = setTimeout(() => {
    refreshedBroadcastTimer = null;
    onRefreshed();
    invalidateAccountsCache();
  }, 5000);
}
