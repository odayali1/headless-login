import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import {
  getProxyHttpUrl,
  getProxyPreferMode,
  getProxyUrl,
  isIproxyWifiSplitMode,
  isMobileRelayProxy,
  isProxyEnabled,
  parseProxyUrl,
} from './settings.js';

const execFileAsync = promisify(execFile);

let localProxyUrl = null;
let relayCreatePromise = null;
let resolvedMode = null;
let lastProbeLatencyMs = null;
let browserPathSplitBlocked = false;

export function getLastProbeLatencyMs() {
  return lastProbeLatencyMs;
}

export function isBrowserPathSplitBlocked() {
  return browserPathSplitBlocked;
}

export function setBrowserPathSplitBlocked(value) {
  browserPathSplitBlocked = !!value;
}

const PROBE_TIMEOUT_MS = Number(process.env.PROXY_PROBE_TIMEOUT_MS || 25_000);
const WIFI_SPLIT_PROBE_RETRIES = Number(process.env.PROXY_WIFI_SPLIT_PROBE_RETRIES || 2);
const WIFI_SPLIT_PROBE_GAP_MS = Number(process.env.PROXY_WIFI_SPLIT_PROBE_GAP_MS || 3_000);
/** HTTP probe above this → Wi‑Fi Split uplink is struggling; prefer SOCKS + Teams-first in refresh. */
export const SLOW_PROBE_MS = Number(process.env.PROXY_SLOW_PROBE_MS || 5_000);

export function isSlowProxyProbe(ms) {
  return ms != null && ms > SLOW_PROBE_MS;
}

export class ProxyUnreachableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProxyUnreachableError';
  }
}

/** curl OK but Playwright/browser path dead — typical Wi‑Fi Split ON on iProxy. */
export class ProxySplitBlockedError extends ProxyUnreachableError {
  constructor(message) {
    super(message);
    this.name = 'ProxySplitBlockedError';
  }
}

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
  browserPathSplitBlocked = false;
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

/** Same check you ran manually in Coolify — fast and reliable on Wi-Fi Split. */
async function probeWithCurlHttp(parsed, targetUrl = 'https://login.live.com/') {
  const proxy = buildUpstreamUrl(parsed);
  const sec = Math.max(5, Math.ceil(PROBE_TIMEOUT_MS / 1000));
  const nullDev = process.platform === 'win32' ? 'NUL' : '/dev/null';
  try {
    const t0 = Date.now();
    const { stdout } = await execFileAsync(
      'curl',
      ['-sS', '-x', proxy, '-m', String(sec), '-o', nullDev, '-w', '%{http_code}', targetUrl],
      { timeout: PROBE_TIMEOUT_MS + 5_000 }
    );
    const code = Number(stdout.trim());
    const ms = Date.now() - t0;
    return { ok: code >= 200 && code < 500, status: code, ms, via: 'curl' };
  } catch (err) {
    return { ok: false, error: err.message, via: 'curl' };
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
    return { ok: res.status() >= 200 && res.status() < 500, status: res.status(), ms: Date.now() - t0, via: 'playwright' };
  } catch (err) {
    return { ok: false, error: err.message, via: 'playwright' };
  } finally {
    await ctx.dispose().catch(() => {});
  }
}

/** On mobile relay, Camoufox uses Playwright-style HTTP — curl alone is misleading on Wi‑Fi Split. */
async function probeHttpDirect(parsed, targetUrl = 'https://login.live.com/') {
  const pw = await probeWithPlaywrightProxy(playwrightProxyFromConfig(httpDirectConfig(parsed)), targetUrl);

  if (isMobileRelayProxy()) {
    if (!pw.ok && process.platform !== 'win32') {
      const curl = await probeWithCurlHttp(parsed, targetUrl);
      if (curl.ok) {
        console.warn(
          `[proxy] curl OK (${curl.ms}ms) but Playwright FAIL — Wi-Fi Split blocks browser traffic (not MSAL)`
        );
        browserPathSplitBlocked = true;
        return {
          ok: false,
          error:
            'Wi-Fi Split ON: curl works but browser path is blocked. Turn traffic split OFF on the iProxy phone app, restart iProxy, then retry.',
          via: 'playwright',
          curlOk: true,
          curlMs: curl.ms,
          splitBlocked: true,
        };
      }
    }
    return pw;
  }

  if (process.platform !== 'win32') {
    const curl = await probeWithCurlHttp(parsed, targetUrl);
    if (curl.ok) return curl;
  }
  return pw;
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
  const parsed = parseProxyUrl(httpUrl);
  for (let attempt = 1; attempt <= retries; attempt++) {
    const probe = await probeHttpDirect(parsed);
    if (probe.splitBlocked) {
      console.warn(`[proxy] HTTP browser probe blocked: ${probe.error}`);
      return null;
    }
    if (probe.ok) {
      lastProbeLatencyMs = probe.ms ?? null;
      resolvedMode = 'http-direct';
      console.log(
        `[proxy] Using direct HTTP CONNECT (${probe.via} ${probe.ms}ms probe OK, attempt ${attempt}/${retries})`
      );
      return resolvedMode;
    }
    console.warn(`[proxy] HTTP probe failed (attempt ${attempt}/${retries}, ${probe.via}): ${probe.error}`);
    if (attempt < retries) {
      await sleep(WIFI_SPLIT_PROBE_GAP_MS);
    }
  }
  return null;
}

async function closeRelayOnly() {
  if (relayCreatePromise) {
    await relayCreatePromise.catch(() => {});
    relayCreatePromise = null;
  }
  if (localProxyUrl) {
    await closeAnonymizedProxy(localProxyUrl, true).catch(() => {});
    localProxyUrl = null;
  }
}

async function trySocksProbe({ forCompare = false } = {}) {
  if (
    !forCompare &&
    (isIproxyWifiSplitMode() || (isMobileRelayProxy() && getProxyPreferMode() === 'http'))
  ) {
    return null;
  }

  const main = parseProxyUrl(getProxyUrl());
  if (main.protocol === 'http') return null;
  const relay = await getLocalProxyForBrowser({ forceNew: true, forProbe: true });
  const relayProbe = await probeWithPlaywrightProxy({ server: relay });
  if (relayProbe.ok) {
    lastProbeLatencyMs = relayProbe.ms ?? null;
    resolvedMode = 'socks-relay';
    console.log(`[proxy] Using SOCKS relay (${relayProbe.ms}ms probe OK)`);
    return resolvedMode;
  }
  console.warn(`[proxy] SOCKS relay probe failed: ${relayProbe.error}`);
  await closeRelayOnly();
  return null;
}

async function detectWifiSplitBlocked(httpParsed) {
  if (process.platform === 'win32') return false;
  const curl = await probeWithCurlHttp(httpParsed);
  if (!curl.ok) return false;
  const pw = await probeWithPlaywrightProxy(playwrightProxyFromConfig(httpDirectConfig(httpParsed)));
  if (!pw.ok) {
    console.warn(`[proxy] Wi-Fi Split uplink: curl ${curl.ms}ms OK, HTTP browser blocked`);
    return true;
  }
  return false;
}

async function tryMobileRelayMode(httpUrl) {
  if (!httpUrl) {
    resolvedMode = null;
    console.warn('[proxy] Mobile relay requires PROXY_HTTP_URL=http://host:16857:user:pass');
    return null;
  }

  const httpParsed = parseProxyUrl(httpUrl);
  const prefer = getProxyPreferMode();
  const splitBlocked = await detectWifiSplitBlocked(httpParsed);
  browserPathSplitBlocked = splitBlocked;

  if (splitBlocked) {
    // Split ON: HTTP browser dead, SOCKS works, curl works (your tests).
    if (await trySocksProbe({ forCompare: true })) {
      const curl = await probeWithCurlHttp(httpParsed);
      console.log(
        `[proxy] Wi-Fi Split ON: SOCKS for Camoufox (${lastProbeLatencyMs}ms)` +
          (curl.ok ? `, HTTP curl for tokens (${curl.ms}ms)` : '')
      );
      return resolvedMode;
    }
    await closeRelayOnly();
    const curl = await probeWithCurlHttp(httpParsed);
    if (curl.ok) {
      lastProbeLatencyMs = curl.ms;
      console.warn('[proxy] Wi-Fi Split ON: only curl token refresh available (browser path dead)');
    }
    resolvedMode = null;
    return null;
  }

  // Split OFF — same as before: respect PROXY_PREFER (HTTP first when set).
  browserPathSplitBlocked = false;
  if (prefer === 'http') {
    if (await tryHttpProbe(httpUrl, { retries: 1 })) return resolvedMode;
    if (await trySocksProbe({ forCompare: true })) return resolvedMode;
  } else if (prefer === 'socks') {
    if (await trySocksProbe({ forCompare: true })) return resolvedMode;
    if (await tryHttpProbe(httpUrl, { retries: 1 })) return resolvedMode;
  } else {
    if (await trySocksProbe({ forCompare: true })) return resolvedMode;
    if (await tryHttpProbe(httpUrl, { retries: 1 })) return resolvedMode;
  }

  resolvedMode = null;
  return null;
}

export async function resolveProxyMode({ force = false } = {}) {
  if (!isProxyEnabled()) return null;
  if (!force && resolvedMode) return resolvedMode;

  const main = parseProxyUrl(getProxyUrl());
  const httpUrl = httpUrlForWifiSplit();
  const prefer = getProxyPreferMode();

  if (isMobileRelayProxy() && httpUrl) {
    return tryMobileRelayMode(httpUrl);
  }

  const forceHttpPath = isIproxyWifiSplitMode();

  if (forceHttpPath) {
    if (!httpUrl) {
      resolvedMode = null;
      console.warn('[proxy] Mobile relay HTTP path requires PROXY_HTTP_URL=http://host:16857:user:pass');
      return null;
    }
    if (await tryHttpProbe(httpUrl, { retries: WIFI_SPLIT_PROBE_RETRIES })) {
      return resolvedMode;
    }
    if (await trySocksProbe({ forCompare: true })) {
      return resolvedMode;
    }
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
      ? 'Proxy unreachable with Wi-Fi Split ON. Restart iProxy on the phone and retry.'
      : 'Proxy unreachable from this server — check phone mobile data and iProxy connection.'
  );
}

export async function getLocalProxyForBrowser({ forceNew = false, forProbe = false } = {}) {
  if (!isProxyEnabled()) return null;

  if (!forProbe && resolvedMode === 'http-direct') {
    return null;
  }

  if (
    !forProbe &&
    resolvedMode !== 'socks-relay' &&
    (isIproxyWifiSplitMode() || (isMobileRelayProxy() && getProxyPreferMode() === 'http'))
  ) {
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

/** Pre-Camoufox check — on mobile relay uses Playwright (same stack as the browser). */
export async function probeProxyReachability(targetUrl = 'https://login.live.com/') {
  if (!isProxyEnabled()) return { ok: true, skipped: true };

  try {
    if (!resolvedMode) {
      await resolveProxyMode({ force: true });
    }

    if (resolvedMode === 'http-direct') {
      const httpUrl = httpUrlForWifiSplit() || getProxyUrl();
      const parsed = parseProxyUrl(httpUrl);
      const result = isMobileRelayProxy()
        ? await probeWithPlaywrightProxy(playwrightProxyFromConfig(httpDirectConfig(parsed)), targetUrl)
        : await probeHttpDirect(parsed, targetUrl);
      if (!result.ok && isMobileRelayProxy() && process.platform !== 'win32' && resolvedMode !== 'socks-relay') {
        const curl = await probeWithCurlHttp(parsed, targetUrl);
        if (curl.ok) {
          browserPathSplitBlocked = true;
          return {
            ok: false,
            error:
              'Wi-Fi Split ON: curl works but browser path is blocked. Turn traffic split OFF on the iProxy phone app, restart iProxy, then retry.',
            via: 'playwright',
            curlOk: true,
            curlMs: curl.ms,
            splitBlocked: true,
            mode: 'http-direct',
            label: `http://${parsed.host}:${parsed.port}`,
          };
        }
      }
      if (result.ok && result.ms != null) {
        lastProbeLatencyMs = result.ms;
        browserPathSplitBlocked = false;
      }
      return {
        ...result,
        mode: 'http-direct',
        label: `http://${parsed.host}:${parsed.port}`,
      };
    }

    if (resolvedMode === 'socks-relay') {
      const cfg = await getPlaywrightProxyConfig();
      const result = await probeWithPlaywrightProxy(playwrightProxyFromConfig(cfg), targetUrl);
      return {
        ...result,
        mode: 'socks-relay',
        label: cfg.label,
        relay: cfg.server,
      };
    }

    return { ok: false, error: 'proxy mode not resolved', mode: null, label: null };
  } catch (err) {
    return { ok: false, error: err.message, mode: null, label: null };
  }
}
