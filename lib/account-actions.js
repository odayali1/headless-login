import { connectBrowser, resolveEngine } from './browser.js';
import { loadProfile, saveProfile, saveProfileTokens, CANONICAL_TARGET } from './profile.js';
import { getAccountFingerprint } from './anti-detect.js';
import {
  captureOutlookTokens,
  isTokenValid,
  tryBrowserlessTokenRefresh,
  isInvalidGrant,
} from './token-extract.js';
import { notifyAccountTokenUpdated } from './sync-webhooks.js';
import { dismissOutlookBlockingPrompts } from './security-prompts.js';
import { TARGETS } from './microsoft-login.js';

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
  });

  const label = via === 'browserless' ? 'Token refreshed (browserless — no Camoufox)' : 'Token refreshed';
  log('success', label);
  notifyAccountTokenUpdated(email, target, { reason: 'token_refresh' }).catch(() => {});
  return {
    status: 'success',
    email,
    target,
    accessToken: merged.access_token,
    tokenScope: merged.scope,
    tokenExpiresAt: merged.expires_at,
    hasToken: true,
  };
}

export async function refreshAccountToken(email, target, { engine = 'auto', onProgress, jobId = 'refresh' } = {}) {
  const config = TARGETS[target];
  if (!config) throw new Error(`Unknown target: ${target}`);

  const saved = await loadProfile(email);
  if (!saved?.state) throw new Error('No saved profile — use Re-login first.');

  const log = (step, message) => onProgress?.({ step, message, timestamp: new Date().toISOString() });

  const useEngine = resolveEngine(engine);
  const fingerprint = saved.state.fingerprint || getAccountFingerprint(email);
  const refreshToken = saved.state.tokens?.refresh_token;
  let refreshTokenKnownBad = false;
  let session;

  try {
    log('token', 'Requesting LiveProfileCard.Access token…');

    if (refreshToken) {
      const browserless = await tryBrowserlessTokenRefresh(saved.state, refreshToken, log);
      if (isInvalidGrant(browserless)) {
        refreshTokenKnownBad = true;
        log('token', 'Refresh token rejected — opening Camoufox with saved session…');
      } else if (browserless?.access_token && isTokenValid(browserless)) {
        return await finishRefresh(email, target, useEngine, jobId, fingerprint, saved, browserless, refreshToken, log, {
          via: 'browserless',
        });
      } else if (browserless?.error) {
        log('token', 'Browserless refresh failed — opening Camoufox with saved session…');
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
      forceRenew: !refreshTokenKnownBad,
      skipPreflightRefresh: true,
      refreshTokenKnownBad,
      dismissPrompts: async (p) => dismissOutlookBlockingPrompts(p, log, { skipBackupEmail: true }),
    });

    if (tokens?.error === 'invalid_grant') {
      throw new Error(
        `Refresh token expired/revoked by Microsoft (${tokens.error_description || 'invalid_grant'}). Re-login is required.`
      );
    }

    if (!tokens?.access_token || !isTokenValid(tokens)) {
      throw new Error(
        'Could not obtain a fresh LiveProfileCard token. Re-login once on this server, wait for Outlook to fully load, then retry Refresh. If it keeps failing, check proxy connectivity to login.microsoftonline.com.'
      );
    }

    const now = new Date().toISOString();
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
        refresh_token: tokens.refresh_token || refreshToken || null,
      },
    });

    log('success', 'Token refreshed');
    notifyAccountTokenUpdated(email, target, { reason: 'token_refresh' }).catch(() => {});
    return {
      status: 'success',
      email,
      target,
      accessToken: tokens.access_token,
      tokenScope: tokens.scope,
      tokenExpiresAt: tokens.expires_at,
      hasToken: true,
    };
  } finally {
    if (session) await session.close().catch(() => {});
  }
}

export { profilePath, CANONICAL_TARGET } from './profile.js';
