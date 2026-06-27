import { listAccountsDueForRefresh } from './account-export.js';
import { refreshAccountToken } from './account-actions.js';
import { isSmartRefreshEnabled, setSmartRefreshEnabled } from './settings.js';
import { isCamoufoxAvailable } from './camoufox-browser.js';

const CHECK_INTERVAL_MS = Number(process.env.SMART_REFRESH_INTERVAL_MS || 60_000);
const inFlight = new Set();

let timer = null;
let enqueueLogin = null;
let logFn = console.log;
let onRefreshed = null;

export function initSmartRefresh({ enqueue, log, onRefreshed: cb }) {
  enqueueLogin = enqueue;
  if (log) logFn = log;
  onRefreshed = cb || null;
  if (timer) clearInterval(timer);
  timer = setInterval(() => tick().catch((err) => logFn('[smart-refresh]', err.message)), CHECK_INTERVAL_MS);
  // Defer first tick so user batches right after server start are not blocked behind token refresh.
  setTimeout(() => tick().catch(() => {}), CHECK_INTERVAL_MS);
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

  for (const acc of due) {
    const key = `${acc.email}::${acc.target}`;
    if (inFlight.has(key)) continue;
    inFlight.add(key);
    logFn(`[smart-refresh] Queued ${acc.email} (token due)`);

    enqueueLogin(async () => {
      try {
        await refreshAccountToken(acc.email, acc.target, {
          engine: 'camoufox',
          jobId: `smart-${Date.now()}`,
          onProgress: ({ step, message }) => logFn(`[smart-refresh:${acc.email}] [${step}] ${message}`),
        });
        logFn(`[smart-refresh] OK ${acc.email}`);
        onRefreshed?.();
      } catch (err) {
        logFn(`[smart-refresh] FAIL ${acc.email}: ${err.message}`);
      } finally {
        inFlight.delete(key);
      }
    }, { label: `smart-refresh: ${acc.email}` });
  }
}
