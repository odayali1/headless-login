import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import {
  getProxyHttpUrl,
  getProxyUrl,
  isIproxyWifiSplitMode,
  isProxyEnabled,
  parseProxyUrl,
} from './settings.js';

let localProxyUrl = null;
let relayCreatePromise = null;
let resolvedMode = null;

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
    timeout: 20_000,
  });
  try {
    const t0 = Date.now();
    const res = await ctx.get(targetUrl, { timeout: 20_000, maxRedirects: 5 });
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

/**
 * Pick SOCKS relay vs direct HTTP CONNECT.
 * Wi-Fi Split: SOCKS+relay from Coolify often hangs; HTTP :16857 works like curl.
 */
export async function resolveProxyMode({ force = false } = {}) {
  if (!isProxyEnabled()) return null;
  if (!force && resolvedMode) return resolvedMode;

  const main = parseProxyUrl(getProxyUrl());
  const httpUrl = httpUrlForWifiSplit();

  if (isIproxyWifiSplitMode()) {
    if (!httpUrl) {
      console.warn(
        '[proxy] IPROXY_WIFI_SPLIT=1 but PROXY_HTTP_URL is not set — add HTTP port :16857 credentials on Coolify'
      );
    } else {
      const probe = await probeWithPlaywrightProxy(playwrightProxyFromConfig(httpDirectConfig(parseProxyUrl(httpUrl))));
      if (probe.ok) {
        resolvedMode = 'http-direct';
        console.log(`[proxy] Wi-Fi Split mode: using direct HTTP CONNECT (${probe.ms}ms probe OK)`);
        return resolvedMode;
      }
      console.warn(`[proxy] Wi-Fi Split HTTP probe failed: ${probe.error}`);
    }
  }

  if (main.protocol === 'http') {
    const probe = await probeWithPlaywrightProxy(playwrightProxyFromConfig(httpDirectConfig(main)));
    resolvedMode = probe.ok ? 'http-direct' : 'http-direct';
    return resolvedMode;
  }

  const relay = await getLocalProxyForBrowser({ forceNew: true });
  const relayProbe = await probeWithPlaywrightProxy({ server: relay });
  if (relayProbe.ok) {
    resolvedMode = 'socks-relay';
    return resolvedMode;
  }

  if (httpUrl) {
    const httpProbe = await probeWithPlaywrightProxy(
      playwrightProxyFromConfig(httpDirectConfig(parseProxyUrl(httpUrl)))
    );
    if (httpProbe.ok) {
      resolvedMode = 'http-direct';
      console.warn(
        `[proxy] SOCKS relay failed (${relayProbe.error}) — using PROXY_HTTP_URL direct HTTP (${httpProbe.ms}ms)`
      );
      await closeLocalProxy().catch(() => {});
      return resolvedMode;
    }
  }

  resolvedMode = 'socks-relay';
  return resolvedMode;
}

/** Proxy config for Playwright request API and Camoufox. */
export async function getPlaywrightProxyConfig({ forceNew = false, forceResolve = false } = {}) {
  if (!isProxyEnabled()) return null;

  await resolveProxyMode({ force: forceResolve });

  if (resolvedMode === 'http-direct') {
    const httpUrl = httpUrlForWifiSplit() || getProxyUrl();
    return httpDirectConfig(parseProxyUrl(httpUrl));
  }

  const relay = await getLocalProxyForBrowser({ forceNew });
  const main = parseProxyUrl(getProxyUrl());
  return {
    mode: 'socks-relay',
    server: relay,
    label: `socks5://${main.host}:${main.port} via relay`,
    parsed: main,
  };
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
}
