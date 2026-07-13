import { listAccountsDueForRefresh } from './account-export.js';
import { refreshAccountToken, tryBrowserlessAccountRefresh } from './account-actions.js';
import { beforeAccountRefresh } from './proxy.js';
import { isSmartRefreshEnabled, setSmartRefreshEnabled } from './settings.js';
import { isCamoufoxAvailable } from './camoufox-browser.js';
import { markProfileRefreshFailed } from './profile.js';
import { invalidateAccountsCache } from './accounts.js';
import { PRIORITY_REFRESH_WINDOW_MS } from './account-health.js';

/** Conservative defaults — no env vars required; max 2 HTTP refreshes at once on one IP when proxy is on. */
const CHECK_INTERVAL_MS = Number(process.env.SMART_REFRESH_INTERVAL_MS || 60_000);
const FAIL_BACKOFF_MS = Number(process.env.SMART_REFRESH_FAIL_BACKOFF_MS || 10 * 60 * 1000);
const REFRESH_SUCCESS_COOLDOWN_MS = Number(process.env.SMART_REFRESH_SUCCESS_COOLDOWN_MS || 20 * 60 * 1000);
const BROWSERLESS_PARALLEL = Math.min(
  5,
  Math.max(1, Number(process.env.SMART_REFRESH_BROWSERLESS_PARALLEL || 3))
);
/** Slight risk: 2 Camoufox by default (cap 3). Own pool — not the serial login queue. */
const CAMOUFOX_PARALLEL = Math.min(
  3,
  Math.max(1, Number(process.env.SMART_REFRESH_CAMOUFOX_PARALLEL || 2))
);
const MAX_CAMOUFOX_PER_TICK = Math.min(
  CAMOUFOX_PARALLEL,
  Math.max(1, Number(process.env.SMART_REFRESH_MAX_CAMOUFOX_PER_TICK || CAMOUFOX_PARALLEL))
);
const TICK_BATCH_SIZE = Math.min(
  12,
  Math.max(BROWSERLESS_PARALLEL, Number(process.env.SMART_REFRESH_TICK_BATCH_SIZE || 6))
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
/** True when a *user* login/relogin/manual job holds the shared queue. */
let isLoginQueueBusy = () => false;

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

export function initSmartRefresh({ log, onRefreshed: cb, isLoginQueueBusy: queueBusyFn } = {}) {
  if (log) logFn = log;
  onRefreshed = cb || null;
  isLoginQueueBusy = queueBusyFn || (() => false);
  stopSmartRefresh();
  timer = setInterval(() => tick().catch((err) => logFn('[smart-refresh]', err.message)), CHECK_INTERVAL_MS);
  deferredTick = setTimeout(() => {
    deferredTick = null;
    tick().catch(() => {});
  }, 15_000);
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
    loginQueueBusy: isLoginQueueBusy(),
    checkIntervalSec: CHECK_INTERVAL_MS / 1000,
    browserlessParallel: BROWSERLESS_PARALLEL,
    camoufoxParallel: CAMOUFOX_PARALLEL,
    maxCamoufoxPerTick: MAX_CAMOUFOX_PER_TICK,
    tickBatchSize: TICK_BATCH_SIZE,
    priorityWindowMin: Math.round(PRIORITY_REFRESH_WINDOW_MS / 60_000),
  };
}

export { setSmartRefreshEnabled, isSmartRefreshEnabled };

/** Split due accounts: HTTP-redeemable vs known-dead RT (Camoufox-only). Exported for tests. */
export function partitionDueForLanes(eligible) {
  const httpLane = [];
  const camoufoxOnly = [];
  for (const acc of eligible) {
    if (acc.httpRefreshRejected) camoufoxOnly.push(acc);
    else httpLane.push(acc);
  }
  return { httpLane, camoufoxOnly };
}

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

  logFn(`[smart-refresh] Fast lane: ${accounts.length} account(s), ${BROWSERLESS_PARALLEL} parallel (HTTP/Loki only)`);

  let skippedValid = 0;

  const results = await runParallel(accounts, BROWSERLESS_PARALLEL, async (acc) => {
    const key = `${acc.email}::${acc.target}`;
    inFlight.add(key);
    try {
      const result = await tryBrowserlessAccountRefresh(acc.email, acc.target, {
        jobId: `smart-bl-${Date.now()}`,
        onProgress: ({ step, message }) => {
          if (/Skipping HTTP refresh|previously rejected|Requesting LiveProfileCard/i.test(message)) {
            return;
          }
          logFn(`[smart-refresh:${acc.email}] [${step}] ${message}`);
        },
      });
      if (result.fromCache) {
        skippedValid++;
        lastSuccessAt.set(acc.email, Date.now());
        return { acc, ok: true, fromCache: true };
      }
      if (result.success && !result.result?.stillNeedsRefresh) {
        lastFailAt.delete(acc.email);
        lastSuccessAt.set(acc.email, Date.now());
        const via = result.result?.via || 'browserless';
        logFn(`[smart-refresh] OK ${acc.email} (${via})`);
        return { acc, ok: true };
      }
      return { acc, ok: false, needsCamoufox: true };
    } catch (err) {
      logFn(`[smart-refresh] FAIL ${acc.email} (browserless): ${err.message}`);
      return { acc, ok: false, needsCamoufox: true };
    } finally {
      inFlight.delete(key);
    }
  });

  if (skippedValid) {
    logFn(`[smart-refresh] Fast lane: ${skippedValid} still valid (no network)`);
  }

  return results;
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

  if (isLoginQueueBusy()) {
    const priorityBlocked = accounts.filter((a) => a.expiresSoon).length;
    logFn(
      `[smart-refresh] Camoufox deferred — user login queue busy (${accounts.length} need slow lane; ${priorityBlocked} priority). Pause or Cancel queued to free Camoufox.`
    );
    return;
  }

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
    `[smart-refresh] Slow lane: starting ${batch.length} Camoufox job(s) (parallel pool max ${CAMOUFOX_PARALLEL})`
  );

  for (const acc of batch) {
    runCamoufoxRefresh(acc).then(() => scheduleRefreshedBroadcast()).catch(() => {});
  }
}

function mergeCamoufoxNeeds(camoufoxOnly, fromHttpFailures) {
  const seen = new Set();
  const out = [];
  for (const acc of [...camoufoxOnly, ...fromHttpFailures]) {
    const key = `${acc.email}::${acc.target}`;
    if (seen.has(key) || inFlight.has(key) || camoufoxRunning.has(key)) continue;
    seen.add(key);
    out.push(acc);
  }
  return out;
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

    const priorityCount = eligible.filter((acc) => acc.expiresSoon).length;
    if (priorityCount) {
      logFn(
        `[smart-refresh] Priority: ${priorityCount} account(s) expire within ${Math.round(PRIORITY_REFRESH_WINDOW_MS / 60_000)}m`
      );
    }

    const { httpLane, camoufoxOnly } = partitionDueForLanes(eligible);
    if (camoufoxOnly.length) {
      logFn(
        `[smart-refresh] Lane split: ${httpLane.length} HTTP/Loki candidates, ${camoufoxOnly.length} Camoufox-only (RT previously rejected)`
      );
    }

    const browserlessBatch = httpLane.slice(0, TICK_BATCH_SIZE);
    const browserlessResults = browserlessBatch.length
      ? await runBrowserlessLane(browserlessBatch)
      : [];

    const fromHttpFailures = browserlessResults.filter((r) => r.needsCamoufox).map((r) => r.acc);
    const needsCamoufox = mergeCamoufoxNeeds(camoufoxOnly, fromHttpFailures);
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
