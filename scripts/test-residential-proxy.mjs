/**
 * Diagnose PROXY_RESIDENTIAL_URL the same way the app does.
 * Usage (PowerShell):
 *   $env:PROXY_PROFILE='residential'
 *   $env:PROXY_RESIDENTIAL_URL='socks5://user:pass@host:port'
 *   node scripts/test-residential-proxy.mjs
 */
import { parseProxyUrl, getProxyUrl, getProxyProfile, getProxyHttpUrl, getProxyPreferMode } from '../lib/settings.js';
import { probeExitIp } from '../lib/proxy-exit-ip.js';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';

// Minimal in-memory settings so getProxyUrl works without DB.
const mem = new Map([
  ['proxy_enabled', 'true'],
  ['proxy_profile', process.env.PROXY_PROFILE || 'residential'],
]);
const { bindSettingsStore } = await import('../lib/settings.js');
bindSettingsStore({
  get: (k) => mem.get(k),
  set: (k, v) => mem.set(k, String(v)),
});

console.log('profile:', getProxyProfile());
console.log('prefer:', getProxyPreferMode());
console.log('httpUrl (must be null for residential):', getProxyHttpUrl());

let url;
try {
  url = getProxyUrl();
  console.log('proxyUrl:', url.replace(/:[^:@/]+@/, ':***@').replace(/:([^:]+)$/, ':***'));
  console.log('parsed:', parseProxyUrl(url));
} catch (err) {
  console.error('FAIL getProxyUrl:', err.message);
  process.exit(1);
}

const parsed = parseProxyUrl(url);
const user = encodeURIComponent(parsed.username);
const pass = encodeURIComponent(parsed.password);
const upstream = `socks5h://${user}:${pass}@${parsed.host}:${parsed.port}`;

console.log('\n1) curl exit IP…');
const exitIp = await probeExitIp();
console.log('exitIp:', exitIp || 'FAIL (null)');

console.log('\n2) proxy-chain local relay…');
let relay = null;
try {
  relay = await anonymizeProxy(upstream);
  console.log('relay:', relay);
  const { request } = await import('playwright-core');
  const ctx = await request.newContext({ proxy: { server: relay }, timeout: 25_000 });
  try {
    const res = await ctx.get('https://login.live.com/', { timeout: 25_000, maxRedirects: 5 });
    console.log('login.live via relay:', res.status());
  } finally {
    await ctx.dispose().catch(() => {});
  }
} catch (err) {
  console.error('FAIL relay/login.live:', err?.message || err);
} finally {
  if (relay) await closeAnonymizedProxy(relay, true).catch(() => {});
}

if (!exitIp) {
  console.error('\nRESULT: proxy cannot fetch a public IP — geoip will skip. Check host/port/auth or IP allowlist.');
  process.exit(2);
}
console.log('\nRESULT: OK');
