import { sleep } from './anti-detect.js';
import {
  closeLocalProxy,
  getLocalProxyRelayPinCount,
  getPlaywrightProxyConfig,
  ProxyUnreachableError,
} from './proxy-local.js';
import { waitForCamoufoxQuiet } from './camoufox-pool.js';
import {
  assertProxyReady,
  getAccountsOnIp,
  getPlaywrightProxy,
  getProxyUrl,
  getRotateUrl,
  getRotateAfter,
  isProxyEnabled,
  parseProxyUrl,
  ACCOUNTS_PER_IP,
  setAccountsOnIp,
  setRotateAfter,
} from './settings.js';

export { getPlaywrightProxy, assertProxyReady, isProxyEnabled };
export { ProxyUnreachableError } from './proxy-local.js';

const ROTATE_WAIT_MS = Number(process.env.PROXY_ROTATE_WAIT_MS || 30_000);
/**
 * Coolify often sets PROXY_ROTATE_WAIT_MS=10000 — too short for mobile changeip.
 * Logs showed "ready on new IP" then GetCredentialType 429 on the same burned IP.
 */
const ROTATE_WAIT_MIN_MS = Number(process.env.PROXY_ROTATE_WAIT_MIN_MS || 30_000);
/** Min gap between IP rotations — stops email-retry thrash from killing shared relays. */
const ROTATE_COOLDOWN_MS = Number(process.env.PROXY_ROTATE_COOLDOWN_MS || 120_000);
/**
 * Parallel LOGIN_PARALLEL=2 jobs both forcing rotate on 429 caused back-to-back IP changes.
 * Min gap only for non-force rotates — 429 jobs must be able to rotate again if IP is still hot.
 */
const SHARED_ROTATE_MIN_GAP_MS = Number(process.env.PROXY_SHARED_ROTATE_MIN_GAP_MS || 25_000);
/** Short quiet-pool probe before rotating. */
const ROTATE_DRAIN_MS = Number(process.env.PROXY_ROTATE_DRAIN_MS || 15_000);
/**
 * Max time to wait for Camoufox relay pins to drop before rotating.
 * LOGIN_PARALLEL=2 + 180s token capture means 15s was never enough — overnight logs showed
 * 267 "delaying rotate" and only 3 real IP changes, while the session counter still reset.
 */
const ROTATE_PIN_WAIT_MS = Number(process.env.PROXY_ROTATE_PIN_WAIT_MS || 200_000);
/** How long beforeAccountLogin will keep retrying rotate when the IP is full. */
const ROTATE_BLOCK_WAIT_MS = Number(process.env.PROXY_ROTATE_BLOCK_WAIT_MS || 240_000);
/**
 * HTTP/Loki/cookie-SSO refreshes share the mobile IP but never bumped the session counter —
 * login then showed "account 1" after 30+ Microsoft calls and hit GetCredentialType 429.
 */
const HTTP_ROTATE_EVERY = Number(process.env.PROXY_HTTP_ROTATE_EVERY || 8);
/** Rotate before Camoufox login if this many HTTP ops already ran on the current IP. */
const LOGIN_CLEAN_IP_AFTER_HTTP = Number(process.env.PROXY_LOGIN_CLEAN_IP_AFTER_HTTP || 4);

let rotateChain = Promise.resolve();
/** Serialize HTTP refresh counter + rotate so parallel=5 workers do not race. */
let httpOpChain = Promise.resolve();
let lastRotateAt = 0;
let rotating = false;

export function isProxyRotating() {
  return rotating;
}

export function msSinceLastProxyRotate() {
  return lastRotateAt ? Date.now() - lastRotateAt : Infinity;
}

function rotateWaitMs({ force = false } = {}) {
  const wanted = Number.isFinite(ROTATE_WAIT_MS) ? ROTATE_WAIT_MS : 30_000;
  // Always wait at least ROTATE_WAIT_MIN_MS — 10s reconnect after changeip is the main 429 cause.
  const min = Math.max(ROTATE_WAIT_MIN_MS, force ? 30_000 : 20_000);
  return Math.max(wanted, min);
}

/** Public exit IP via upstream proxy (curl). Used to verify changeip actually moved us. */
async function probeExitIp() {
  try {
    const parsed = parseProxyUrl(getProxyUrl());
    const user = encodeURIComponent(parsed.username);
    const pass = encodeURIComponent(parsed.password);
    const upstream =
      parsed.protocol === 'http' || parsed.protocol === 'https'
        ? `http://${user}:${pass}@${parsed.host}:${parsed.port}`
        : `socks5h://${user}:${pass}@${parsed.host}:${parsed.port}`;
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      'curl',
      ['-sS', '-x', upstream, '-m', '15', 'https://api.ipify.org'],
      { timeout: 20_000 }
    );
    const ip = String(stdout || '').trim();
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip) ? ip : null;
  } catch {
    return null;
  }
}

async function connectProxy(log, { label, forceNewRelay = false } = {}) {
  const proxy = getPlaywrightProxy();
  // Reuse the local SOCKS relay across jobs — recreating it every time costs ~2–3s each.
  const cfg = await getPlaywrightProxyConfig({ forceNew: forceNewRelay, forceResolve: forceNewRelay });
  log?.('proxy', `Using ${cfg?.label || proxy.server}${label ? ` (${label})` : ''}.`);
  if (cfg?.mode === 'socks-relay') {
    log?.('proxy', `Local relay ${cfg.server} → Firefox (auth handled in-process).`);
  } else if (cfg?.mode === 'http-direct') {
    log?.('proxy', 'Direct HTTP CONNECT (no local relay).');
  }
  return cfg;
}

/**
 * Rotate when accounts-on-IP hit the limit. NEVER reset the counter unless rotate actually
 * succeeded — overnight logs reset to "account 1" after every failed busy-rotate, so the
 * same mobile IP kept taking batches of 6 while Microsoft 429'd hard.
 */
async function maybeRotateBeforeBrowserSession(log) {
  const onIp = getAccountsOnIp();
  const rotateAfter = Number(process.env.PROXY_ROTATE_EVERY) || getRotateAfter();

  if (onIp < rotateAfter) return onIp;

  const deadline = Date.now() + ROTATE_BLOCK_WAIT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    log?.(
      'proxy',
      `IP full (${onIp}/${rotateAfter}) — rotating before next session (attempt ${attempt})…`
    );
    const result = await rotateProxyIp(log, { force: attempt >= 3 });
    if (result?.rotated) {
      // Counter already cleared inside rotateProxyIp on success.
      setRotateAfter(ACCOUNTS_PER_IP);
      log?.('proxy', `Next IP rotation after ${ACCOUNTS_PER_IP} browser session(s).`);
      return 0;
    }
    const left = Math.max(0, deadline - Date.now());
    const waitMs = Math.min(20_000, Math.max(8_000, left));
    log?.(
      'proxy',
      `Rotate deferred (${result?.reason || 'busy'}) — counter stays at ${getAccountsOnIp()}; waiting ${Math.round(waitMs / 1000)}s for Camoufox to finish…`
    );
    if (left < 1000) break;
    await sleep(waitMs);
  }

  // Still no rotate — do NOT reset counter. Start anyway but log loudly; next job retries.
  log?.(
    'proxy',
    `WARNING: could not rotate after ${ROTATE_BLOCK_WAIT_MS / 1000}s — still on same IP with ${getAccountsOnIp()} session(s) counted`
  );
  return getAccountsOnIp();
}

/**
 * After each browserless refresh account — bump shared IP counter and rotate when full.
 * Serialized across parallel fast-lane workers.
 */
export function trackBrowserlessHttpOp(log) {
  if (!isProxyEnabled()) return Promise.resolve();
  const run = async () => {
    const n = getAccountsOnIp() + 1;
    setAccountsOnIp(n);
    if (n < HTTP_ROTATE_EVERY) return;
    log?.(
      'proxy',
      `HTTP refresh load on IP (${n}/${HTTP_ROTATE_EVERY}) — rotating mobile IP…`
    );
    const result = await rotateProxyIp(log);
    if (!result?.rotated) {
      log?.(
        'proxy',
        `HTTP rotate deferred (${result?.reason || 'busy'}) — counter stays at ${getAccountsOnIp()}`
      );
    }
  };
  const next = httpOpChain.then(run, run);
  httpOpChain = next.then(
    () => {},
    () => {}
  );
  return next;
}

/** Login — rotate every N browser sessions, clean IP after HTTP burst, then connect proxy. */
export async function beforeAccountLogin(log) {
  if (!isProxyEnabled()) return;
  assertProxyReady();

  const httpOnIp = getAccountsOnIp();
  if (httpOnIp >= LOGIN_CLEAN_IP_AFTER_HTTP) {
    log?.(
      'proxy',
      `${httpOnIp} HTTP refresh op(s) on current IP — rotating before login (GetCredentialType)…`
    );
    await rotateProxyIp(log, { force: httpOnIp >= HTTP_ROTATE_EVERY });
  }

  const onIp = await maybeRotateBeforeBrowserSession(log);
  await connectProxy(log, { label: `account ${onIp + 1} on this IP` });
}

/** Camoufox token capture / re-login browser work — same rotation counter as login. */
export async function beforeAccountBrowserSession(log) {
  if (!isProxyEnabled()) return;
  assertProxyReady();
  const onIp = await maybeRotateBeforeBrowserSession(log);
  await connectProxy(log, { label: `browser session ${onIp + 1} on this IP` });
}

export async function afterAccountLoginSuccess() {
  await afterAccountBrowserSession();
}

/** Bump IP rotation counter after a successful Camoufox login or session capture. */
export async function afterAccountBrowserSession() {
  if (!isProxyEnabled()) return;
  // One fresh GetCredentialType login burns this mobile IP for the next account
  // (logs: account 1 OK, account 2 → immediate 429). Force rotate before next login.
  const rotateAfter = Number(process.env.PROXY_ROTATE_EVERY) || getRotateAfter();
  setAccountsOnIp(Math.max(getAccountsOnIp() + 1, rotateAfter));
}

/**
 * Browserless HTTP token refresh — proxy only; rotation tracked via trackBrowserlessHttpOp.
 * (Camoufox fallback calls beforeAccountBrowserSession instead.)
 */
export async function beforeAccountRefresh(log) {
  if (!isProxyEnabled()) return;
  assertProxyReady();
  await connectProxy(log, { label: 'token refresh' });
}

/**
 * Rotate mobile IP. Serialized + cooldown so login email-retries cannot spam
 * changeip and tear down the shared SOCKS relay under active Camoufox/smart-refresh.
 * @param {*} log
 * @param {{ force?: boolean }} [opts] - force=true bypasses cooldown (Microsoft 429 Too Many Requests)
 * @returns {{ rotated: boolean, skipped?: boolean, reason?: string }}
 */
export async function rotateProxyIp(log, { force = false } = {}) {
  const run = async () => {
    const ago = msSinceLastProxyRotate();
    if (!force && ago < ROTATE_COOLDOWN_MS) {
      const left = Math.ceil((ROTATE_COOLDOWN_MS - ago) / 1000);
      log?.(
        'proxy',
        `Skipping rotation — last IP change ${Math.round(ago / 1000)}s ago (cooldown ${left}s left)`
      );
      return { rotated: false, skipped: true, reason: 'cooldown' };
    }
    if (force && ago < ROTATE_COOLDOWN_MS) {
      log?.('proxy', 'Forcing IP rotation (Microsoft rate-limit / 429)…');
    }
    // Do not block 429 force-rotates — parallel jobs already serialize on rotateChain.
    if (!force && lastRotateAt && Date.now() - lastRotateAt < SHARED_ROTATE_MIN_GAP_MS) {
      const sec = Math.round((Date.now() - lastRotateAt) / 1000);
      log?.('proxy', `Skipping rotate — IP changed ${sec}s ago (dedupe)`);
      return { rotated: false, skipped: true, reason: 'recent_rotate' };
    }

    rotating = true;
    try {
      const pinBudget = Math.max(ROTATE_DRAIN_MS, ROTATE_PIN_WAIT_MS);
      const quiet = await waitForCamoufoxQuiet(Math.min(ROTATE_DRAIN_MS, pinBudget));
      // Login jobs pin the SOCKS relay but are outside the smart-refresh pool.
      // Caller should close its own Camoufox first on mid-login 429 — otherwise pin never hits 0.
      const pinWaitStart = Date.now();
      while (getLocalProxyRelayPinCount() > 0 && Date.now() - pinWaitStart < pinBudget) {
        const pins = getLocalProxyRelayPinCount();
        if ((Date.now() - pinWaitStart) % 15_000 < 500) {
          log?.(
            'proxy',
            `Waiting for ${pins} Camoufox relay pin(s) before IP rotate (${Math.round((Date.now() - pinWaitStart) / 1000)}s)…`
          );
        }
        await sleep(500);
      }
      const pins = getLocalProxyRelayPinCount();
      if (!quiet || pins > 0) {
        log?.(
          'proxy',
          `Camoufox still busy after ${Math.round(pinBudget / 1000)}s (pool quiet=${quiet}, relay pins=${pins}) — delaying rotate`
        );
        return { rotated: false, skipped: true, reason: 'camoufox_busy' };
      }
      if (ROTATE_DRAIN_MS > 0) {
        log?.('proxy', 'Camoufox pool quiet — safe to rotate IP');
      }

      const url = getRotateUrl();
      const beforeIp = await probeExitIp();
      if (beforeIp) log?.('proxy', `Exit IP before rotate: ${beforeIp}`);

      log?.('proxy', 'Requesting mobile IP rotation…');
      const res = await fetch(url, { method: 'GET' });
      const body = await res.text().catch(() => '');
      if (!res.ok) {
        throw new Error(`Proxy rotation failed (${res.status}): ${body.slice(0, 120)}`);
      }

      const waitMs = rotateWaitMs({ force });
      log?.('proxy', `Rotation sent — waiting ${Math.round(waitMs / 1000)}s for reconnect…`);
      await sleep(waitMs);
      await closeLocalProxy();

      let afterIp = await probeExitIp();
      if (beforeIp && afterIp && beforeIp === afterIp) {
        log?.(
          'proxy',
          `WARNING: exit IP still ${afterIp} after changeip — waiting 20s and retrying rotate once…`
        );
        await sleep(20_000);
        const res2 = await fetch(url, { method: 'GET' }).catch(() => null);
        if (res2?.ok) {
          await sleep(waitMs);
          await closeLocalProxy();
          afterIp = await probeExitIp();
        }
      }

      if (beforeIp && afterIp && beforeIp === afterIp) {
        log?.(
          'proxy',
          `Rotate FAILED — still on ${afterIp} (Microsoft will keep 429). Check iProxy changeip / wait longer.`
        );
        // Do not claim success or reset counter — login must not treat this as a fresh IP.
        return { rotated: false, skipped: true, reason: 'same_ip', exitIp: afterIp };
      }

      lastRotateAt = Date.now();
      setAccountsOnIp(0);
      if (afterIp && beforeIp) {
        log?.('proxy', `Proxy ready on new IP: ${beforeIp} → ${afterIp}`);
      } else if (afterIp) {
        log?.('proxy', `Proxy should be ready on new IP (${afterIp}).`);
      } else {
        log?.('proxy', 'Proxy should be ready on new IP.');
      }
      return { rotated: true, exitIp: afterIp || null, previousIp: beforeIp || null };
    } finally {
      rotating = false;
    }
  };

  const next = rotateChain.then(run, run);
  rotateChain = next.then(
    () => {},
    () => {}
  );
  return next;
}
