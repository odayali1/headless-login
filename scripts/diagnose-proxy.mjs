/**
 * Run where the app runs (Coolify container shell or local machine).
 * Compare results with Wi-Fi Split ON vs OFF on the phone.
 *
 * Usage:
 *   PROXY_URL=socks5://host:17539:user:pass \
 *   PROXY_HTTP_URL=http://host:16857:user:pass \
 *   IPROXY_WIFI_SPLIT=1 node scripts/diagnose-proxy.mjs
 *
 * iProxy uses different passwords on SOCKS :17539 vs HTTP :16857 — use host:port:user:pass format.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request as playwrightRequest } from 'playwright-core';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { parseProxyUrl } from '../lib/settings.js';

const execFileAsync = promisify(execFile);
const LOGIN_TARGET = process.env.PROXY_DIAG_LOGIN_URL || 'https://login.live.com/';
const OUTLOOK_TARGET = process.env.PROXY_DIAG_OUTLOOK_URL || 'https://outlook.live.com/mail/';
const TIMEOUT_MS = Number(process.env.PROXY_PROBE_TIMEOUT_MS || 20_000);
const SLOW_PROBE_MS = Number(process.env.PROXY_SLOW_PROBE_MS || 5_000);

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

async function tryCurlHttp(parsed, target) {
  const proxy = buildHttpProxyUrl(parsed);
  try {
    const { stdout } = await execFileAsync(
      'curl',
      ['-sS', '-x', proxy, '-m', String(Math.ceil(TIMEOUT_MS / 1000)), '-o', '/dev/null', '-w', '%{http_code} %{time_total}', target],
      { timeout: TIMEOUT_MS + 5_000 }
    );
    const [code, seconds] = stdout.trim().split(/\s+/);
    const status = Number(code);
    return {
      ok: status >= 200 && status < 500,
      code: status,
      ms: Math.round(Number(seconds) * 1000),
      via: 'curl-http',
      slow: Number(seconds) * 1000 > SLOW_PROBE_MS,
    };
  } catch (err) {
    const is407 = /407/.test(err.message || '');
    return {
      ok: false,
      error: err.message + (is407 ? ' (407 = wrong HTTP password — :16857 uses a different pass than SOCKS :17539)' : ''),
      via: 'curl-http',
    };
  }
}

async function tryPlaywrightHttp(parsed, target) {
  const proxy = {
    server: `http://${parsed.host}:${parsed.port}`,
    username: parsed.username,
    password: parsed.password,
  };
  const ctx = await playwrightRequest.newContext({ proxy, timeout: TIMEOUT_MS });
  try {
    const t0 = Date.now();
    const res = await ctx.get(target, { timeout: TIMEOUT_MS, maxRedirects: 5 });
    const ms = Date.now() - t0;
    return {
      ok: res.status() >= 200 && res.status() < 500,
      status: res.status(),
      ms,
      via: 'playwright-http',
      slow: ms > SLOW_PROBE_MS,
    };
  } catch (err) {
    return { ok: false, error: err.message, via: 'playwright-http' };
  } finally {
    await ctx.dispose().catch(() => {});
  }
}

async function tryPlaywrightSocksRelay(parsed, target) {
  const upstream = buildSocksUpstream(parsed);
  const relay = await anonymizeProxy(upstream);
  const ctx = await playwrightRequest.newContext({ proxy: { server: relay }, timeout: TIMEOUT_MS });
  try {
    const t0 = Date.now();
    const res = await ctx.get(target, { timeout: TIMEOUT_MS, maxRedirects: 5 });
    const ms = Date.now() - t0;
    return {
      ok: res.status() >= 200 && res.status() < 500,
      status: res.status(),
      ms,
      via: 'playwright-socks-relay',
      slow: ms > SLOW_PROBE_MS,
      relay,
    };
  } catch (err) {
    return { ok: false, error: err.message, via: 'playwright-socks-relay', relay };
  } finally {
    await ctx.dispose().catch(() => {});
    await closeAnonymizedProxy(relay, true).catch(() => {});
  }
}

async function tryParallelHttp(parsed, target, n = 6) {
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
        const res = await ctx.get(target, { timeout: TIMEOUT_MS, maxRedirects: 3 });
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
    const slow = result.slow ? ' SLOW' : '';
    console.log(`  OK   ${label}: ${result.via} ${result.status || result.code || ''} in ${result.ms}ms${slow}`);
  } else {
    console.log(`  FAIL ${label}: ${result.via} — ${result.error || `only ${result.okCount}/${result.total} OK`}`);
  }
}

function detectSplitBlocked(httpResults) {
  const curlOk = httpResults.some((r) => r.via === 'curl-http' && r.ok);
  const pwFail = httpResults.some((r) => r.via === 'playwright-http' && !r.ok);
  if (curlOk && pwFail) {
    console.log('');
    console.log('  *** Wi-Fi SPLIT BLOCKED ***');
    console.log('  curl works but Playwright/browser fails — Camoufox refresh will NOT work.');
    console.log('  Turn traffic split OFF on the iProxy phone app and restart iProxy.');
    console.log('');
  }
}

async function runSuite(label, parsed, target) {
  console.log(`  --- ${label} → ${target}`);
  const results = [];
  const single = await tryPlaywrightHttp(parsed, target);
  results.push(single);
  printResult('single', single);
  if (process.platform !== 'win32') {
    const curl = await tryCurlHttp(parsed, target);
    results.push(curl);
    printResult('curl', curl);
  } else {
    console.log('  SKIP curl (run on Coolify/Linux for curl comparison)');
  }
  const parallel = await tryParallelHttp(parsed, target, 6);
  printResult('parallel-6', parallel);
  detectSplitBlocked(results);
}

const socksUrl = process.env.PROXY_URL?.trim();
const httpUrl = process.env.PROXY_HTTP_URL?.trim() || (socksUrl?.startsWith('http') ? socksUrl : null);
const wifiSplit = process.env.IPROXY_WIFI_SPLIT;

console.log('=== iProxy / Coolify proxy diagnostic ===');
console.log('Login target:', LOGIN_TARGET);
console.log('Outlook target:', OUTLOOK_TARGET);
console.log('Slow probe threshold:', SLOW_PROBE_MS, 'ms');
console.log('IPROXY_WIFI_SPLIT:', wifiSplit || '(not set)');
console.log('Node:', process.version, process.platform);
console.log('');

if (httpUrl) {
  const httpParsed = parseProxyUrl(httpUrl);
  console.log(`HTTP ${httpParsed.host}:${httpParsed.port}`);
  await runSuite('login', httpParsed, LOGIN_TARGET);
  await runSuite('outlook', httpParsed, OUTLOOK_TARGET);
  console.log('');
}

if (socksUrl && !socksUrl.startsWith('http')) {
  const socksParsed = parseProxyUrl(socksUrl);
  console.log(`SOCKS ${socksParsed.host}:${socksParsed.port} (via local relay)`);
  console.log(`  --- login → ${LOGIN_TARGET}`);
  printResult('single', await tryPlaywrightSocksRelay(socksParsed, LOGIN_TARGET));
  console.log(`  --- outlook → ${OUTLOOK_TARGET}`);
  printResult('single', await tryPlaywrightSocksRelay(socksParsed, OUTLOOK_TARGET));
  console.log('');
}

console.log('=== How to read results ===');
console.log('Split ON: HTTP Playwright FAIL + SOCKS Playwright OK → app uses SOCKS for Camoufox, curl for tokens.');
console.log('*** curl OK + HTTP Playwright FAIL + SOCKS FAIL → only curl token refresh may work. ***');
console.log(`- Probe > ${SLOW_PROBE_MS}ms but all Playwright OK → slow uplink (Teams-first in app).`);
console.log('- login OK + outlook SLOW/FAIL on Split ON → expected; Outlook SPA needs many connections.');
console.log('- curl 407 on HTTP → wrong password (HTTP :16857 password ≠ SOCKS :17539 password).');
console.log('- Single OK + parallel FAIL → Wi-Fi Split uplink chokes many connections.');
console.log('- All FAIL from this shell → phone/iProxy path dead (not an MSAL bug).');
