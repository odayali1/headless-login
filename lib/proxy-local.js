import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import {
  getProxyHttpUrl,
  getProxyPreferMode,
  getProxyUrl,
  isIproxyWifiSplitMode,
  isProxyEnabled,
  parseProxyUrl,
} from './settings.js';

let localProxyUrl = null;
let relayCreatePromise = null;
let resolvedMode = null;

const PROBE_TIMEOUT_MS = Number(process.env.PROXY_PROBE_TIMEOUT_MS || 20_000);
const WIFI_SPLIT_PROBE_RETRIES = Number(process.env.PROXY_WIFI_SPLIT_PROBE_RETRIES || 3);
const WIFI_SPLIT_PROBE_GAP_MS = Number(process.env.PROXY_WIFI_SPLIT_PROBE_GAP_MS || 8_000);

export class ProxyUnreachableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProxyUnreachableError';
  }
}

/**
 * Build upstream URL for proxy-chain.
 * SOCKS uses socks5h (DNS on proxy). HTTP uses HTTP CONNECT.
 */
function buildUpstreamUrl(parsed) {
  const user = encodeURIComponent(parsed.username);
  const pass = encodeURIComponent(parsed.password);
  const host = parsed.host;
  const port = parsed.port;

  if (parsed.protocol === 'http' || parsed.protocol === 'https') {
    return `http://${user}:${pass}@${host}:${port}`;
  }
  return `socks5h://${user}:${pass}@${host}:${port}`;
}

function httpDirectConfig(parsed) {
  return {
    mode: 'http-direct',
    server: `http://${parsed.host}:${parsed.port}`,
    username: parsed.username,
    password: parsed.password,
    label: `http://${parsed.host}:${parsed.port}`,
    parsed,
  };
}

function playwrightProxyFromConfig(cfg) {
  if (!cfg) return undefined;
  if (cfg.mode === 'http-direct') {
    return { server: cfg.server, username: cfg.username, password: cfg.password };
  }
  return { server: cfg.server };
}

export function resetProxyMode() {
  resolvedMode = null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function createRelay() {
  const p = parseProxyUrl(getProxyUrl());
  const upstream = buildUpstreamUrl(p);
  console.log(`[proxy] Creating local relay via ${p.protocol}://${p.host}:${p.port} (upstream DNS via proxy)`);
  return anonymizeProxy(upstream);
}

async function isRelayAlive(relayUrl) {
  if (!relayUrl) return false;
  try {
    const u = new URL(relayUrl);
    const { createConnection } = await import('node:net');
    await new Promise((resolve, reject) => {
      const socket = createConnection({ host: u.hostname, port: Number(u.port), timeout: 2_000 }, () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', reject);
      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error('relay connect timeout'));
      });
    });
    return true;
  } catch {
    return false;
  }
}

async function probeWithPlaywrightProxy(proxy, targetUrl = 'https://login.live.com/') {
  if (!proxy) return { ok: false, error: 'no proxy' };
  const { request } = await import('playwright-core');
  const ctx = await request.newContext({
    proxy,
    timeout: PROBE_TIMEOUT_MS,
  });
  try {
    const t0 = Date.now();
    const res = await ctx.get(targetUrl, { timeout: PROBE_TIMEOUT_MS, maxRedirects: 5 });
    return { ok: res.status() >= 200 && res.status() < 500, status: res.status(), ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    await ctx.dispose().catch(() => {});
  }
}

function httpUrlForWifiSplit() {
  const dedicated = getProxyHttpUrl();
  if (dedicated) return dedicated;
  const main = parseProxyUrl(getProxyUrl());
  if (main.protocol === 'http') return getProxyUrl();
  return null;
}

async function tryHttpProbe(httpUrl, { retries = 1 } = {}) {
  if (!httpUrl) return null;
  const proxy = playwrightProxyFromConfig(httpDirectConfig(parseProxyUrl(httpUrl)));
  for (let attempt = 1; attempt <= retries; attempt++) {
    const probe = await probeWithPlaywrightProxy(proxy);
    if (probe.ok) {
      resolvedMode = 'http-direct';
      console.log(`[proxy] Using direct HTTP CONNECT (${probe.ms}ms probe OK, attempt ${attempt}/${retries})`);
      return resolvedMode;
    }
    console.warn(`[proxy] HTTP probe failed (attempt ${attempt}/${retries}): ${probe.error}`);
    if (attempt < retries) {
      await sleep(WIFI_SPLIT_PROBE_GAP_MS);
    }
  }
  return null;
}

async function trySocksProbe() {
  const main = parseProxyUrl(getProxyUrl());
  if (main.protocol === 'http') return null;
  const relay = await getLocalProxyForBrowser({ forceNew: true });
  const relayProbe = await probeWithPlaywrightProxy({ server: relay });
  if (relayProbe.ok) {
    resolvedMode = 'socks-relay';
    console.log(`[proxy] Using SOCKS relay (${relayProbe.ms}ms probe OK)`);
    return resolvedMode;
  }
  console.warn(`[proxy] SOCKS relay probe failed: ${relayProbe.error}`);
  await closeLocalProxy().catch(() => {});
  return null;
}

/**
 * Wi-Fi Split on the phone: site fetch = mobile data, phone→relay upload = Wi-Fi.
 * From Coolify only HTTP :16857 is reliable; SOCKS + probe storms make the Wi-Fi uplink worse.
 */
export async function resolveProxyMode({ force = false } = {}) {
  if (!isProxyEnabled()) return null;
  if (!force && resolvedMode) return resolvedMode;

  const main = parseProxyUrl(getProxyUrl());
  const httpUrl = httpUrlForWifiSplit();
  const prefer = getProxyPreferMode();
  const wifiSplit = isIproxyWifiSplitMode();

  if (wifiSplit) {
    if (!httpUrl) {
      resolvedMode = null;
      console.warn('[proxy] IPROXY_WIFI_SPLIT=1 requires PROXY_HTTP_URL=http://host:16857:user:pass');
      return null;
    }
    const ok = await tryHttpProbe(httpUrl, { retries: WIFI_SPLIT_PROBE_RETRIES });
    if (ok) return resolvedMode;
    resolvedMode = null;
    return null;
  }

  if (prefer === 'http') {
    if (await tryHttpProbe(httpUrl, { retries: 1 })) return resolvedMode;
    if (await trySocksProbe()) return resolvedMode;
  } else if (prefer === 'socks') {
    if (await trySocksProbe()) return resolvedMode;
    if (await tryHttpProbe(httpUrl, { retries: 1 })) return resolvedMode;
  } else {
    if (await trySocksProbe()) return resolvedMode;
    if (await tryHttpProbe(httpUrl, { retries: 1 })) return resolvedMode;
  }

  if (main.protocol === 'http') {
    resolvedMode = 'http-direct';
    return resolvedMode;
  }

  resolvedMode = null;
  return null;
}

/** Proxy config for Playwright request API and Camoufox. */
export async function getPlaywrightProxyConfig({ forceNew = false, forceResolve = false } = {}) {
  if (!isProxyEnabled()) return null;

  await resolveProxyMode({ force: forceResolve });

  if (resolvedMode === 'http-direct') {
    const httpUrl = httpUrlForWifiSplit() || getProxyUrl();
    return httpDirectConfig(parseProxyUrl(httpUrl));
  }

  if (resolvedMode === 'socks-relay') {
    const relay = await getLocalProxyForBrowser({ forceNew });
    const main = parseProxyUrl(getProxyUrl());
    return {
      mode: 'socks-relay',
      server: relay,
      label: `socks5://${main.host}:${main.port} via relay`,
      parsed: main,
    };
  }

  throw new ProxyUnreachableError(
    isIproxyWifiSplitMode()
      ? 'Proxy unreachable with Wi-Fi Split ON. On the phone: restart the iProxy app, confirm home Wi-Fi has internet, Developer → Mobile data always on. Then retry.'
      : 'Proxy unreachable from this server — check phone mobile data and iProxy connection.'
  );
}

/**
 * Local HTTP proxy Firefox/Playwright can use without auth (SOCKS upstream only).
 * forceNew=true closes the previous relay and starts a clean one (use for each Camoufox launch).
 */
export async function getLocalProxyForBrowser({ forceNew = false } = {}) {
  if (!isProxyEnabled()) return null;

  if (!forceNew && resolvedMode === 'http-direct') {
    return null;
  }

  if (isIproxyWifiSplitMode()) {
    return null;
  }

  if (!forceNew && localProxyUrl && (await isRelayAlive(localProxyUrl))) {
    return localProxyUrl;
  }

  if (!forceNew && relayCreatePromise) {
    return relayCreatePromise;
  }

  relayCreatePromise = (async () => {
    if (localProxyUrl) {
      await closeAnonymizedProxy(localProxyUrl, true).catch(() => {});
      localProxyUrl = null;
    }
    localProxyUrl = await createRelay();
    return localProxyUrl;
  })();

  try {
    return await relayCreatePromise;
  } finally {
    relayCreatePromise = null;
  }
}

export async function closeLocalProxy() {
  resetProxyMode();
  if (relayCreatePromise) {
    await relayCreatePromise.catch(() => {});
    relayCreatePromise = null;
  }
  if (localProxyUrl) {
    await closeAnonymizedProxy(localProxyUrl, true).catch(() => {});
    localProxyUrl = null;
  }
}

/** Quick connectivity check through the active proxy path. */
export async function probeProxyReachability(targetUrl = 'https://login.live.com/') {
  if (!isProxyEnabled()) return { ok: true, skipped: true };

  try {
    const cfg = await getPlaywrightProxyConfig({ forceResolve: true });
    const proxy = playwrightProxyFromConfig(cfg);
    const t0 = Date.now();
    const result = await probeWithPlaywrightProxy(proxy, targetUrl);
    return {
      ...result,
      mode: cfg?.mode || null,
      label: cfg?.label || null,
      ms: result.ms ?? Date.now() - t0,
      relay: cfg?.mode === 'socks-relay' ? cfg.server : null,
    };
  } catch (err) {
    return { ok: false, error: err.message, mode: null, label: null };
  }
}
