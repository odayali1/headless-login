import { sleep } from './anti-detect.js';
import { closeLocalProxy, getLocalProxyForBrowser } from './proxy-local.js';
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

const ROTATE_WAIT_MS = Number(process.env.PROXY_ROTATE_WAIT_MS || 30_000);

export async function beforeAccountLogin(log) {
  if (!isProxyEnabled()) return;
  assertProxyReady();

  const onIp = getAccountsOnIp();
  const rotateAfter = Number(process.env.PROXY_ROTATE_EVERY) || getRotateAfter();

  if (onIp >= rotateAfter) {
    await rotateProxyIp(log);
    setAccountsOnIp(0);
    setRotateAfter(ACCOUNTS_PER_IP);
    log?.('proxy', `Next IP rotation after ${ACCOUNTS_PER_IP} account(s).`);
  }

  const proxy = getPlaywrightProxy();
  const relay = await getLocalProxyForBrowser();
  log?.('proxy', `Using mobile proxy ${proxy.server} (account ${onIp + 1} on this IP).`);
  log?.('proxy', `Local relay ${relay} → Firefox (SOCKS5 auth handled in-process).`);
}

export async function afterAccountLoginSuccess() {
  if (!isProxyEnabled()) return;
  setAccountsOnIp(getAccountsOnIp() + 1);
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
