import { listAccountsDueForRefresh } from './account-export.js';
import { refreshAccountToken, tryBrowserlessAccountRefresh } from './account-actions.js';
import {
  beforeAccountRefresh,
  isProxyRotating,
  isProxyIpSaturated,
  isLoginProxyExclusive,
  isLoginLiveShieldActive,
  isBrowserlessHttpBlocked,
  trackBrowserlessHttpOp,
  rotateHttpProxyWhenIdle,
} from './proxy.js';
import {
  isSmartRefreshEnabled,
  setSmartRefreshEnabled,
  isProxyEnabled,
  isHybridProxyEnabled,
} from './settings.js';
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
/**
 * Idle: Loki + cookie PKCE. During login: Loki-only (parallel busy), cookie SSO off.
 * Default 1 on proxy — parallel 2–4 + cookie SSO was burning GetCredentialType → gct=429.
 */
const BROWSERLESS_PARALLEL = envInt(
  'SMART_REFRESH_BROWSERLESS_PARALLEL',
  isProxyEnabled() ? 1 : 5,
  { min: 1, max: 8 }
);
/** During Camoufox login — keep-alive via Loki RT only (no hard pause for day-long bulk). */
const BROWSERLESS_PARALLEL_BUSY = envInt('SMART_REFRESH_BROWSERLESS_PARALLEL_BUSY', 1, { min: 1, max: 4 });
/** Gap between Loki calls while login owns the IP (ms). */
const LOGIN_LOKI_GAP_MS = envInt('SMART_REFRESH_LOGIN_LOKI_GAP_MS', 2_500, { min: 0, max: 30_000 });
/** Shared with manual Refresh (lib/camoufox-pool.js). */
const CAMOUFOX_PARALLEL = getCamoufoxPoolStatus().max;
/** Auto-pause bulk login queue when Camoufox-only backlog exceeds this (stops a 4th browser fighting smart). */
/** Disabled by default — pausing login for dead-RT Camoufox froze bulk login (set env to re-enable). */
const AUTO_PAUSE_QUEUE_AT = envInt('SMART_REFRESH_AUTO_PAUSE_QUEUE_AT', 999_999, { min: 10, max: 1_000_000 });
const TICK_BATCH_SIZE = envInt('SMART_REFRESH_TICK_BATCH_SIZE', Math.max(3, BROWSERLESS_PARALLEL * 3), {
  min: BROWSERLESS_PARALLEL,
  max: 8,
});
const TICK_BATCH_SIZE_BUSY = envInt('SMART_REFRESH_TICK_BATCH_SIZE_BUSY', 2, {
  min: 1,
  max: 8,
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
    fastLaneLokiOnly: !!limits.lokiOnly,
    fastLaneReason: limits.reason,
    camoufoxParallel: pool.max,
    camoufoxWaiting: camoufoxWaiting.length + pool.waiting,
    tickBatchSize: TICK_BATCH_SIZE,
    tickBatchSizeActive: limits.batch,
    priorityWindowMin: Math.round(PRIORITY_REFRESH_WINDOW_MS / 60_000),
  };
}

/**
 * Drain in-flight HTTP before GetCredentialType (email Next).
 * Cookie SSO / Loki beside that call causes gct=429 — brief quiet only, not day-long pause.
 */
export async function waitForSmartRefreshHttpQuiet(log, timeoutMs = 45_000) {
  if (inFlight.size === 0) return;
  log?.(
    'proxy',
    `Waiting for ${inFlight.size} in-flight HTTP refresh(es) to finish before GetCredentialType…`
  );
  const deadline = Date.now() + timeoutMs;
  while (inFlight.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
  }
  if (inFlight.size > 0) {
    log?.(
      'proxy',
      `WARNING: ${inFlight.size} HTTP refresh(es) still running — login may hit gct=429`
    );
  }
}

/**
 * Fast lane during login:
 * - Hybrid ON: keep Loki on residential (lokiOnly) — does not touch mobile / login.live.com
 * - Hybrid OFF: hard-pause (Loki on same mobile IP → gct=429)
 * Camoufox slow lane stays deferred while login owns Camoufox.
 */
export function resolveFastLaneLimits() {
  const q = getLoginQueueStatus();
  const loginRunning = (q.running || 0) > 0;
  const loginQueued = (q.waiting || 0) > 0 && !q.paused;
  const proxyRotating = isProxyRotating();
  const loginExclusive = isLoginProxyExclusive();
  const liveShield = isLoginLiveShieldActive();
  const ipSaturated = isProxyIpSaturated();
  const loginBusy = loginExclusive || loginRunning || loginQueued;
  const hybrid = isHybridProxyEnabled();

  // Hybrid: residential Loki continues during login / mobile rotate / GCT shield.
  if (hybrid && (loginBusy || liveShield || proxyRotating)) {
    return {
      parallel: BROWSERLESS_PARALLEL,
      batch: TICK_BATCH_SIZE,
      throttled: true,
      reason: loginBusy
        ? 'login — hybrid Loki on residential'
        : liveShield
          ? 'GCT shield — hybrid Loki on residential'
          : 'IP rotating — hybrid Loki on residential',
      skipLane: false,
      lokiOnly: true,
    };
  }

  if (loginBusy || liveShield || proxyRotating) {
    return {
      parallel: 0,
      batch: 0,
      throttled: true,
      reason: liveShield
        ? 'GetCredentialType shield'
        : proxyRotating
          ? 'IP rotating'
          : loginExclusive || loginRunning
            ? 'login in progress (HTTP paused)'
            : 'login queue waiting',
      skipLane: true,
      lokiOnly: false,
    };
  }
  if (ipSaturated) {
    return {
      parallel: 0,
      batch: 0,
      throttled: true,
      reason: 'HTTP IP saturated (awaiting rotate)',
      skipLane: true,
      lokiOnly: false,
    };
  }
  return {
    parallel: BROWSERLESS_PARALLEL,
    batch: TICK_BATCH_SIZE,
    throttled: false,
    reason: null,
    lokiOnly: false,
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

async function runBrowserlessLane(accounts, parallel = BROWSERLESS_PARALLEL, { lokiOnly = false } = {}) {
  if (!accounts.length) return [];

  logFn(
    lokiOnly
      ? `[smart-refresh] Fast lane: ${accounts.length} account(s), ${parallel} parallel (Loki-only — login shares IP)`
      : `[smart-refresh] Fast lane: ${accounts.length} account(s), ${parallel} parallel (HTTP/Loki only)`
  );

  let skippedValid = 0;

  const results = await runParallel(accounts, parallel, async (acc) => {
    // Abort remaining batch if GCT shield / rotate mid-tick.
    const live = resolveFastLaneLimits();
    if (live.skipLane || isBrowserlessHttpBlocked()) {
      return { acc, ok: false, deferred: true };
    }
    if (lokiOnly && LOGIN_LOKI_GAP_MS > 0) {
      await new Promise((r) => setTimeout(r, LOGIN_LOKI_GAP_MS));
      if (resolveFastLaneLimits().skipLane || isBrowserlessHttpBlocked()) {
        return { acc, ok: false, deferred: true };
      }
    }
    const key = `${acc.email}::${acc.target}`;
    inFlight.add(key);
    try {
      const result = await tryBrowserlessAccountRefresh(acc.email, acc.target, {
        jobId: `smart-bl-${Date.now()}`,
        lokiOnly: lokiOnly || live.lokiOnly,
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
        // Only real browserless successes count toward idle IP rotate (default every 100).
        await trackBrowserlessHttpOp(
          (step, message) => {
            if (message) logFn(`[smart-refresh] [${step}] ${message}`);
          },
          { success: true, via }
        ).catch(() => {});
        return { acc, ok: true };
      }
      // Cookie SSO deferred during login — do not pile Camoufox beside the login browser.
      if (result.deferred || result.skippedHttp || result.deferredCookie) {
        return { acc, ok: false, deferred: true };
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
  if (isLoginProxyExclusive() || isLoginQueueBusy()) return;
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
  // Login holds Camoufox + SOCKS pins — never open a second browser beside it.
  if (isLoginProxyExclusive() || isLoginQueueBusy()) {
    enqueueCamoufoxWaiting([acc]);
    return { acc, ok: false, deferred: true };
  }
  inFlight.add(key);

  try {
    await withCamoufoxSlot(async () => {
      if (isLoginProxyExclusive() || isLoginQueueBusy()) {
        const err = new Error('Login in progress — Camoufox refresh deferred');
        err.code = 'CAMOUFOX_DEFERRED';
        throw err;
      }
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
    // Do NOT mark fail/backoff — that inflated "needs refresh" while login ran.
    if (err?.code === 'CAMOUFOX_DEFERRED' || /Camoufox refresh deferred/i.test(err.message)) {
      enqueueCamoufoxWaiting([acc]);
      logFn(`[smart-refresh] Deferred ${acc.email} (login) — Camoufox will retry after queue`);
      return { acc, ok: false, deferred: true };
    }
    lastFailAt.set(acc.email, Date.now());
    await markProfileRefreshFailed(acc.email, err.message).catch(() => {});
    invalidateAccountsCache();
    logFn(`[smart-refresh] FAIL ${acc.email}: ${err.message}`);
    return { acc, ok: false };
  } finally {
    inFlight.delete(key);
    invalidateAccountsCache();
    scheduleRefreshedBroadcast();
    if (!isLoginProxyExclusive() && !isLoginQueueBusy()) {
      drainCamoufoxPool();
    }
  }
}

async function runCamoufoxLane(accounts) {
  const pool = getCamoufoxPoolStatus();
  if (!accounts.length && !camoufoxWaiting.length && !pool.running && !pool.waiting) return;

  // CRITICAL: do NOT run Camoufox beside login — pin/rotate deadlock + lookup failures.
  // Keep the waiting list (do not clear) so dead-RT resume after the login batch.
  if (isLoginProxyExclusive() || isLoginQueueBusy()) {
    if (accounts.length) {
      enqueueCamoufoxWaiting(accounts);
      logFn(
        `[smart-refresh] Slow lane deferred (login) — ${camoufoxWaiting.length} dead-RT queued for after login`
      );
    }
    return;
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

    // Idle rotate after N browserless successes — never mid cookie-SSO / Loki.
    if (
      isProxyIpSaturated() &&
      inFlight.size === 0 &&
      !isProxyRotating() &&
      !isLoginProxyExclusive()
    ) {
      const q = getLoginQueueStatus();
      if ((q.running || 0) === 0 && ((q.waiting || 0) === 0 || q.paused)) {
        await rotateHttpProxyWhenIdle((step, message) => {
          if (message) logFn(`[smart-refresh] [${step}] ${message}`);
        }).catch((err) => {
          logFn(`[smart-refresh] [proxy] Idle rotate error: ${err?.message || err}`);
        });
      }
    }

    // Idle: cookie SSO can recover dead-RT. During login: Loki-only — skip dead-RT (need cookie/Camoufox).
    const limitsAfterRotate = resolveFastLaneLimits();
    const browserlessPool = limitsAfterRotate.lokiOnly
      ? httpLane
      : [...httpLane, ...camoufoxOnly];
    const browserlessBatch = limitsAfterRotate.skipLane
      ? []
      : browserlessPool.slice(0, limitsAfterRotate.batch);
    const browserlessResults = browserlessBatch.length
      ? await runBrowserlessLane(browserlessBatch, limitsAfterRotate.parallel, {
          lokiOnly: !!limitsAfterRotate.lokiOnly,
        })
      : [];

    const recoveredKeys = new Set(
      browserlessResults.filter((r) => r.ok).map((r) => accountKey(r.acc))
    );
    const fromHttpFailures = browserlessResults.filter((r) => r.needsCamoufox).map((r) => r.acc);
    const stillCamoufoxOnly = camoufoxOnly.filter((a) => !recoveredKeys.has(accountKey(a)));
    const needsCamoufox = mergeCamoufoxNeeds(stillCamoufoxOnly, fromHttpFailures);
    // Camoufox lane self-defers during login and keeps a waiting queue (HTTP lane stays active).
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
