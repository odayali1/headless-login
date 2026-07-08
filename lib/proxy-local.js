import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { getProxyUrl, isProxyEnabled, parseProxyUrl } from './settings.js';

let localProxyUrl = null;
let relayCreatePromise = null;

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

/**
 * Local HTTP proxy Firefox/Playwright can use without auth.
 * forceNew=true closes the previous relay and starts a clean one (use for each Camoufox launch).
 */
export async function getLocalProxyForBrowser({ forceNew = false } = {}) {
  if (!isProxyEnabled()) return null;

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
  if (relayCreatePromise) {
    await relayCreatePromise.catch(() => {});
    relayCreatePromise = null;
  }
  if (localProxyUrl) {
    await closeAnonymizedProxy(localProxyUrl, true).catch(() => {});
    localProxyUrl = null;
  }
}

/** Quick connectivity check through the current relay (used before Camoufox navigation). */
export async function probeProxyReachability(targetUrl = 'https://login.live.com/') {
  if (!isProxyEnabled()) return { ok: true, skipped: true };
  const { request } = await import('playwright-core');
  const relay = await getLocalProxyForBrowser();
  const ctx = await request.newContext({
    proxy: { server: relay },
    timeout: 20_000,
  });
  try {
    const t0 = Date.now();
    const res = await ctx.get(targetUrl, { timeout: 20_000, maxRedirects: 5 });
    return { ok: res.status() >= 200 && res.status() < 500, status: res.status(), ms: Date.now() - t0, relay };
  } catch (err) {
    return { ok: false, error: err.message, relay };
  } finally {
    await ctx.dispose().catch(() => {});
  }
}
