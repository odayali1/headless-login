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

/** iProxy mobile changeip is typically ready in <10s — do not force 30s. */
const ROTATE_WAIT_MS = Number(process.env.PROXY_ROTATE_WAIT_MS || 10_000);
/** Floor only — override with PROXY_ROTATE_WAIT_MIN_MS if a provider needs longer. */
const ROTATE_WAIT_MIN_MS = Number(process.env.PROXY_ROTATE_WAIT_MIN_MS || 8_000);
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
 * HTTP/Loki/cookie-SSO must NEVER drive changeip on mobile.
 * PROXY_HTTP_ROTATE_EVERY is ignored (kept only so old Coolify env does not break).
 * Bug: env=0 with `ops >= every` made 0>=0 always true → rotate every tick.
 */
const HTTP_ROTATE_EVERY = 0;
/**
 * Rotate before Camoufox login only if this many HTTP ops already ran on the IP.
 * Default 0 = OFF — keep the same IP for up to PROXY_ROTATE_EVERY logins.
 */
const LOGIN_CLEAN_IP_AFTER_HTTP = Number(process.env.PROXY_LOGIN_CLEAN_IP_AFTER_HTTP || 0);

let rotateChain = Promise.resolve();
/** Serialize HTTP refresh counter + rotate so parallel=5 workers do not race. */
let httpOpChain = Promise.resolve();
let lastRotateAt = 0;
let rotating = false;
/** HTTP-only load counter — never used to force login changeip. */
let httpOpsOnIp = 0;
/** Set while a Camoufox login job holds the mobile IP — smart-refresh must not HTTP/rotate. */
let loginProxyExclusive = false;
/** After login ends, keep HTTP paused so the next queued login does not hit a burned IP. */
let loginHttpCooldownUntil = 0;
const LOGIN_HTTP_COOLDOWN_MS = Number(process.env.LOGIN_HTTP_COOLDOWN_MS || 180_000);
/** Settle after GCT-429 rotate before retrying email. */
export const GCT_429_SETTLE_MS = Number(process.env.GCT_429_SETTLE_MS || 45_000);

export function isProxyRotating() {
  return rotating;
}

export function isLoginProxyExclusive() {
  return loginProxyExclusive || Date.now() < loginHttpCooldownUntil;
}

export function beginLoginProxyExclusive() {
  loginProxyExclusive = true;
  loginHttpCooldownUntil = 0;
}

/**
 * Release exclusive only when no more logins are waiting.
 * Always starts an HTTP cooldown so smart-refresh cannot burn GetCredentialType
 * on the IP the next login will use.
 */
export function endLoginProxyExclusive({ queueWaiting = 0 } = {}) {
  if (queueWaiting > 0) {
    // Keep exclusive — more Camoufox logins still queued.
    return;
  }
  loginProxyExclusive = false;
  loginHttpCooldownUntil = Date.now() + LOGIN_HTTP_COOLDOWN_MS;
}

/** Always false — HTTP refresh must not block/rotate the mobile IP. */
export function isProxyIpSaturated() {
  return false;
}

export function msSinceLastProxyRotate() {
  return lastRotateAt ? Date.now() - lastRotateAt : Infinity;
}

function resetIpCounters() {
  setAccountsOnIp(0);
  httpOpsOnIp = 0;
}

function rotateWaitMs() {
  const wanted = Number.isFinite(ROTATE_WAIT_MS) && ROTATE_WAIT_MS > 0 ? ROTATE_WAIT_MS : 10_000;
  const min = Number.isFinite(ROTATE_WAIT_MIN_MS) && ROTATE_WAIT_MIN_MS > 0 ? ROTATE_WAIT_MIN_MS : 8_000;
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
 * Rotate when real Camoufox login count hits PROXY_ROTATE_EVERY (default 6).
 * Never triggered by HTTP refresh load.
 */
async function maybeRotateBeforeBrowserSession(log, { allowDuringLogin = false } = {}) {
  const rotateAfter = Number(process.env.PROXY_ROTATE_EVERY) || getRotateAfter();
  let onIp = getAccountsOnIp();

  if (onIp < rotateAfter) return onIp;

  log?.(
    'proxy',
    `${onIp} successful login(s) on this IP (limit ${rotateAfter}) — rotating once before next account…`
  );
  const result = await rotateProxyIp(log, { force: true, allowDuringLogin });
  if (result?.rotated) {
    setRotateAfter(ACCOUNTS_PER_IP);
    log?.('proxy', `Next IP rotation after ${ACCOUNTS_PER_IP} browser session(s).`);
    return 0;
  }
  log?.(
    'proxy',
    `Rotate deferred (${result?.reason || 'busy'}) — continuing on current IP (${getAccountsOnIp()}/${rotateAfter})`
  );
  return getAccountsOnIp();
}

/** No-op — HTTP refresh must not rotate or saturate the mobile IP. */
export function trackBrowserlessHttpOp(_log) {
  return Promise.resolve();
}

/** No-op — kept for callers; HTTP never triggers changeip. */
export async function rotateHttpProxyWhenIdle(_log) {
  return { rotated: false, skipped: true, reason: 'http_rotate_disabled' };
}

/**
 * Login — NEVER changeip here. Fresh IP before GetCredentialType causes
 * "issue looking up your account". Rotate only AFTER a successful login batch.
 */
export async function beforeAccountLogin(log) {
  if (!isProxyEnabled()) return;
  assertProxyReady();
  beginLoginProxyExclusive();

  const rotateAfter = Number(process.env.PROXY_ROTATE_EVERY) || getRotateAfter();
  let onIp = getAccountsOnIp();
  // Stale counter must not trigger changeip before email — just continue on this IP.
  if (onIp >= rotateAfter) {
    log?.(
      'proxy',
      `Login counter ${onIp}/${rotateAfter} — keeping current IP (rotate happens after successful logins, not before)`
    );
  } else {
    log?.(
      'proxy',
      `Keeping current IP for login (${onIp}/${rotateAfter}) — no changeip during this login`
    );
  }
  await connectProxy(log, { label: `account ${Math.min(onIp, rotateAfter - 1) + 1} on this IP` });
}

/** Camoufox token capture / re-login browser work — same rotation counter as login. */
export async function beforeAccountBrowserSession(log) {
  if (!isProxyEnabled()) return;
  if (loginProxyExclusive) {
    throw new Error('Login in progress — defer smart-refresh Camoufox');
  }
  assertProxyReady();
  const onIp = await maybeRotateBeforeBrowserSession(log);
  await connectProxy(log, { label: `browser session ${onIp + 1} on this IP` });
}

export async function afterAccountLoginSuccess(log) {
  await afterAccountBrowserSession(log);
}

/**
 * After a successful Camoufox login: bump counter, and only THEN rotate when
 * the batch is full — so the next login starts on an already-settled IP.
 */
export async function afterAccountBrowserSession(log) {
  if (!isProxyEnabled()) return;
  const rotateAfter = Number(process.env.PROXY_ROTATE_EVERY) || getRotateAfter();
  const n = getAccountsOnIp() + 1;
  setAccountsOnIp(n);
  if (n < rotateAfter) return;

  log?.(
    'proxy',
    `${n} successful login(s) on this IP — rotating now (after login), next accounts get a settled IP`
  );
  const result = await rotateProxyIp(log, { force: true, allowDuringLogin: true });
  if (result?.rotated) {
    const settle = Number(process.env.PROXY_POST_ROTATE_SETTLE_MS || 8_000);
    if (settle > 0) {
      log?.('proxy', `Settling ${Math.round(settle / 1000)}s after batch rotate…`);
      await sleep(settle);
    }
  }
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
 * Rotate mobile IP. Blocked while a login holds the IP (unless allowDuringLogin —
 * only for the between-batch rotate after PROXY_ROTATE_EVERY successful logins).
 * @param {*} log
 * @param {{ force?: boolean, allowDuringLogin?: boolean }} [opts]
 * @returns {{ rotated: boolean, skipped?: boolean, reason?: string }}
 */
export async function rotateProxyIp(log, { force = false, allowDuringLogin = false } = {}) {
  const run = async () => {
    if (loginProxyExclusive && !allowDuringLogin) {
      log?.('proxy', 'Skipping rotation — login in progress (keep same IP)');
      return { rotated: false, skipped: true, reason: 'login_exclusive' };
    }
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
      log?.('proxy', 'Forcing IP rotation (bypass cooldown)…');
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
        if (loginProxyExclusive && !allowDuringLogin) {
          log?.('proxy', 'Aborting rotate wait — login started (keep same IP)');
          return { rotated: false, skipped: true, reason: 'login_exclusive' };
        }
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
      if (loginProxyExclusive && !allowDuringLogin) {
        log?.('proxy', 'Skipping rotation — login in progress (keep same IP)');
        return { rotated: false, skipped: true, reason: 'login_exclusive' };
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

      const waitMs = rotateWaitMs();
      log?.('proxy', `Rotation sent — waiting ${Math.round(waitMs / 1000)}s for reconnect…`);
      await sleep(waitMs);
      await closeLocalProxy();

      let afterIp = await probeExitIp();
      if (beforeIp && afterIp && beforeIp === afterIp) {
        // Probe early — wait a bit more once, not a fixed 20s+30s pile-on.
        const extra = Math.max(5_000, Math.round(waitMs / 2));
        log?.(
          'proxy',
          `WARNING: exit IP still ${afterIp} after changeip — waiting ${Math.round(extra / 1000)}s and retrying rotate once…`
        );
        await sleep(extra);
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
      resetIpCounters();
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
