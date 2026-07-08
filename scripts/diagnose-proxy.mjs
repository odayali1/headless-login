/**
 * Run where the app runs (Coolify container shell or local machine).
 * Compare results with Wi-Fi Split ON vs OFF on the phone.
 *
 * Usage:
 *   PROXY_URL=socks5://host:17539:user:pass \
 *   PROXY_HTTP_URL=http://host:16857:user:pass \
 *   IPROXY_WIFI_SPLIT=1 node scripts/diagnose-proxy.mjs
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request as playwrightRequest } from 'playwright-core';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { parseProxyUrl } from '../lib/settings.js';

const execFileAsync = promisify(execFile);
const TARGET = process.env.PROXY_DIAG_URL || 'https://login.live.com/';
const TIMEOUT_MS = Number(process.env.PROXY_PROBE_TIMEOUT_MS || 20_000);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildHttpProxyUrl(parsed) {
  const user = encodeURIComponent(parsed.username);
  const pass = encodeURIComponent(parsed.password);
  return `http://${user}:${pass}@${parsed.host}:${parsed.port}`;
}

function buildSocksUpstream(parsed) {
  const user = encodeURIComponent(parsed.username);
  const pass = encodeURIComponent(parsed.password);
  return `socks5h://${user}:${pass}@${parsed.host}:${parsed.port}`;
}

async function tryCurlHttp(parsed) {
  const proxy = buildHttpProxyUrl(parsed);
  try {
    const { stdout } = await execFileAsync(
      'curl',
      ['-sS', '-x', proxy, '-m', String(Math.ceil(TIMEOUT_MS / 1000)), '-o', '/dev/null', '-w', '%{http_code} %{time_total}', TARGET],
      { timeout: TIMEOUT_MS + 5_000 }
    );
    const [code, seconds] = stdout.trim().split(/\s+/);
    return { ok: Number(code) >= 200 && Number(code) < 500, code, ms: Math.round(Number(seconds) * 1000), via: 'curl-http' };
  } catch (err) {
    return { ok: false, error: err.message, via: 'curl-http' };
  }
}

async function tryPlaywrightHttp(parsed) {
  const proxy = {
    server: `http://${parsed.host}:${parsed.port}`,
    username: parsed.username,
    password: parsed.password,
  };
  const ctx = await playwrightRequest.newContext({ proxy, timeout: TIMEOUT_MS });
  try {
    const t0 = Date.now();
    const res = await ctx.get(TARGET, { timeout: TIMEOUT_MS, maxRedirects: 5 });
    return { ok: res.status() >= 200 && res.status() < 500, status: res.status(), ms: Date.now() - t0, via: 'playwright-http' };
  } catch (err) {
    return { ok: false, error: err.message, via: 'playwright-http' };
  } finally {
    await ctx.dispose().catch(() => {});
  }
}

async function tryPlaywrightSocksRelay(parsed) {
  const upstream = buildSocksUpstream(parsed);
  const relay = await anonymizeProxy(upstream);
  const ctx = await playwrightRequest.newContext({ proxy: { server: relay }, timeout: TIMEOUT_MS });
  try {
    const t0 = Date.now();
    const res = await ctx.get(TARGET, { timeout: TIMEOUT_MS, maxRedirects: 5 });
    return { ok: res.status() >= 200 && res.status() < 500, status: res.status(), ms: Date.now() - t0, via: 'playwright-socks-relay', relay };
  } catch (err) {
    return { ok: false, error: err.message, via: 'playwright-socks-relay', relay };
  } finally {
    await ctx.dispose().catch(() => {});
    await closeAnonymizedProxy(relay, true).catch(() => {});
  }
}

async function tryParallelHttp(parsed, n = 6) {
  const proxy = {
    server: `http://${parsed.host}:${parsed.port}`,
    username: parsed.username,
    password: parsed.password,
  };
  const t0 = Date.now();
  const results = await Promise.all(
    Array.from({ length: n }, async () => {
      const ctx = await playwrightRequest.newContext({ proxy, timeout: TIMEOUT_MS });
      try {
        const res = await ctx.get(TARGET, { timeout: TIMEOUT_MS, maxRedirects: 3 });
        return res.status();
      } catch {
        return 0;
      } finally {
        await ctx.dispose().catch(() => {});
      }
    })
  );
  const ok = results.filter((s) => s >= 200 && s < 500).length;
  return { ok: ok === n, via: `playwright-http-x${n}`, okCount: ok, total: n, ms: Date.now() - t0 };
}

function printResult(label, result) {
  if (result.ok) {
    console.log(`  OK   ${label}: ${result.via} ${result.status || result.code || ''} in ${result.ms}ms`);
  } else {
    console.log(`  FAIL ${label}: ${result.via} — ${result.error || `only ${result.okCount}/${result.total} OK`}`);
  }
}

const socksUrl = process.env.PROXY_URL?.trim();
const httpUrl = process.env.PROXY_HTTP_URL?.trim() || (socksUrl?.startsWith('http') ? socksUrl : null);
const wifiSplit = process.env.IPROXY_WIFI_SPLIT;

console.log('=== iProxy / Coolify proxy diagnostic ===');
console.log('Target:', TARGET);
console.log('Timeout:', TIMEOUT_MS, 'ms');
console.log('IPROXY_WIFI_SPLIT:', wifiSplit || '(not set)');
console.log('Node:', process.version, process.platform);
console.log('');

if (httpUrl) {
  const httpParsed = parseProxyUrl(httpUrl);
  console.log(`HTTP ${httpParsed.host}:${httpParsed.port}`);
  printResult('single', await tryPlaywrightHttp(httpParsed));
  if (process.platform !== 'win32') {
    printResult('curl', await tryCurlHttp(httpParsed));
  } else {
    console.log('  SKIP curl (run on Coolify/Linux for curl comparison)');
  }
  printResult('parallel-6', await tryParallelHttp(httpParsed, 6));
  console.log('');
}

if (socksUrl && !socksUrl.startsWith('http')) {
  const socksParsed = parseProxyUrl(socksUrl);
  console.log(`SOCKS ${socksParsed.host}:${socksParsed.port} (via local relay)`);
  printResult('single', await tryPlaywrightSocksRelay(socksParsed));
  console.log('');
}

console.log('=== How to read results ===');
console.log('- Single OK + parallel FAIL → Wi-Fi Split uplink chokes many connections (browser apps).');
console.log('- All FAIL from this shell → phone/iProxy path dead (not an MSAL bug).');
console.log('- curl OK on Coolify HOST but FAIL in container → try network_mode: host in Coolify.');
console.log('- All OK here but refresh fails → app bug (send full job log).');
