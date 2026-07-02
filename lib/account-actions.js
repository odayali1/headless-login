import { connectBrowser, resolveEngine } from './browser.js';
import { loadProfile, saveProfile, CANONICAL_TARGET } from './profile.js';
import { getAccountFingerprint } from './anti-detect.js';
import { captureOutlookTokens, isTokenValid } from './token-extract.js';
import { dismissOutlookBlockingPrompts } from './security-prompts.js';
import { TARGETS } from './microsoft-login.js';

export async function refreshAccountToken(email, target, { engine = 'auto', onProgress, jobId = 'refresh' } = {}) {
  const config = TARGETS[target];
  if (!config) throw new Error(`Unknown target: ${target}`);

  const saved = await loadProfile(email);
  if (!saved?.state) throw new Error('No saved profile — use Re-login first.');

  const log = (step, message) => onProgress?.({ step, message, timestamp: new Date().toISOString() });

  let session;

  try {
    const useEngine = resolveEngine(engine);
    const fingerprint = saved.state.fingerprint || getAccountFingerprint(email);
    log('connect', 'Refreshing token via Camoufox (stable profile)…');
    session = await connectBrowser({ email, target: CANONICAL_TARGET, fingerprint, saved, forceFresh: false });
    const context = session.context;
    const page = session.page || (await context.newPage());

    log('token', 'Requesting LiveProfileCard.Access token…');
    const tokens = await captureOutlookTokens(page, {
      log,
      context,
      engine: useEngine,
      existingTokens: saved.state.tokens,
      forceRenew: true,
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
        refresh_token: tokens.refresh_token || null,
      },
    });

    log('success', 'Token refreshed');
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
