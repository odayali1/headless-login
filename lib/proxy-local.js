import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { getProxyUrl, isProxyEnabled, parseProxyUrl } from './settings.js';

let localProxyUrl = null;

/** Upstream SOCKS5 with auth → local HTTP proxy Firefox can use without auth. */
export async function getLocalProxyForBrowser() {
  if (!isProxyEnabled()) return null;

  const p = parseProxyUrl(getProxyUrl());
  const upstream = `socks5://${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@${p.host}:${p.port}`;

  if (localProxyUrl) {
    await closeAnonymizedProxy(localProxyUrl, true).catch(() => {});
    localProxyUrl = null;
  }

  localProxyUrl = await anonymizeProxy(upstream);
  return localProxyUrl;
}

export async function closeLocalProxy() {
  if (localProxyUrl) {
    await closeAnonymizedProxy(localProxyUrl, true).catch(() => {});
    localProxyUrl = null;
  }
}
