import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import {
  getProxyHttpUrl,
  getProxyPreferMode,
  getProxyUrl,
  getMobileProxyUrl,
  getResidentialProxyUrl,
  isHybridProxyEnabled,
  isLoginResidentialIpv4,
  isMobileRelayProxy,
  isProxyEnabled,
  isResidentialProxy,
  parseProxyUrl,
} from './settings.js';

const execFileAsync = promisify(execFile);

let localProxyUrl = null;
let relayCreatePromise = null;
/** Separate relay for hybrid Loki/MSAL (residential IPv6) — never shared with Camoufox mobile/IPv4. */
let residentialRelayUrl = null;
let residentialRelayPromise = null;
/** Mobile relay for cookie SSO when Camoufox login is on residential IPv4. */
let mobileCookieRelayUrl = null;
let mobileCookieRelayPromise = null;
let resolvedMode = null;
let lastProbeLatencyMs = null;
/** Single-flight resolve — parallel probes used to forceNew+closeRelay and kill live Camoufox. */
let resolvePromise = null;
/** Live Camoufox sessions bound to the current shared mobile SOCKS relay port. */
let relayPinCount = 0;
/** Cookie SSO sessions using shared mobile and/or dedicated mobile-cookie relay. */
let cookieSsoRelayPinCount = 0;
let mobileCookiePinCount = 0;
/** Per-login dedicated relays for residential (never shared across parallel Camoufox). */
const dedicatedLoginRelays = new Map();
let dedicatedLoginSeq = 0;

/** Call when Camoufox launches with the shared SOCKS relay — blocks closeLocalProxy. */
export function pinLocalProxyRelay() {
  relayPinCount += 1;
}

/** Call from session.close() so rotate/teardown can reclaim the relay. */
export function unpinLocalProxyRelay() {
  relayPinCount = Math.max(0, relayPinCount - 1);
}

export function getLocalProxyRelayPinCount() {
  return relayPinCount;
}

/**
 * Cookie SSO (browserless) holds 127.0.0.1 relays open.
 * Pin both shared mobile + mobile-cookie relays so rotate/teardown cannot
 * ECONNREFUSED mid-batch (smart-refresh Fast lane hang at 10k–55k accounts).
 */
export function pinCookieSsoRelay() {
  cookieSsoRelayPinCount += 1;
  relayPinCount += 1;
  mobileCookiePinCount += 1;
}

export function unpinCookieSsoRelay() {
  cookieSsoRelayPinCount = Math.max(0, cookieSsoRelayPinCount - 1);
  relayPinCount = Math.max(0, relayPinCount - 1);
  mobileCookiePinCount = Math.max(0, mobileCookiePinCount - 1);
}

export function getCookieSsoRelayPinCount() {
  return cookieSsoRelayPinCount;
}

/**
 * One isolated upstream path per residential Camoufox login.
 * Parallel logins must NOT share a relay — rotating providers assign exits per connection,
 * and closing/recreating a shared relay mid-login kills sibling sessions.
 *
 * Always use a dedicated local anonymized relay (HTTP or SOCKS upstream).
 * Camoufox/Firefox often fails HTTP proxy username/password auth; proxy-chain holds
 * the credentials and exposes a plain http://127.0.0.1:port to the browser.
 */
export async function createDedicatedLoginProxy() {
  if (!isProxyEnabled()) return null;
  const raw = getProxyUrl();
  const parsed = parseProxyUrl(raw);

  const id = `login-${++dedicatedLoginSeq}`;
  const relayUrl = await createRelayFromParsed(parsed, `dedicated ${id}`);
  dedicatedLoginRelays.set(id, relayUrl);
  console.log(
    `[proxy] Dedicated login relay ${relayUrl} → ${parsed.protocol}://${parsed.host}:${parsed.port} (${id})`
  );
  return {
    mode: 'socks-relay',
    shared: false,
    id,
    server: relayUrl,
    label: `dedicated ${parsed.protocol}://${parsed.host}:${parsed.port} via ${relayUrl}`,
    parsed,
    close: async () => {
      const url = dedicatedLoginRelays.get(id);
      if (!url) return;
      dedicatedLoginRelays.delete(id);
      await closeAnonymizedProxy(url, true).catch(() => {});
      console.log(`[proxy] Closed dedicated login relay ${id}`);
    },
  };
}

export function getLastProbeLatencyMs() {
  return lastProbeLatencyMs;
}

const PROBE_TIMEOUT_MS = Number(process.env.PROXY_PROBE_TIMEOUT_MS || 25_000);

export class ProxyUnreachableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProxyUnreachableError';
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
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function createRelayFromParsed(p, label = '') {
  const upstream = buildUpstreamUrl(p);
  console.log(
    `[proxy] Creating local relay via ${p.protocol}://${p.host}:${p.port}${label ? ` (${label})` : ''} (upstream DNS via proxy)`
  );
  return anonymizeProxy(upstream);
}

async function createRelay() {
  return createRelayFromParsed(parseProxyUrl(getProxyUrl()));
}

/**
 * Residential SOCKS relay for hybrid browserless HTTP (Loki/MSAL).
 * Independent from the mobile Camoufox relay so login changeip cannot kill refresh TLS.
 */
export async function getResidentialSocksRelay({ forceNew = false } = {}) {
  if (!isProxyEnabled()) return null;
  const raw = getResidentialProxyUrl();
  if (!raw) {
    throw new Error('Residential proxy URL missing — set PROXY_RESIDENTIAL_URL or built-in hybrid URL.');
  }
  const parsed = parseProxyUrl(raw);

  if (residentialRelayPromise) {
    return residentialRelayPromise;
  }

  if (!forceNew && residentialRelayUrl && (await isRelayAlive(residentialRelayUrl))) {
    return residentialRelayUrl;
  }

  residentialRelayPromise = (async () => {
    if (residentialRelayUrl) {
      await closeAnonymizedProxy(residentialRelayUrl, true).catch(() => {});
      residentialRelayUrl = null;
    }
    residentialRelayUrl = await createRelayFromParsed(parsed, 'residential hybrid');
    return residentialRelayUrl;
  })();

  try {
    return await residentialRelayPromise;
  } finally {
    residentialRelayPromise = null;
  }
}

export async function closeResidentialRelay() {
  if (residentialRelayPromise) {
    await residentialRelayPromise.catch(() => {});
    residentialRelayPromise = null;
  }
  if (residentialRelayUrl) {
    await closeAnonymizedProxy(residentialRelayUrl, true).catch(() => {});
    residentialRelayUrl = null;
  }
}

/**
 * Mobile SOCKS relay for cookie SSO when login Camoufox is on residential IPv4.
 * Independent from the login/IPv4 relay so cookie can stay on the phone.
 */
export async function getMobileSocksRelay({ forceNew = false } = {}) {
  if (!isProxyEnabled()) return null;
  const raw = getMobileProxyUrl();
  if (!raw) throw new Error('Mobile proxy URL missing');
  const parsed = parseProxyUrl(raw);

  if (mobileCookieRelayPromise) {
    return mobileCookieRelayPromise;
  }

  const alive = !!(mobileCookieRelayUrl && (await isRelayAlive(mobileCookieRelayUrl)));
  if (alive && !(forceNew && mobileCookiePinCount === 0)) {
    if (forceNew) {
      console.warn('[proxy] Keeping live mobile-cookie relay (cookie SSO still using it)');
    }
    return mobileCookieRelayUrl;
  }
  if (!alive && mobileCookieRelayUrl && mobileCookiePinCount > 0) {
    console.warn('[proxy] Keeping pinned mobile-cookie relay despite probe miss');
    return mobileCookieRelayUrl;
  }

  mobileCookieRelayPromise = (async () => {
    if (mobileCookieRelayUrl) {
      await closeAnonymizedProxy(mobileCookieRelayUrl, true).catch(() => {});
      mobileCookieRelayUrl = null;
    }
    mobileCookieRelayUrl = await createRelayFromParsed(parsed, 'mobile cookie');
    return mobileCookieRelayUrl;
  })();

  try {
    return await mobileCookieRelayPromise;
  } finally {
    mobileCookieRelayPromise = null;
  }
}

export async function closeMobileCookieRelay() {
  if (mobileCookiePinCount > 0) {
    console.warn(
      `[proxy] Skipping mobile-cookie relay teardown — ${mobileCookiePinCount} cookie SSO still using it`
    );
    return;
  }
  if (mobileCookieRelayPromise) {
    await mobileCookieRelayPromise.catch(() => {});
    mobileCookieRelayPromise = null;
  }
  if (mobileCookieRelayUrl) {
    await closeAnonymizedProxy(mobileCookieRelayUrl, true).catch(() => {});
    mobileCookieRelayUrl = null;
  }
}

/**
 * Playwright proxy opts by lane:
 * - http-refresh: hybrid Loki/MSAL → IPv6 residential (also when login is IPv4)
 * - cookie: always mobile (login.live.com)
 * - browser: Camoufox login → mobile or IPv4 via getProxyUrl()
 */
export async function getPlaywrightProxyConfigForLane(lane = 'browser') {
  if (!isProxyEnabled()) return null;

  const hybridRefresh = isHybridProxyEnabled() || isLoginResidentialIpv4();

  if (lane === 'http-refresh' && hybridRefresh) {
    const relay = await getResidentialSocksRelay();
    const main = parseProxyUrl(getResidentialProxyUrl());
    return {
      mode: 'socks-relay',
      server: relay,
      label: `hybrid residential socks5://${main.host}:${main.port}`,
      parsed: main,
      hybridLane: 'http-refresh',
    };
  }

  if (lane === 'cookie' && hybridRefresh) {
    // Cookie SSO always on mobile — even when Camoufox login uses IPv4.
    if (isLoginResidentialIpv4()) {
      const relay = await getMobileSocksRelay();
      const main = parseProxyUrl(getMobileProxyUrl());
      return {
        mode: 'socks-relay',
        server: relay,
        label: `mobile cookie socks5://${main.host}:${main.port}`,
        parsed: main,
        hybridLane: 'cookie',
      };
    }
    return getPlaywrightProxyConfig();
  }

  // browser / default → Camoufox login proxy (mobile or IPv4)
  return getPlaywrightProxyConfig();
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
    return { ok: false, error: err?.message || String(err), via: 'playwright' };
  } finally {
    await ctx.dispose().catch(() => {});
  }
}

async function probeHttpDirect(parsed, targetUrl = 'https://login.live.com/') {
  if (process.platform !== 'win32') {
    const curl = await probeWithCurlHttp(parsed, targetUrl);
    if (curl.ok) return curl;
  }
  return probeWithPlaywrightProxy(playwrightProxyFromConfig(httpDirectConfig(parsed)), targetUrl);
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
      await sleep(3_000);
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

async function trySocksProbe() {
  const main = parseProxyUrl(getProxyUrl());
  if (main.protocol === 'http') return null;

  // Reuse a live relay — never forceNew here (that closed 127.0.0.1 under active Camoufox).
  let relay = null;
  if (localProxyUrl && (await isRelayAlive(localProxyUrl))) {
    relay = localProxyUrl;
  } else {
    relay = await getLocalProxyForBrowser({ forceNew: false, forProbe: true });
  }

  const relayProbe = await probeWithPlaywrightProxy({ server: relay });
  if (relayProbe.ok) {
    lastProbeLatencyMs = relayProbe.ms ?? null;
    resolvedMode = 'socks-relay';
    console.log(`[proxy] Using SOCKS relay (${relayProbe.ms}ms probe OK)`);
    return resolvedMode;
  }
  console.warn(`[proxy] SOCKS relay probe failed: ${relayProbe.error}`);
  // Only tear down if nothing is using this port; a parallel Camoufox may still hold it.
  if (localProxyUrl && !(await isRelayAlive(localProxyUrl))) {
    await closeRelayOnly();
  }
  return null;
}

async function resolveProxyModeUnlocked({ force = false } = {}) {
  if (!isProxyEnabled()) return null;
  if (!force && resolvedMode) return resolvedMode;

  // Soft force: keep working socks-relay if the local port is still up (Camoufox in flight).
  if (force && resolvedMode === 'socks-relay' && localProxyUrl && (await isRelayAlive(localProxyUrl))) {
    return resolvedMode;
  }

  // Residential login (DataImpulse SOCKS or ProxyScrape HTTP) — never fall back to mobile HTTP.
  if (isLoginResidentialIpv4() || isResidentialProxy()) {
    const main = parseProxyUrl(getProxyUrl());
    if (main.protocol === 'http' || main.protocol === 'https') {
      if (await tryHttpProbe(getProxyUrl(), { retries: 1 })) return resolvedMode;
      resolvedMode = 'http-direct';
      console.warn(
        `[proxy] Residential HTTP probe failed — forcing http://${main.host}:${main.port} (no mobile fallback)`
      );
      return resolvedMode;
    }
    if (await trySocksProbe()) return resolvedMode;
    if (String(main.protocol).startsWith('socks')) {
      resolvedMode = 'socks-relay';
      console.warn(
        `[proxy] Residential SOCKS probe failed — forcing socks5://${main.host}:${main.port} relay (no mobile HTTP fallback)`
      );
      return resolvedMode;
    }
    resolvedMode = null;
    return null;
  }

  const prefer = getProxyPreferMode();
  const httpUrl = httpUrlForWifiSplit();

  if (prefer === 'http') {
    if (httpUrl && (await tryHttpProbe(httpUrl, { retries: 1 }))) return resolvedMode;
    if (await trySocksProbe()) return resolvedMode;
  } else {
    if (await trySocksProbe()) return resolvedMode;
    if (httpUrl && (await tryHttpProbe(httpUrl, { retries: 1 }))) return resolvedMode;
  }

  resolvedMode = null;
  return null;
}

/** iProxy + Camoufox: SOCKS5 relay first (default). HTTP :16857 optional fallback only. */
export async function resolveProxyMode({ force = false } = {}) {
  if (!isProxyEnabled()) return null;
  if (!force && resolvedMode) return resolvedMode;

  if (resolvePromise) {
    await resolvePromise.catch(() => {});
    if (!force && resolvedMode) return resolvedMode;
  }

  resolvePromise = resolveProxyModeUnlocked({ force });
  try {
    return await resolvePromise;
  } finally {
    resolvePromise = null;
  }
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
    'Proxy unreachable from this server — check phone mobile data and iProxy connection.'
  );
}

export async function getLocalProxyForBrowser({ forceNew = false, forProbe = false } = {}) {
  if (!isProxyEnabled()) return null;
  if (!forProbe && resolvedMode === 'http-direct') return null;

  // Always single-flight. Parallel forceNew used to close a live relay while
  // other workers still pointed at it → ECONNREFUSED on 127.0.0.1.
  if (relayCreatePromise) {
    return relayCreatePromise;
  }

  if (localProxyUrl && (await isRelayAlive(localProxyUrl))) {
    // Refuse to recreate while an existing relay is accepting connections —
    // Camoufox / cookie SSO keep the old 127.0.0.1:port for the whole session.
    if (forceNew) {
      console.warn('[proxy] Keeping live SOCKS relay (Camoufox/cookie SSO may still be using it)');
    }
    return localProxyUrl;
  }

  if (localProxyUrl && relayPinCount > 0) {
    console.warn('[proxy] Keeping pinned SOCKS relay despite probe miss');
    return localProxyUrl;
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
  if (relayPinCount > 0) {
    console.warn(
      `[proxy] Skipping SOCKS relay teardown — ${relayPinCount} Camoufox/cookie SSO session(s) still using it`
    );
    resetProxyMode();
    return;
  }
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

/** Pre-Camoufox check — same Playwright path the browser uses (SOCKS relay when prefer=socks). */
export async function probeProxyReachability(targetUrl = 'https://login.live.com/') {
  if (!isProxyEnabled()) return { ok: true, skipped: true };

  try {
    if (!resolvedMode) {
      await resolveProxyMode({ force: true });
    }

    if (resolvedMode === 'socks-relay') {
      const cfg = await getPlaywrightProxyConfig();
      const result = await probeWithPlaywrightProxy(playwrightProxyFromConfig(cfg), targetUrl);
      if (result.ok && result.ms != null) lastProbeLatencyMs = result.ms;
      return {
        ...result,
        mode: 'socks-relay',
        label: cfg.label,
        relay: cfg.server,
      };
    }

    if (resolvedMode === 'http-direct') {
      const httpUrl = httpUrlForWifiSplit() || getProxyUrl();
      const parsed = parseProxyUrl(httpUrl);
      const result = await probeWithPlaywrightProxy(playwrightProxyFromConfig(httpDirectConfig(parsed)), targetUrl);
      if (result.ok && result.ms != null) lastProbeLatencyMs = result.ms;
      return {
        ...result,
        mode: 'http-direct',
        label: `http://${parsed.host}:${parsed.port}`,
      };
    }

    return { ok: false, error: 'proxy mode not resolved', mode: null, label: null };
  } catch (err) {
    return { ok: false, error: err.message, mode: null, label: null };
  }
}
