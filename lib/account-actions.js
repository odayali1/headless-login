import { connectBrowser, resolveEngine } from './browser.js';
import { loadProfile, saveProfile, profilePath } from './profile.js';
import { getAccountFingerprint } from './anti-detect.js';
import { captureOutlookTokens } from './token-extract.js';
import { TARGETS } from './microsoft-login.js';

export async function refreshAccountToken(email, target, { engine = 'auto', onProgress, jobId = 'refresh' } = {}) {
  const config = TARGETS[target];
  if (!config) throw new Error(`Unknown target: ${target}`);

  const saved = await loadProfile(email, target);
  if (!saved?.state) throw new Error('No saved profile — use Re-login first.');

  const log = (step, message) => onProgress?.({ step, message, timestamp: new Date().toISOString() });

  let session;

  try {
    const useEngine = resolveEngine(engine);
    const fingerprint = saved.state.fingerprint || getAccountFingerprint(email);
    log('connect', 'Refreshing token via Camoufox (stable profile)…');
    session = await connectBrowser({ email, target, fingerprint, saved, forceFresh: false });
    const context = session.context;
    const page = session.page || (await context.newPage());

    log('token', 'Requesting LiveProfileCard.Access token…');
    const tokens = await captureOutlookTokens(page, {
      log,
      context,
      engine: useEngine,
      existingTokens: saved.state.tokens,
      forceRenew: true,
    });

    if (!tokens?.access_token) {
      throw new Error(
        'Could not obtain LiveProfileCard token. Re-login once on this server, wait for Outlook to fully load, then retry Refresh. If it keeps failing, check proxy connectivity to login.microsoftonline.com.'
      );
    }

    await saveProfile(context, email, target, {
      engine: useEngine,
      staySignedIn: true,
      jobId,
      lastStatus: 'success',
      fingerprint,
      tokens,
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

export { profilePath };
