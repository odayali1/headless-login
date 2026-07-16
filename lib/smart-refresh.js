import { listAccountsDueForRefresh } from './account-export.js';
import { refreshAccountToken, tryBrowserlessAccountRefresh } from './account-actions.js';
import { beforeAccountRefresh, isProxyRotating, isProxyIpSaturated, trackBrowserlessHttpOp } from './proxy.js';
import { isSmartRefreshEnabled, setSmartRefreshEnabled, isProxyEnabled } from './settings.js';
import { isCamoufoxAvailable } from './camoufox-browser.js';
import { markProfileRefreshFailed } from './profile.js';
import { invalidateAccountsCache } from './accounts.js';
import { PRIORITY_REFRESH_WINDOW_MS } from './account-health.js';
import { getCamoufoxPoolStatus, withCamoufoxSlot } from './camoufox-pool.js';

function envInt(name, fallback, { min = 1, max = 100 } = {}) {
  const raw = process.env[name];
  const n = raw == null || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Conservative defaults — no env vars required. */
const CHECK_INTERVAL_MS = envInt('SMART_REFRESH_INTERVAL_MS', 60_000, { min: 5_000, max: 600_000 });
const FAIL_BACKOFF_MS = envInt('SMART_REFRESH_FAIL_BACKOFF_MS', 10 * 60 * 1000, { min: 60_000, max: 3_600_000 });
const REFRESH_SUCCESS_COOLDOWN_MS = envInt('SMART_REFRESH_SUCCESS_COOLDOWN_MS', 20 * 60 * 1000, {
  min: 60_000,
  max: 3_600_000,
});
/** HTTP/Loki + cookie PKCE. Default 2 on proxy hosts — 5 parallel burned IP before login (429). */
const BROWSERLESS_PARALLEL = envInt(
  'SMART_REFRESH_BROWSERLESS_PARALLEL',
  isProxyEnabled() ? 2 : 5,
  { min: 1, max: 8 }
);
/** When login queue or IP rotate is active — keep fast lane alive but quiet (not paused). */
const BROWSERLESS_PARALLEL_BUSY = envInt('SMART_REFRESH_BROWSERLESS_PARALLEL_BUSY', 2, { min: 1, max: 8 });
/** Shared with manual Refresh (lib/camoufox-pool.js). */
const CAMOUFOX_PARALLEL = getCamoufoxPoolStatus().max;
/** Auto-pause bulk login queue when Camoufox-only backlog exceeds this (stops a 4th browser fighting smart). */
const AUTO_PAUSE_QUEUE_AT = envInt('SMART_REFRESH_AUTO_PAUSE_QUEUE_AT', 50, { min: 10, max: 10_000 });
const TICK_BATCH_SIZE = envInt('SMART_REFRESH_TICK_BATCH_SIZE', Math.max(6, BROWSERLESS_PARALLEL * 3), {
  min: BROWSERLESS_PARALLEL,
  max: 15,
});
const TICK_BATCH_SIZE_BUSY = envInt('SMART_REFRESH_TICK_BATCH_SIZE_BUSY', Math.max(4, BROWSERLESS_PARALLEL_BUSY), {
  min: BROWSERLESS_PARALLEL_BUSY,
  max: 30,
});

const inFlight = new Set();
/** Dead-RT accounts waiting for a free Camoufox slot (refilled as soon as one finishes). */
const camoufoxWaiting = [];
const camoufoxWaitingKeys = new Set();
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
/** Full queue status for tiered fast-lane limits. */
let getLoginQueueStatus = () => ({ running: 0, waiting: 0, paused: false });
/** Optional: pause bulk queue so it stops stealing Camoufox from recovery. */
let pauseLoginQueue = null;
let didAutoPauseQueue = false;

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

export function initSmartRefresh({
  log,
  onRefreshed: cb,
  isLoginQueueBusy: queueBusyFn,
  getLoginQueueStatus: queueStatusFn,
  pauseLoginQueue: pauseFn,
} = {}) {
  if (log) logFn = log;
  onRefreshed = cb || null;
  isLoginQueueBusy = queueBusyFn || (() => false);
  getLoginQueueStatus = queueStatusFn || (() => ({ running: 0, waiting: 0, paused: false }));
  pauseLoginQueue = typeof pauseFn === 'function' ? pauseFn : null;
  didAutoPauseQueue = false;
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
  const pool = getCamoufoxPoolStatus();
  const limits = resolveFastLaneLimits();
  return {
    enabled: isSmartRefreshEnabled(),
    inFlight: inFlight.size,
    camoufoxRunning: pool.running,
    loginQueueBusy: isLoginQueueBusy(),
    checkIntervalSec: CHECK_INTERVAL_MS / 1000,
    browserlessParallel: BROWSERLESS_PARALLEL,
    browserlessParallelBusy: BROWSERLESS_PARALLEL_BUSY,
    browserlessParallelActive: limits.parallel,
    fastLaneThrottled: limits.throttled,
    camoufoxParallel: pool.max,
    camoufoxWaiting: camoufoxWaiting.length + pool.waiting,
    tickBatchSize: TICK_BATCH_SIZE,
    tickBatchSizeActive: limits.batch,
    priorityWindowMin: Math.round(PRIORITY_REFRESH_WINDOW_MS / 60_000),
  };
}

/** Fast lane limits — hard-pause HTTP when login needs the mobile IP (GetCredentialType 429 otherwise). */
export function resolveFastLaneLimits() {
  const q = getLoginQueueStatus();
  const loginRunning = (q.running || 0) > 0;
  const loginQueued = (q.waiting || 0) > 0 && !q.paused;
  const proxyRotating = isProxyRotating();
  const ipSaturated = isProxyIpSaturated();

  if (proxyRotating) {
    return {
      parallel: 0,
      batch: 0,
      throttled: true,
      reason: 'IP rotating',
      skipLane: true,
    };
  }
  if (loginRunning || loginQueued) {
    // In-flight HTTP during Camoufox login burns the new IP → GetCredentialType 429.
    return {
      parallel: 0,
      batch: 0,
      throttled: true,
      reason: loginRunning ? 'login in progress' : 'login queue waiting',
      skipLane: true,
    };
  }
  if (ipSaturated) {
    // Cooldown blocked rotate while counter was 8→21 — must stop HTTP until IP changes.
    return {
      parallel: 0,
      batch: 0,
      throttled: true,
      reason: 'HTTP IP saturated (awaiting rotate)',
      skipLane: true,
    };
  }
  return {
    parallel: BROWSERLESS_PARALLEL,
    batch: TICK_BATCH_SIZE,
    throttled: false,
    reason: null,
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

async function runBrowserlessLane(accounts, parallel = BROWSERLESS_PARALLEL) {
  if (!accounts.length) return [];

  logFn(`[smart-refresh] Fast lane: ${accounts.length} account(s), ${parallel} parallel (HTTP/Loki only)`);

  let skippedValid = 0;

  const results = await runParallel(accounts, parallel, async (acc) => {
    // Abort remaining batch if login started or IP filled mid-tick (was the 429 smoking gun).
    const live = resolveFastLaneLimits();
    if (live.skipLane) {
      return { acc, ok: false, deferred: true };
    }
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
        const via = result.result?.via || result.via || 'browserless';
        logFn(`[smart-refresh] OK ${acc.email} (${via})`);
        return { acc, ok: true };
      }
      return { acc, ok: false, needsCamoufox: true };
    } catch (err) {
      logFn(`[smart-refresh] FAIL ${acc.email} (browserless): ${err.message}`);
      return { acc, ok: false, needsCamoufox: true };
    } finally {
      inFlight.delete(key);
      if (!resolveFastLaneLimits().skipLane) {
        await trackBrowserlessHttpOp((step, message) => {
          if (message) logFn(`[smart-refresh] [${step}] ${message}`);
        }).catch(() => {});
      }
    }
  });

  if (skippedValid) {
    logFn(`[smart-refresh] Fast lane: ${skippedValid} still valid (no network)`);
  }

  return results;
}

function accountKey(acc) {
  return `${acc.email}::${acc.target}`;
}

function enqueueCamoufoxWaiting(accounts) {
  let added = 0;
  for (const acc of accounts) {
    const key = accountKey(acc);
    if (inFlight.has(key) || camoufoxWaitingKeys.has(key)) continue;
    camoufoxWaiting.push(acc);
    camoufoxWaitingKeys.add(key);
    added++;
  }
  return added;
}

function drainCamoufoxPool() {
  const started = [];
  while (camoufoxWaiting.length) {
    const acc = camoufoxWaiting.shift();
    const key = accountKey(acc);
    camoufoxWaitingKeys.delete(key);
    if (inFlight.has(key)) continue;
    started.push(acc.email);
    runCamoufoxRefresh(acc);
  }
  if (started.length) {
    const pool = getCamoufoxPoolStatus();
    logFn(
      `[smart-refresh] Slow lane: queued ${started.length} Camoufox (${pool.running}/${pool.max} running, ${pool.waiting} in pool)`
    );
  }
}

async function runCamoufoxRefresh(acc) {
  const key = accountKey(acc);
  inFlight.add(key);

  try {
    await withCamoufoxSlot(async () => {
      logFn(`[smart-refresh] Slow lane: ${acc.email} (Camoufox)`);
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
    });
    return { acc, ok: true };
  } catch (err) {
    lastFailAt.set(acc.email, Date.now());
    await markProfileRefreshFailed(acc.email, err.message).catch(() => {});
    invalidateAccountsCache();
    logFn(`[smart-refresh] FAIL ${acc.email}: ${err.message}`);
    return { acc, ok: false };
  } finally {
    inFlight.delete(key);
    invalidateAccountsCache();
    scheduleRefreshedBroadcast();
    drainCamoufoxPool();
  }
}

async function runCamoufoxLane(accounts) {
  const pool = getCamoufoxPoolStatus();
  if (!accounts.length && !camoufoxWaiting.length && !pool.running && !pool.waiting) return;

  // Never freeze Camoufox for a busy login queue (that starved recovery for 12h).
  if (isLoginQueueBusy() && accounts.length) {
    logFn(
      `[smart-refresh] User login queue busy — Camoufox recovery continues (${accounts.length} dead-RT; max ${pool.max})`
    );
  }

  // Rebuild waiting from latest priority-sorted due list (keep only a small buffer).
  camoufoxWaiting.length = 0;
  camoufoxWaitingKeys.clear();
  const buffer = Math.max(pool.max * 8, 16);
  enqueueCamoufoxWaiting(accounts.slice(0, buffer));

  drainCamoufoxPool();
  const after = getCamoufoxPoolStatus();
  if (after.running >= after.max) {
    logFn(
      `[smart-refresh] Camoufox pool full (${after.running}/${after.max}) — ${after.waiting} in pool, ${Math.max(0, accounts.length - buffer)} more due`
    );
  }
}

function mergeCamoufoxNeeds(camoufoxOnly, fromHttpFailures) {
  const seen = new Set();
  const out = [];
  for (const acc of [...camoufoxOnly, ...fromHttpFailures]) {
    const key = accountKey(acc);
    if (seen.has(key) || inFlight.has(key) || camoufoxWaitingKeys.has(key)) {
      continue;
    }
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

    // Bulk [job:] Camoufox steals mobile IP capacity. Pause it while recovering a large dead-RT pile.
    if (
      pauseLoginQueue &&
      !didAutoPauseQueue &&
      camoufoxOnly.length >= AUTO_PAUSE_QUEUE_AT &&
      isLoginQueueBusy()
    ) {
      try {
        pauseLoginQueue(true);
        didAutoPauseQueue = true;
        logFn(
          `[smart-refresh] Auto-paused login queue — ${camoufoxOnly.length} dead-RT need Camoufox (smart pool max ${CAMOUFOX_PARALLEL}). Resume queue when backlog is down.`
        );
      } catch (err) {
        logFn(`[smart-refresh] Could not auto-pause queue: ${err.message}`);
      }
    }

    const limits = resolveFastLaneLimits();
    if (limits.throttled && limits.reason) {
      logFn(
        limits.skipLane
          ? `[smart-refresh] Fast lane deferred (${limits.reason})`
          : `[smart-refresh] Fast lane throttled (${limits.reason}) — ${limits.parallel} parallel, batch ${limits.batch}`
      );
    }

    // When HTTP filled the IP but cooldown blocked rotate, keep trying rotate (no more HTTP).
    if (limits.skipLane && isProxyIpSaturated() && !isProxyRotating()) {
      await trackBrowserlessHttpOp((step, message) => {
        if (message) logFn(`[smart-refresh] [${step}] ${message}`);
      }).catch(() => {});
    }

    // Cookie PKCE SSO works even when stored RT is dead — include Camoufox-only in browserless batch.
    const browserlessBatch = limits.skipLane
      ? []
      : [...httpLane, ...camoufoxOnly].slice(0, limits.batch);
    const browserlessResults = browserlessBatch.length
      ? await runBrowserlessLane(browserlessBatch, limits.parallel)
      : [];

    const recoveredKeys = new Set(
      browserlessResults.filter((r) => r.ok).map((r) => accountKey(r.acc))
    );
    const fromHttpFailures = browserlessResults.filter((r) => r.needsCamoufox).map((r) => r.acc);
    const stillCamoufoxOnly = camoufoxOnly.filter((a) => !recoveredKeys.has(accountKey(a)));
    const needsCamoufox = mergeCamoufoxNeeds(stillCamoufoxOnly, fromHttpFailures);
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
    // onRefreshed (= broadcastAccounts) already invalidates + debounces stats rebuild.
    onRefreshed();
  }, 12_000);
}
