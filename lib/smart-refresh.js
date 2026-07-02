import { listAccountsDueForRefresh } from './account-export.js';
import { refreshAccountToken } from './account-actions.js';
import { beforeAccountRefresh } from './proxy.js';
import { isSmartRefreshEnabled, setSmartRefreshEnabled } from './settings.js';
import { isCamoufoxAvailable } from './camoufox-browser.js';
import { markProfileFailed } from './profile.js';

const CHECK_INTERVAL_MS = Number(process.env.SMART_REFRESH_INTERVAL_MS || 60_000);
const FAIL_BACKOFF_MS = Number(process.env.SMART_REFRESH_FAIL_BACKOFF_MS || 60 * 60 * 1000);
const REFRESH_SUCCESS_COOLDOWN_MS = Number(process.env.SMART_REFRESH_SUCCESS_COOLDOWN_MS || 45 * 60 * 1000);
const MAX_PER_TICK = Number(process.env.SMART_REFRESH_MAX_PER_TICK || 3);
const inFlight = new Set();
const lastFailAt = new Map();
const lastSuccessAt = new Map();

let timer = null;
let deferredTick = null;
let enqueueLogin = null;
let logFn = console.log;
let onRefreshed = null;
let refreshedBroadcastTimer = null;

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

export function initSmartRefresh({ enqueue, log, onRefreshed: cb }) {
  enqueueLogin = enqueue;
  if (log) logFn = log;
  onRefreshed = cb || null;
  stopSmartRefresh();
  timer = setInterval(() => tick().catch((err) => logFn('[smart-refresh]', err.message)), CHECK_INTERVAL_MS);
  // Defer first tick so user batches right after server start are not blocked behind token refresh.
  deferredTick = setTimeout(() => {
    deferredTick = null;
    tick().catch(() => {});
  }, CHECK_INTERVAL_MS);
}

/** Start or stop the background checker to match the persisted setting. */
export function syncSmartRefreshRuntime(deps) {
  if (!isSmartRefreshEnabled()) {
    stopSmartRefresh();
    return false;
  }
  if (!deps?.enqueue) return false;
  initSmartRefresh(deps);
  return true;
}

export function getSmartRefreshStatus() {
  return {
    enabled: isSmartRefreshEnabled(),
    inFlight: inFlight.size,
    checkIntervalSec: CHECK_INTERVAL_MS / 1000,
  };
}

export { setSmartRefreshEnabled, isSmartRefreshEnabled };

async function tick() {
  if (!isSmartRefreshEnabled() || !enqueueLogin) return;
  if (!(await isCamoufoxAvailable())) {
    logFn('[smart-refresh] Skipped — Camoufox binary not available on this host');
    return;
  }

  const due = await listAccountsDueForRefresh();
  if (!due.length) return;

  const now = Date.now();
  let queued = 0;

  for (const acc of due) {
    if (queued >= MAX_PER_TICK) break;

    const key = `${acc.email}::${acc.target}`;
    if (inFlight.has(key)) continue;

    const failedAt = lastFailAt.get(acc.email);
    if (failedAt && now - failedAt < FAIL_BACKOFF_MS) continue;

    const succeededAt = lastSuccessAt.get(acc.email);
    if (succeededAt && now - succeededAt < REFRESH_SUCCESS_COOLDOWN_MS) continue;

    inFlight.add(key);
    queued++;
    logFn(`[smart-refresh] Queued ${acc.email} (token due)`);

    enqueueLogin(async () => {
      try {
        await beforeAccountRefresh((step, message) =>
          logFn(`[smart-refresh:${acc.email}] [${step}] ${message}`)
        );
        await refreshAccountToken(acc.email, acc.target, {
          engine: 'camoufox',
          jobId: `smart-${Date.now()}`,
          onProgress: ({ step, message }) => logFn(`[smart-refresh:${acc.email}] [${step}] ${message}`),
        });
        lastFailAt.delete(acc.email);
        lastSuccessAt.set(acc.email, Date.now());
        logFn(`[smart-refresh] OK ${acc.email}`);
        scheduleRefreshedBroadcast();
      } catch (err) {
        lastFailAt.set(acc.email, Date.now());
        await markProfileFailed(acc.email, err.message).catch(() => {});
        logFn(`[smart-refresh] FAIL ${acc.email}: ${err.message}`);
      } finally {
        inFlight.delete(key);
      }
    }, { label: `smart-refresh: ${acc.email}` });
  }
}

function scheduleRefreshedBroadcast() {
  if (!onRefreshed) return;
  if (refreshedBroadcastTimer) clearTimeout(refreshedBroadcastTimer);
  refreshedBroadcastTimer = setTimeout(() => {
    refreshedBroadcastTimer = null;
    onRefreshed();
  }, 8000);
}
