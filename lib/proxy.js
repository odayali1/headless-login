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
  isHybridProxyEnabled,
  isLoginResidentialIpv4,
  isResidentialProxy,
  parseProxyUrl,
  setAccountsOnIp,
} from './settings.js';

import { probeExitIp } from './proxy-exit-ip.js';

export { getPlaywrightProxy, assertProxyReady, isProxyEnabled, probeExitIp };
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
 * Browserless (Loki / MSAL / cookie SSO PKCE) — no Camoufox.
 * Count successful refreshes only. Rotate only when idle after this many successes.
 * Default 100. Set 0 = never changeip for HTTP (Camoufox login batch still uses PROXY_ROTATE_EVERY).
 * Parsing must treat "0" as zero (never use `n || default` — that turned 0 into thrash).
 */
function envNonNegInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.trunc(n);
}
const HTTP_ROTATE_EVERY = envNonNegInt('PROXY_HTTP_ROTATE_EVERY', 100);
/**
 * Rotate before Camoufox login only if this many HTTP ops already ran on the IP.
 * Default 0 = OFF — keep the same IP for up to PROXY_ROTATE_EVERY logins.
 */
const LOGIN_CLEAN_IP_AFTER_HTTP = envNonNegInt('PROXY_LOGIN_CLEAN_IP_AFTER_HTTP', 0);

let rotateChain = Promise.resolve();
/** Serialize HTTP success counter so parallel workers do not race. */
let httpOpChain = Promise.resolve();
let lastRotateAt = 0;
let rotating = false;
/** Successful browserless refreshes on this IP (Loki/cookie SSO) — not failures. */
let httpOpsOnIp = 0;
/**
 * Camoufox login owns the mobile IP.
 * During exclusive: block ALL keep-alive HTTP (Loki + cookie SSO) and Camoufox refresh.
 * Loki beside GetCredentialType → gct=429 (proven in production logs).
 */
let loginProxyExclusive = false;
/** After login batch idle: keep cookie SSO blocked briefly; Loki still allowed. */
let loginHttpCooldownUntil = 0;
const LOGIN_HTTP_COOLDOWN_MS = Number(process.env.LOGIN_HTTP_COOLDOWN_MS || 90_000);
/**
 * Brief full pause of ALL browserless HTTP around GetCredentialType (email Next).
 * Cookie SSO + Loki on the same IP during that call → gct=429.
 */
let loginLiveShieldUntil = 0;
const LOGIN_LIVE_SHIELD_MS = Number(process.env.LOGIN_LIVE_SHIELD_MS || 45_000);
/** Settle after GCT-429 rotate before retrying email. */
export const GCT_429_SETTLE_MS = Number(process.env.GCT_429_SETTLE_MS || 60_000);
/** After a GCT 429, pause new logins on this phone so we don't burn the next N accounts. */
const GCT_HOT_COOLDOWN_MS = Number(process.env.GCT_HOT_COOLDOWN_MS || 120_000);
let gctHotUntil = 0;
let lastGctExitIp = null;

export function isProxyRotating() {
  return rotating;
}

export function isLoginProxyExclusive() {
  return loginProxyExclusive || Date.now() < loginHttpCooldownUntil;
}

/** True only during the short GetCredentialType window — block Loki too. */
export function isLoginLiveShieldActive() {
  return Date.now() < loginLiveShieldUntil;
}

/**
 * Cookie SSO always uses mobile. Keep it running during login jobs —
 * only pause while the mobile IP is mid-changeip.
 */
export function isLoginCookieSsoBlocked() {
  return isProxyRotating();
}

/**
 * Block browserless HTTP (Loki included).
 * Hybrid ON: Loki uses residential IPv6 — safe beside mobile login; never pause for exclusive/GCT.
 * Hybrid OFF: hard-pause during login (Loki on same mobile IP → gct=429).
 */
export function isBrowserlessHttpBlocked() {
  if (isHybridProxyEnabled()) {
    // Residential path is independent of mobile changeip / Camoufox login.
    return false;
  }
  return loginProxyExclusive || isLoginLiveShieldActive() || isProxyRotating();
}

export function beginLoginProxyExclusive() {
  loginProxyExclusive = true;
  loginHttpCooldownUntil = 0;
}

/**
 * Quiet login.live.com neighbors for GetCredentialType.
 * Extends if already active (retries).
 */
export function beginLoginLiveShield(ms = LOGIN_LIVE_SHIELD_MS) {
  const until = Date.now() + Math.max(5_000, Number(ms) || LOGIN_LIVE_SHIELD_MS);
  loginLiveShieldUntil = Math.max(loginLiveShieldUntil, until);
}

export function endLoginLiveShield() {
  loginLiveShieldUntil = 0;
}

/**
 * Release exclusive only when no more logins are waiting.
 * Cooldown only blocks cookie SSO / Camoufox refresh — Loki keep-alive continues.
 */
export function endLoginProxyExclusive({ queueWaiting = 0 } = {}) {
  if (queueWaiting > 0) {
    // Keep exclusive — more Camoufox logins still queued.
    return;
  }
  loginProxyExclusive = false;
  loginHttpCooldownUntil = Date.now() + LOGIN_HTTP_COOLDOWN_MS;
  endLoginLiveShield();
}

/**
 * True only when HTTP success budget is full (PROXY_HTTP_ROTATE_EVERY > 0).
 * Never true when every=0 (that bug made 0>=0 → rotate every tick).
 */
export function isProxyIpSaturated() {
  // Hybrid/residential: Loki is on rotating residential SOCKS — never saturate/pause for HTTP budget.
  if (!isProxyEnabled() || isResidentialProxy() || isHybridProxyEnabled() || HTTP_ROTATE_EVERY <= 0) {
    return false;
  }
  return httpOpsOnIp >= HTTP_ROTATE_EVERY;
}

export function getHttpRotateBudget() {
  return { every: HTTP_ROTATE_EVERY, successesOnIp: httpOpsOnIp };
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

async function connectProxy(log, { label, forceNewRelay = false } = {}) {
  const proxy = getPlaywrightProxy();
  // Reuse the local SOCKS relay across jobs — recreating it every time costs ~2–3s each.
  // Residential IPv4 / forceNewRelay: forceResolve so we never keep a stale mobile http-direct mode.
  const forceIpv4 = isResidentialProxy() || isLoginResidentialIpv4();
  const cfg = await getPlaywrightProxyConfig({
    forceNew: forceNewRelay,
    forceResolve: forceNewRelay || forceIpv4,
  });
  log?.('proxy', `Using ${cfg?.label || proxy.server}${label ? ` (${label})` : ''}.`);
  if (cfg?.mode === 'socks-relay') {
    log?.('proxy', `Local relay ${cfg.server} → Firefox (auth handled in-process).`);
  } else if (cfg?.mode === 'http-direct') {
    // HTTP is valid for ProxyScrape residential. Only refuse if we expected SOCKS
    // but somehow fell back to mobile HTTP CONNECT.
    try {
      const main = parseProxyUrl(getProxyUrl());
      if (
        forceIpv4 &&
        String(main.protocol).startsWith('socks') &&
        /fxdx\.in|iproxy/i.test(cfg.label || cfg.server || '')
      ) {
        throw new Error(
          'Residential SOCKS login resolved to mobile HTTP CONNECT — refuse PROXY_HTTP_URL fallback.'
        );
      }
    } catch (err) {
      if (err.message?.includes('refuse')) throw err;
    }
    log?.('proxy', 'Direct HTTP CONNECT (no local relay).');
  }
  return cfg;
}

/**
 * Count one successful browserless refresh (non-hybrid mobile only).
 * Hybrid: no-op — Loki/MSAL use residential (new exit per request); mobile changeip is login-batch only.
 * Does not rotate here — changeip mid cookie-SSO kills TLS. Idle rotate via rotateHttpProxyWhenIdle.
 * @param {*} log
 * @param {{ success?: boolean }} [opts] — only success:true bumps the counter
 */
export function trackBrowserlessHttpOp(log, { success = false, via = '' } = {}) {
  if (!isProxyEnabled() || HTTP_ROTATE_EVERY <= 0 || !success) return Promise.resolve();
  // Residential / hybrid HTTP must never drive mobile changeip or "pause until idle rotate".
  if (isHybridProxyEnabled() || isResidentialProxy()) return Promise.resolve();
  const run = async () => {
    if (loginProxyExclusive) return;
    httpOpsOnIp += 1;
    if (httpOpsOnIp < HTTP_ROTATE_EVERY) {
      if (httpOpsOnIp % 25 === 0 || httpOpsOnIp === 1) {
        log?.(
          'proxy',
          `Browserless successes on IP: ${httpOpsOnIp}/${HTTP_ROTATE_EVERY} (idle rotate at ${HTTP_ROTATE_EVERY})`
        );
      }
      return;
    }
    log?.(
      'proxy',
      `Browserless successes ${httpOpsOnIp}/${HTTP_ROTATE_EVERY} — pause HTTP until idle rotate`
    );
  };
  const next = httpOpChain.then(run, run);
  httpOpChain = next.then(
    () => {},
    () => {}
  );
  return next;
}

/**
 * Rotate only after HTTP success budget is full AND fast lane is idle (no in-flight SSO).
 */
export async function rotateHttpProxyWhenIdle(log) {
  if (!isProxyEnabled() || HTTP_ROTATE_EVERY <= 0 || !isProxyIpSaturated()) {
    return { rotated: false, skipped: true, reason: 'not_needed' };
  }
  if (loginProxyExclusive) {
    return { rotated: false, skipped: true, reason: 'login_exclusive' };
  }
  log?.(
    'proxy',
    `HTTP success budget full (${httpOpsOnIp}/${HTTP_ROTATE_EVERY}) — idle rotate (no Camoufox in flight)`
  );
  try {
    const result = await rotateProxyIp(log);
    if (result?.rotated) return result;
    // Do not spin forever at 51/50 if changeip fails — clear budget so keep-alive resumes.
    if (result?.skipped && result.reason !== 'login_exclusive' && result.reason !== 'cooldown') {
      log?.(
        'proxy',
        `WARNING: idle HTTP rotate skipped (${result.reason}) — clearing HTTP budget so refresh can continue`
      );
      httpOpsOnIp = 0;
    }
    return result;
  } catch (err) {
    log?.(
      'proxy',
      `WARNING: idle HTTP rotate failed (${err?.message || err}) — clearing HTTP budget so refresh can continue`
    );
    httpOpsOnIp = 0;
    return { rotated: false, skipped: true, reason: 'error' };
  }
}

/**
 * Mark the mobile exit as GCT-hot so the next queued login waits / rotates
 * instead of instantly failing the next account on the same burned IP.
 */
export function markGctHot(exitIp = null) {
  gctHotUntil = Date.now() + GCT_HOT_COOLDOWN_MS;
  if (exitIp) lastGctExitIp = exitIp;
}

export function isGctIpHot() {
  return Date.now() < gctHotUntil;
}

/**
 * Password blocked / Too Many Requests / similar soft-blocks: rotate now so the
 * next queued login does not keep burning the same exit (counter stays 0/N on
 * failures and never triggers afterAccountLoginSuccess).
 */
export async function afterLoginIpSoftBlock(log, { reason = 'ip_soft_block' } = {}) {
  if (!isProxyEnabled()) return { rotated: false, skipped: true, reason: 'proxy_off' };
  if (isResidentialProxy() || isLoginResidentialIpv4()) {
    // New SOCKS connection is enough — no sticky changeip (and don't burn the mobile phone IP).
    log?.(
      'proxy',
      `Login soft-block (${reason}) on residential IPv4 — next login will reconnect for a new exit`
    );
    setAccountsOnIp(0);
    return { rotated: false, skipped: true, reason: 'residential' };
  }

  const beforeIp = await probeExitIp().catch(() => lastGctExitIp);
  markGctHot(beforeIp || null);
  log?.(
    'proxy',
    `Login soft-block (${reason})${beforeIp ? ` on ${beforeIp}` : ''} — rotating IP before next account (failures never count toward PROXY_ROTATE_EVERY)`
  );

  let result = null;
  try {
    result = await rotateProxyIp(log, { force: true, allowDuringLogin: true });
  } catch (err) {
    log?.('proxy', `Soft-block rotate failed: ${err?.message || err}`);
    return { rotated: false, skipped: true, reason: 'error', beforeIp };
  }

  if (result?.rotated && result?.exitIp) {
    gctHotUntil = 0;
    setAccountsOnIp(0);
    const settle = Math.max(GCT_429_SETTLE_MS, Number(process.env.PROXY_POST_ROTATE_SETTLE_MS || 45_000));
    const sameSlash16 =
      beforeIp &&
      result.exitIp &&
      beforeIp.split('.').slice(0, 2).join('.') === result.exitIp.split('.').slice(0, 2).join('.');
    if (sameSlash16) {
      log?.(
        'proxy',
        `WARNING: new exit ${result.exitIp} is still same /16 as ${beforeIp} (same mobile carrier pool) — Microsoft may keep blocking password sign-in`
      );
    }
    log?.(
      'proxy',
      `Verified new exit ${result.exitIp} after soft-block — settling ${Math.round(settle / 1000)}s before next login…`
    );
    await sleep(settle);
    return { ...result, beforeIp, settledMs: settle, sameSlash16: !!sameSlash16 };
  }

  log?.(
    'proxy',
    `Soft-block rotate did not change IP (${result?.reason || 'unknown'}) — next login will wait out GCT-hot cooldown`
  );
  return { rotated: false, skipped: true, reason: result?.reason || 'no_change', beforeIp };
}

/**
 * Login — avoid changeip mid-email (breaks lookup). If the IP just got GCT 429,
 * wait out the hot cooldown (and rotate once if still hot) before the next account.
 */
export async function beforeAccountLogin(log) {
  if (!isProxyEnabled()) return;
  assertProxyReady();
  beginLoginProxyExclusive();

  // Residential rotating SOCKS — every new connection can be a new IP; no changeip / hot wait.
  // Also used when login preset is Residential IPv4 (hybrid may still be ON for refresh).
  if (isResidentialProxy() || isLoginResidentialIpv4()) {
    // Do NOT tear down the shared local relay while another Camoufox still pins it —
    // that causes NS_ERROR_PROXY_CONNECTION_REFUSED on parallel residential logins.
    const { resetProxyMode, closeLocalProxy, getLocalProxyRelayPinCount } = await import('./proxy-local.js');
    resetProxyMode();
    const pins = getLocalProxyRelayPinCount?.() || 0;
    if (pins === 0) {
      await closeLocalProxy().catch(() => {});
    } else {
      log?.(
        'proxy',
        `Keeping live SOCKS relay (${pins} Camoufox pin(s)) — parallel residential login`
      );
    }
    const { probeExitIp: probeIp } = await import('./proxy-exit-ip.js');
    const exitIp = await probeIp().catch(() => null);
    if (!exitIp) {
      log?.(
        'proxy',
        'WARNING: residential proxy could not resolve exit IP — switch dashboard preset or check credentials'
      );
      throw new Error(
        'Residential login proxy unreachable. Switch login proxy in the dashboard and retry.'
      );
    }
    log?.(
      'proxy',
      `Using residential for login — exit ${exitIp} (refresh stays hybrid mobile+IPv6 when hybrid ON)`
    );
    await connectProxy(log, {
      label: `residential ${exitIp}`,
      forceNewRelay: pins === 0,
    });
    return;
  }

  if (isGctIpHot()) {
    const waitMs = Math.max(5_000, gctHotUntil - Date.now());
    log?.(
      'proxy',
      `IP was GetCredentialType-hot${lastGctExitIp ? ` (${lastGctExitIp})` : ''} — waiting ${Math.round(waitMs / 1000)}s then rotating before next login…`
    );
    await sleep(waitMs);
    const rotated = await rotateProxyIp(log, { force: true, allowDuringLogin: true }).catch(() => null);
    if (rotated?.rotated) {
      gctHotUntil = 0;
      const settle = Math.max(GCT_429_SETTLE_MS, Number(process.env.PROXY_POST_ROTATE_SETTLE_MS || 45_000));
      log?.('proxy', `Settling ${Math.round(settle / 1000)}s after GCT-hot rotate…`);
      await sleep(settle);
    } else {
      log?.(
        'proxy',
        `WARNING: could not rotate off GCT-hot IP (${rotated?.reason || 'unknown'}) — login may still 429`
      );
    }
  }

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

/**
 * Camoufox token-capture for smart-refresh — connect only.
 * Never changeip here: rotate belongs to real logins (afterAccountLoginSuccess).
 * Refresh-triggered rotate was setting rotating=true for ~200s and freezing HTTP keep-alive.
 */
export async function beforeAccountBrowserSession(log) {
  if (!isProxyEnabled()) return;
  if (loginProxyExclusive) {
    throw new Error('Login in progress — defer smart-refresh Camoufox');
  }
  assertProxyReady();
  const onIp = getAccountsOnIp();
  const rotateAfter = Number(process.env.PROXY_ROTATE_EVERY) || getRotateAfter();
  await connectProxy(log, {
    label: `browser session ${onIp + 1} on this IP${onIp >= rotateAfter ? ` (login batch full ${onIp}/${rotateAfter} — rotate after next login)` : ''}`,
  });
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
  // DataImpulse residential login (sticky or rotating): new exit comes from reconnect /
  // rotating port — never run mobile changeip + 10s/45s settle after these logins.
  if (isResidentialProxy() || isLoginResidentialIpv4()) {
    setAccountsOnIp(0);
    log?.(
      'proxy',
      'Residential IPv4 login — skip mobile changeip/settle (exit rotates via DataImpulse)'
    );
    return;
  }
  const rotateAfter = Number(process.env.PROXY_ROTATE_EVERY) || getRotateAfter();
  const n = getAccountsOnIp() + 1;
  setAccountsOnIp(n);
  if (n < rotateAfter) return;

  log?.(
    'proxy',
    `${n} successful login(s) on this IP — rotating now (after login), next accounts get a settled IP`
  );
  let result;
  try {
    result = await rotateProxyIp(log, { force: true, allowDuringLogin: true });
  } catch (err) {
    log?.(
      'proxy',
      `WARNING: changeip threw after login batch (${err?.message || err}) — counter stays ${n}/${rotateAfter}, next login will retry rotate`
    );
    return;
  }
  if (result?.rotated) {
    const settle = Number(process.env.PROXY_POST_ROTATE_SETTLE_MS || 45_000);
    if (settle > 0) {
      log?.('proxy', `Settling ${Math.round(settle / 1000)}s after batch rotate…`);
      await sleep(settle);
    }
  } else if (result?.skipped) {
    log?.(
      'proxy',
      `WARNING: changeip did not complete (${result.reason || 'unknown'}) — still ${n}/${rotateAfter} on this IP`
    );
  }
}

/**
 * Browserless HTTP token refresh — proxy only; rotation tracked via trackBrowserlessHttpOp.
 * Hybrid: warm residential relay for Loki/MSAL (Camoufox fallback still uses mobile).
 */
export async function beforeAccountRefresh(log) {
  if (!isProxyEnabled()) return;
  assertProxyReady();
  if (isHybridProxyEnabled()) {
    try {
      const { getPlaywrightProxyConfigForLane } = await import('./proxy-local.js');
      const cfg = await getPlaywrightProxyConfigForLane('http-refresh');
      log?.(
        'proxy',
        `Hybrid ON — browserless via ${cfg?.label || 'residential'}; Camoufox/cookie still use mobile`
      );
    } catch (err) {
      log?.(
        'proxy',
        `Hybrid residential relay failed (${err?.message || err}) — falling back to mobile for this refresh`
      );
      await connectProxy(log, { label: 'token refresh (mobile fallback)' });
    }
    return;
  }
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
    if (isResidentialProxy() || isLoginResidentialIpv4()) {
      log?.('proxy', 'Residential proxy — skip changeip (IP rotates per provider connection)');
      const { getLocalProxyRelayPinCount } = await import('./proxy-local.js');
      if ((getLocalProxyRelayPinCount?.() || 0) === 0) {
        await closeLocalProxy();
      }
      return { rotated: true, skipped: false, reason: 'residential_reconnect', exitIp: null };
    }
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

    // Wait for Camoufox WITHOUT setting rotating=true — that flag pauses all HTTP
    // smart-refresh. Only mark rotating once changeip is actually in flight.
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

    rotating = true;
    try {
      const url = getRotateUrl();
      const beforeIp = await probeExitIp().catch(() => null);
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
      // Cookie SSO holds the same local SOCKS relay — closing under it → ECONNREFUSED 127.0.0.1.
      try {
        const { waitForCookieSsoQuiet } = await import('./token-extract.js');
        const quiet = await waitForCookieSsoQuiet(20_000);
        if (!quiet) {
          log?.('proxy', 'WARNING: cookie SSO still in flight — closing relay anyway after wait');
        }
      } catch {
        // ignore
      }
      await closeLocalProxy();

      let afterIp = await probeExitIp().catch(() => null);
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
          try {
            const { waitForCookieSsoQuiet } = await import('./token-extract.js');
            await waitForCookieSsoQuiet(15_000);
          } catch {
            // ignore
          }
          await closeLocalProxy();
          afterIp = await probeExitIp().catch(() => null);
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
