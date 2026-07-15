import { sleep } from './anti-detect.js';
import { closeLocalProxy, getPlaywrightProxyConfig, ProxyUnreachableError } from './proxy-local.js';
import { waitForCamoufoxQuiet } from './camoufox-pool.js';
import {
  assertProxyReady,
  getAccountsOnIp,
  getPlaywrightProxy,
  getRotateUrl,
  getRotateAfter,
  isProxyEnabled,
  ACCOUNTS_PER_IP,
  setAccountsOnIp,
  setRotateAfter,
} from './settings.js';

export { getPlaywrightProxy, assertProxyReady, isProxyEnabled };
export { ProxyUnreachableError } from './proxy-local.js';

const ROTATE_WAIT_MS = Number(process.env.PROXY_ROTATE_WAIT_MS || 30_000);
/** Min gap between IP rotations — stops email-retry thrash from killing shared relays. */
const ROTATE_COOLDOWN_MS = Number(process.env.PROXY_ROTATE_COOLDOWN_MS || 120_000);
/** Short wait so email-retry rotate doesn't stall the login job for a full Camoufox tick. */
const ROTATE_DRAIN_MS = Number(process.env.PROXY_ROTATE_DRAIN_MS || 15_000);

let rotateChain = Promise.resolve();
let lastRotateAt = 0;
let rotating = false;

export function isProxyRotating() {
  return rotating;
}

export function msSinceLastProxyRotate() {
  return lastRotateAt ? Date.now() - lastRotateAt : Infinity;
}

async function connectProxy(log, { label, forceNewRelay = false } = {}) {
  const proxy = getPlaywrightProxy();
  // Reuse the local SOCKS relay across jobs — recreating it every time costs ~2–3s each.
  const cfg = await getPlaywrightProxyConfig({ forceNew: forceNewRelay, forceResolve: forceNewRelay });
  log?.('proxy', `Using ${cfg?.label || proxy.server}${label ? ` (${label})` : ''}.`);
  if (cfg?.mode === 'socks-relay') {
    log?.('proxy', `Local relay ${cfg.server} → Firefox (auth handled in-process).`);
  } else if (cfg?.mode === 'http-direct') {
    log?.('proxy', 'Direct HTTP CONNECT (no local relay).');
  }
  return cfg;
}

async function maybeRotateBeforeBrowserSession(log) {
  const onIp = getAccountsOnIp();
  const rotateAfter = Number(process.env.PROXY_ROTATE_EVERY) || getRotateAfter();

  if (onIp >= rotateAfter) {
    await rotateProxyIp(log);
    setAccountsOnIp(0);
    setRotateAfter(ACCOUNTS_PER_IP);
    log?.('proxy', `Next IP rotation after ${ACCOUNTS_PER_IP} browser session(s).`);
    return 0;
  }
  return onIp;
}

/** Login — rotate every N browser sessions, then connect proxy. */
export async function beforeAccountLogin(log) {
  if (!isProxyEnabled()) return;
  assertProxyReady();
  const onIp = await maybeRotateBeforeBrowserSession(log);
  await connectProxy(log, { label: `account ${onIp + 1} on this IP` });
}

/** Camoufox token capture / re-login browser work — same rotation counter as login. */
export async function beforeAccountBrowserSession(log) {
  if (!isProxyEnabled()) return;
  assertProxyReady();
  const onIp = await maybeRotateBeforeBrowserSession(log);
  await connectProxy(log, { label: `browser session ${onIp + 1} on this IP` });
}

export async function afterAccountLoginSuccess() {
  await afterAccountBrowserSession();
}

/** Bump IP rotation counter after a successful Camoufox login or session capture. */
export async function afterAccountBrowserSession() {
  if (!isProxyEnabled()) return;
  setAccountsOnIp(getAccountsOnIp() + 1);
}

/**
 * Browserless HTTP token refresh — proxy only, no IP rotation or counter bump.
 * (Camoufox fallback calls beforeAccountBrowserSession instead.)
 */
export async function beforeAccountRefresh(log) {
  if (!isProxyEnabled()) return;
  assertProxyReady();
  await connectProxy(log, { label: 'token refresh' });
}

/**
 * Rotate mobile IP. Serialized + cooldown so login email-retries cannot spam
 * changeip and tear down the shared SOCKS relay under active Camoufox/smart-refresh.
 * @returns {{ rotated: boolean, skipped?: boolean, reason?: string }}
 */
export async function rotateProxyIp(log) {
  const run = async () => {
    const ago = msSinceLastProxyRotate();
    if (ago < ROTATE_COOLDOWN_MS) {
      const left = Math.ceil((ROTATE_COOLDOWN_MS - ago) / 1000);
      log?.(
        'proxy',
        `Skipping rotation — last IP change ${Math.round(ago / 1000)}s ago (cooldown ${left}s left)`
      );
      return { rotated: false, skipped: true, reason: 'cooldown' };
    }

    rotating = true;
    try {
      const quiet = await waitForCamoufoxQuiet(ROTATE_DRAIN_MS);
      if (!quiet) {
        log?.(
          'proxy',
          `Camoufox still busy after ${Math.round(ROTATE_DRAIN_MS / 1000)}s — rotating anyway (may interrupt refresh)`
        );
      } else if (ROTATE_DRAIN_MS > 0) {
        log?.('proxy', 'Camoufox pool quiet — safe to rotate IP');
      }

      const url = getRotateUrl();
      log?.('proxy', 'Requesting mobile IP rotation…');
      const res = await fetch(url, { method: 'GET' });
      const body = await res.text().catch(() => '');
      if (!res.ok) {
        throw new Error(`Proxy rotation failed (${res.status}): ${body.slice(0, 120)}`);
      }
      log?.('proxy', `Rotation sent — waiting ${ROTATE_WAIT_MS / 1000}s for reconnect…`);
      await sleep(ROTATE_WAIT_MS);
      await closeLocalProxy();
      lastRotateAt = Date.now();
      log?.('proxy', 'Proxy should be ready on new IP.');
      return { rotated: true };
    } finally {
      rotating = false;
    }
  };

  const next = rotateChain.then(run, run);
  rotateChain = next.then(
    () => {},
    () => {}
  );
  return next;
}
