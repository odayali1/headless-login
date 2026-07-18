import { connectBrowser, resolveEngine } from './browser.js';
import { loadProfile, saveProfile, saveProfileTokens, markHttpRefreshRejected, CANONICAL_TARGET } from './profile.js';
import { resolveAccountFingerprint } from './anti-detect.js';
import {
  captureOutlookTokens,
  isTokenValid,
  tryAllBrowserlessRefresh,
  readMsalRefreshFromOrigins,
  collectMsalRefreshFromOrigins,
  tokenNeedsRenewal,
  isHttpRefreshRejected,
} from './token-extract.js';
import { notifyAccountTokenUpdated } from './sync-webhooks.js';
import { dismissOutlookBlockingPrompts } from './security-prompts.js';
import { TARGETS } from './microsoft-login.js';
import { closeLocalProxy, probeProxyReachability, ProxyUnreachableError } from './proxy-local.js';
import {
  beforeAccountBrowserSession,
  isBrowserlessHttpBlocked,
  isLoginProxyExclusive,
} from './proxy.js';
import { isProxyEnabled } from './settings.js';
import { invalidateAccountsCache } from './accounts.js';
import { isTokenExpiringSoon } from './account-health.js';

async function finishRefresh(email, target, useEngine, jobId, fingerprint, saved, tokens, refreshToken, log, { via = 'session' } = {}) {
  const now = new Date().toISOString();
  const merged = {
    ...tokens,
    refresh_token: tokens.refresh_token || refreshToken || null,
  };

  await saveProfileTokens(email, merged, {
    engine: useEngine,
    jobId,
    lastStatus: 'success',
    lastError: null,
    lastTokenRefreshAt: now,
    fingerprint,
    loginVia: saved.state.loginVia || CANONICAL_TARGET,
    // Keep skip-Loki flag after cookie SSO — RT redeem stays dead; avoids 2+ wasted HTTP calls each cycle.
    clearHttpRefreshRejected: via === 'loki' || via === 'browserless' || via === 'cache',
  });

  const label =
    via === 'browserless'
      ? 'Token refreshed (browserless — no Camoufox)'
      : via === 'loki'
        ? 'Token refreshed (Loki redeem — no Camoufox)'
        : via === 'cookie-pkce'
          ? 'Token refreshed (cookie SSO PKCE — no Camoufox)'
        : via === 'cache'
        ? 'Token still valid (no refresh needed)'
        : 'Token refreshed';
  log('success', label);
  notifyAccountTokenUpdated(email, target, { reason: 'token_refresh' }).catch(() => {});
  invalidateAccountsCache();
  return {
    status: 'success',
    email,
    target,
    accessToken: merged.access_token,
    tokenScope: merged.scope,
    tokenExpiresAt: merged.expires_at,
    hasToken: true,
    stillNeedsRefresh: tokenNeedsRenewal(merged),
    via,
  };
}

export async function tryBrowserlessAccountRefresh(
  email,
  target,
  { onProgress, jobId = 'refresh', lokiOnly = false } = {}
) {
  // Login / GCT shield / rotate — pause ALL HTTP (Loki included). Loki + GCT → 429.
  if (isBrowserlessHttpBlocked()) {
    return { success: false, deferred: true, skippedHttp: true };
  }
  const config = TARGETS[target];
  if (!config) throw new Error(`Unknown target: ${target}`);

  const saved = await loadProfile(email);
  if (!saved?.state) throw new Error('No saved profile — use Re-login first.');

  const log = (step, message) => onProgress?.({ step, message, timestamp: new Date().toISOString() });
  const useEngine = resolveEngine('auto');
  const fingerprint = resolveAccountFingerprint(email, saved.state.fingerprint);
  const refreshToken = saved.state.tokens?.refresh_token;
  const forceBrowserlessRefresh = isTokenExpiringSoon(saved.state.tokens);

  log('token', lokiOnly ? 'Requesting Loki redeem (login-safe)…' : 'Requesting LiveProfileCard.Access token…');
  const browserless = await tryAllBrowserlessRefresh(saved.state, log, {
    forceRefresh: forceBrowserlessRefresh,
    lokiOnly,
  });

  if (browserless.refreshTokenKnownBad) {
    await markHttpRefreshRejected(email).catch(() => {});
  }

  if (browserless.fromCache) {
    // Still valid — not a failure; do not send to Camoufox lane.
    return { success: true, fromCache: true, refreshTokenKnownBad: false };
  }
  if (
    browserless.tokens?.access_token &&
    isTokenValid(browserless.tokens) &&
    !tokenNeedsRenewal(browserless.tokens)
  ) {
    const result = await finishRefresh(
      email,
      target,
      useEngine,
      jobId,
      fingerprint,
      saved,
      browserless.tokens,
      refreshToken,
      log,
      { via: browserless.via || 'browserless' }
    );
    return { success: true, result, refreshTokenKnownBad: false, via: browserless.via || result.via };
  }

  return {
    success: false,
    refreshTokenKnownBad: browserless.refreshTokenKnownBad,
    skippedHttp: !!browserless.skippedHttp,
    deferredCookie: !!browserless.deferredCookie,
    saved,
  };
}

export async function refreshAccountToken(
  email,
  target,
  { engine = 'auto', onProgress, jobId = 'refresh', skipBrowserless = false } = {}
) {
  const config = TARGETS[target];
  if (!config) throw new Error(`Unknown target: ${target}`);

  // Manual/API refresh jobs were still burning Loki/Camoufox during Camoufox login → gct=429.
  if (isLoginProxyExclusive() || isBrowserlessHttpBlocked()) {
    const err = new Error('Login in progress — refresh deferred (will retry when login queue is idle)');
    err.code = 'REFRESH_DEFERRED';
    throw err;
  }

  const saved = await loadProfile(email);
  if (!saved?.state) throw new Error('No saved profile — use Re-login first.');

  const log = (step, message) => onProgress?.({ step, message, timestamp: new Date().toISOString() });

  const useEngine = resolveEngine(engine);
  const fingerprint = resolveAccountFingerprint(email, saved.state.fingerprint);
  const refreshToken = saved.state.tokens?.refresh_token;
  const forceBrowserlessRefresh = isTokenExpiringSoon(saved.state.tokens);
  let refreshTokenKnownBad = false;
  let session;

  try {
    if (!skipBrowserless) {
      if (
        !saved.state.tokens?.refresh_token &&
        !collectMsalRefreshFromOrigins(saved.state?.origins).length
      ) {
        log('token', 'No refresh token saved — opening Camoufox with saved session…');
        refreshTokenKnownBad = true;
      } else {
        const browserless = await tryAllBrowserlessRefresh(saved.state, log, {
          forceRefresh: forceBrowserlessRefresh,
        });
        if (browserless.refreshTokenKnownBad) {
          await markHttpRefreshRejected(email).catch(() => {});
        }
        if (browserless.fromCache && browserless.tokens && !tokenNeedsRenewal(browserless.tokens)) {
          return await finishRefresh(
            email,
            target,
            useEngine,
            jobId,
            fingerprint,
            saved,
            browserless.tokens,
            refreshToken,
            log,
            { via: 'cache' }
          );
        }
        if (browserless.tokens?.access_token && isTokenValid(browserless.tokens) && !tokenNeedsRenewal(browserless.tokens)) {
          return await finishRefresh(
            email,
            target,
            useEngine,
            jobId,
            fingerprint,
            saved,
            browserless.tokens,
            refreshToken,
            log,
            { via: browserless.via || 'browserless' }
          );
        }
        refreshTokenKnownBad = browserless.refreshTokenKnownBad;
        if (browserless.skippedHttp || browserless.deferredCookie) {
          const err = new Error('Login in progress — refresh deferred (HTTP/cookie paused)');
          err.code = 'REFRESH_DEFERRED';
          throw err;
        }
      }
    } else if (skipBrowserless) {
      refreshTokenKnownBad = true;
    }

    if (isHttpRefreshRejected(saved.state)) {
      refreshTokenKnownBad = true;
    }

    // Never open Camoufox refresh beside a login on the same mobile IP.
    if (isLoginProxyExclusive() || isBrowserlessHttpBlocked()) {
      const err = new Error('Login in progress — Camoufox refresh deferred');
      err.code = 'REFRESH_DEFERRED';
      throw err;
    }

    if (skipBrowserless) {
      log('token', 'Camoufox session capture (browserless already tried)…');
    } else if (refreshTokenKnownBad) {
      log('token', 'Refresh token rejected — opening Camoufox with saved session…');
    } else if (refreshToken) {
      log('token', 'Browserless refresh unavailable — opening Camoufox with saved session…');
    } else {
      log('token', 'No refresh token — opening Camoufox with saved session…');
    }

    const mustRenew = tokenNeedsRenewal(saved.state.tokens);

    if (isProxyEnabled()) {
      await beforeAccountBrowserSession((step, message) => log(step, message));
      const probe = await probeProxyReachability('https://login.live.com/');
      if (probe.ok) {
        log('proxy', `Proxy probe OK (${probe.mode}, ${probe.status || 200} in ${probe.ms}ms) before Camoufox`);
      } else {
        throw new ProxyUnreachableError(
          probe.error || 'Proxy unreachable — restart iProxy on the phone and retry.'
        );
      }
    }

    log('connect', 'Opening Camoufox for session-based token capture…');
    session = await connectBrowser({ email, target: CANONICAL_TARGET, fingerprint, saved, forceFresh: false });
    const context = session.context;
    const page = session.page || (await context.newPage());

    const tokens = await captureOutlookTokens(page, {
      log,
      context,
      engine: useEngine,
      existingTokens: saved.state.tokens,
      forceRenew: mustRenew || refreshTokenKnownBad,
      skipPreflightRefresh: false,
      refreshTokenKnownBad,
      dismissPrompts: async (p) => dismissOutlookBlockingPrompts(p, log, { skipBackupEmail: true }),
    });

    if (tokens?.error === 'invalid_grant') {
      throw new Error(
        `Refresh token expired/revoked by Microsoft (${tokens.error_description || 'invalid_grant'}). Re-login is required.`
      );
    }

    if (!tokens?.access_token || !isTokenValid(tokens) || tokenNeedsRenewal(tokens)) {
      throw new Error(
        'Could not obtain a fresh LiveProfileCard token. Re-login once on this server, wait for Outlook to fully load, then retry Refresh. If it keeps failing, check proxy connectivity to login.microsoftonline.com.'
      );
    }

    const now = new Date().toISOString();
    const storageState = await context.storageState().catch(() => null);
    const msalRefresh = readMsalRefreshFromOrigins(storageState?.origins);
    // Never re-save a refresh_token Microsoft already rejected — that causes a Camoufox loop.
    const nextRefresh =
      tokens.refresh_token ||
      msalRefresh ||
      (refreshTokenKnownBad ? null : refreshToken) ||
      null;
    if (refreshTokenKnownBad && !tokens.refresh_token && !msalRefresh) {
      log('token', 'No fresh refresh_token captured — next HTTP/Loki redeem will need another session capture');
    }
    await saveProfile(context, email, {
      engine: useEngine,
      staySignedIn: true,
      jobId,
      lastStatus: 'success',
      lastError: null,
      lastTokenRefreshAt: now,
      fingerprint,
      loginVia: saved.state.loginVia || CANONICAL_TARGET,
      tokens: {
        ...tokens,
        refresh_token: nextRefresh,
      },
    });

    log('success', 'Token refreshed');
    notifyAccountTokenUpdated(email, target, { reason: 'token_refresh' }).catch(() => {});
    // Do NOT bump PROXY_ROTATE_EVERY / changeip here — that counter is for real logins only.
    // Counting Camoufox refresh as a "login" jammed rotate at 9/6 and paused all HTTP keep-alive.
    invalidateAccountsCache();
    return {
      status: 'success',
      email,
      target,
      accessToken: tokens.access_token,
      tokenScope: tokens.scope,
      tokenExpiresAt: tokens.expires_at,
      hasToken: true,
      stillNeedsRefresh: tokenNeedsRenewal(tokens),
    };
  } finally {
    if (session) await session.close().catch(() => {});
  }
}

export { profilePath, CANONICAL_TARGET } from './profile.js';
