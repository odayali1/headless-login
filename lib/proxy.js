import { sleep } from './anti-detect.js';
import { closeLocalProxy, getPlaywrightProxyConfig, ProxyUnreachableError } from './proxy-local.js';
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

export async function rotateProxyIp(log) {
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
  log?.('proxy', 'Proxy should be ready on new IP.');
}
