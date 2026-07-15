import crypto from 'node:crypto';
import { request as playwrightRequest } from 'playwright-core';
import { isProxyEnabled } from './settings.js';
import { assertProxyReady } from './proxy.js';
import { getPlaywrightProxyConfig } from './proxy-local.js';
import { isBackupEmailScreen } from './security-prompts.js';

const OUTLOOK_MAIL = 'https://outlook.live.com/mail/';
const TOKEN_URL_RE = /oauth2\/v2\.0\/token/i;
/** Match dashboard "needs refresh" — same buffer as account-health.js */
const REFRESH_BUFFER_MS = Number(process.env.SMART_REFRESH_BUFFER_MS || 20 * 60 * 1000);
/** Fail fast on HTTP token refresh — Playwright default is 60s and blocks the whole refresh queue. */
const BROWSERLESS_HTTP_TIMEOUT_MS = Number(process.env.BROWSERLESS_HTTP_TIMEOUT_MS || 18_000);
/** Skip HTTP refresh for this long after Microsoft returns invalid_grant for stored refresh_token. */
const HTTP_REFRESH_REJECTED_SKIP_MS = Number(process.env.HTTP_REFRESH_REJECTED_SKIP_MS || 24 * 60 * 60 * 1000);
/** commit = first response received — Outlook SPA often never reaches domcontentloaded on mobile proxy. */
const NAV_WAIT = 'commit';
const NAV_TIMEOUT_MS = Number(process.env.PROXY_NAV_TIMEOUT_MS || 45_000);

function navTimeoutMs() {
  return isProxyEnabled() ? NAV_TIMEOUT_MS : 45_000;
}

/** Outlook consumer MSAL app — LiveProfileCard token (matches DevTools curl). */
export const LIVEPROFILE = {
  label: 'Outlook',
  clientId: '9199bf20-a13f-4107-85dc-02114787ef48',
  tokenUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
  redirectUri: 'https://outlook.live.com/mail/oauthRedirect.html',
  scope: 'liveprofilecard.access openid profile offline_access',
  origin: 'https://outlook.live.com',
  referer: 'https://outlook.live.com/mail/',
  appUrl: 'https://outlook.live.com/mail/',
};

/** Teams consumer MSAL — same LiveProfileCard scope; often longer-lived tokens (~24h). */
export const TEAMS_LIVEPROFILE = {
  label: 'Teams',
  clientId: '4b3e8f46-56d3-427f-b1e2-d239b2ea6bca',
  tokenUrl: 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/oauth2/v2.0/token',
  redirectUri: 'https://teams.live.com/v2/authv2',
  scope: 'liveprofilecard.access openid profile offline_access',
  origin: 'https://teams.live.com',
  referer: 'https://teams.live.com/',
  appUrl: 'https://teams.live.com/v2/',
};

/**
 * Loki-scope redeem (Teams SPA client) — same trick used by the fast headless refresh apps.
 * Access token works on LivePersonaCard / Loki APIs; no cookies or Camoufox required.
 */
export const LOKI_TEAMS = {
  label: 'Loki',
  clientId: '4b3e8f46-56d3-427f-b1e2-d239b2ea6bca',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  scope: 'https://loki.delve.office.com/.default openid profile offline_access',
  origin: 'https://teams.live.com',
  referer: 'https://teams.live.com/',
};

const TOKEN_PROFILES = [LIVEPROFILE, TEAMS_LIVEPROFILE];

/** True for LiveProfileCard tokens and Loki-scoped tokens (both work on LivePersonaCard). */
export function isLiveProfileCardToken(data) {
  if (!data?.access_token) return false;
  const scope = String(data.scope || '').toLowerCase();
  if (scope.includes('liveprofilecard')) return true;
  if (scope.includes('loki.delve.office.com')) return true;
  // Captured Loki Authorization header may omit scope — accept if source says so.
  if (data.source === 'loki_request' || data.source === 'loki_redeem') return true;
  return false;
}

export function attachTokenListener(page, context) {
  let captured = null;
  let capturedRefresh = null;
  let capturedClientId = '';
  let resolve;
  const done = new Promise((r) => {
    resolve = r;
  });

  const accept = (tokens) => {
    if (!tokens?.access_token) return;
    if (tokens.refresh_token) capturedRefresh = tokens.refresh_token;
    if (!captured) {
      if (!isLiveProfileCardToken(tokens) && tokens.source !== 'loki_request') return;
      captured = tokens;
      if (capturedRefresh && !captured.refresh_token) {
        captured = { ...captured, refresh_token: capturedRefresh };
      }
      resolve(captured);
    } else if (capturedRefresh && !captured.refresh_token) {
      captured = { ...captured, refresh_token: capturedRefresh };
    }
  };

  const onRequest = (request) => {
    try {
      if (!/loki\.delve\.office\.com/i.test(request.url())) return;
      const auth = request.headers()?.authorization || request.headers()?.Authorization || '';
      if (!/^Bearer\s+\S+/i.test(auth)) return;
      const access_token = auth.replace(/^Bearer\s+/i, '').trim();
      accept(
        normalizeTokenPayload(
          {
            access_token,
            refresh_token: capturedRefresh,
            scope: 'https://loki.delve.office.com/.default',
          },
          'loki_request'
        )
      );
    } catch {
      // ignore
    }
  };

  const onResponse = async (response) => {
    if (!TOKEN_URL_RE.test(response.url())) return;
    try {
      const req = response.request();
      const post = req.postData() || '';
      if (post) {
        const m = /client_id=([^&]+)/i.exec(post);
        if (m?.[1] && !capturedClientId) {
          try {
            capturedClientId = decodeURIComponent(m[1]);
          } catch {
            capturedClientId = m[1];
          }
        }
      }
      if (!response.ok()) return;
      const json = await response.json();
      if (json?.refresh_token) capturedRefresh = json.refresh_token;
      if (!json?.access_token) return;
      const scope = String(json.scope || '').toLowerCase();
      if (isLiveProfileCardToken(json) || scope.includes('loki') || scope.includes('liveprofilecard')) {
        accept(normalizeTokenPayload({ ...json, refresh_token: json.refresh_token || capturedRefresh }, 'network'));
      } else if (capturedRefresh && !captured) {
        // MSA token POST still useful — keep RT for Loki redeem even if AT scope isn't persona yet.
      }
    } catch {
      // ignore non-json
    }
  };

  const bind = (p) => {
    p.on('request', onRequest);
    p.on('response', onResponse);
  };
  bind(page);
  if (context) context.on('page', bind);

  return {
    getRefreshToken: () => capturedRefresh,
    getClientId: () => capturedClientId,
    getCaptured: () => {
      if (captured && capturedRefresh && !captured.refresh_token) {
        captured = { ...captured, refresh_token: capturedRefresh };
      }
      return captured;
    },
    wait: (timeoutMs = 45_000) =>
      Promise.race([
        done,
        new Promise((r) =>
          setTimeout(() => {
            if (captured && capturedRefresh && !captured.refresh_token) {
              captured = { ...captured, refresh_token: capturedRefresh };
            }
            r(captured);
          }, timeoutMs)
        ),
      ]),
    stop: () => {
      page.off('request', onRequest);
      page.off('response', onResponse);
      if (context) context.off('page', bind);
    },
  };
}

export async function captureOutlookTokens(page, { log, context, engine, existingTokens, forceRenew = false, dismissPrompts, skipPreflightRefresh = false, refreshTokenKnownBad = false } = {}) {
  // Fresh password login needs longer under LOGIN_PARALLEL (Outlook SPA + Teams + Loki).
  const likelyFresh = !existingTokens?.refresh_token && !refreshTokenKnownBad;
  const CAPTURE_TIMEOUT_MS = refreshTokenKnownBad
    ? 90_000
    : likelyFresh
      ? 240_000
      : 150_000;

  const work = async () => {
    let sawInvalidGrant = refreshTokenKnownBad;
    let invalidGrantMessage = null;

    if (
      !forceRenew &&
      !refreshTokenKnownBad &&
      isLiveProfileCardToken(existingTokens) &&
      isTokenValid(existingTokens) &&
      !tokenNeedsRenewal(existingTokens)
    ) {
      log?.('token', 'Using saved LiveProfileCard.Access token');
      return existingTokens;
    }
    if (forceRenew && !refreshTokenKnownBad) {
      log?.('token', 'Force refresh requested — renewing token instead of reusing cached token');
    }

    const listener = attachTokenListener(page, context);

    if (refreshTokenKnownBad) {
      return captureViaSavedSession(page, listener, log, dismissPrompts, {
        sawInvalidGrant: true,
        invalidGrantMessage: null,
        context,
        refreshFromProfile: existingTokens?.refresh_token,
      });
    }

    const refreshFromProfile = existingTokens?.refresh_token;
    if (!skipPreflightRefresh && refreshFromProfile && context) {
      log?.('token', 'Trying refresh_token exchange before Outlook load…');
      const early = await tryLightweightTokenRefresh(context, refreshFromProfile, log);
      if (acceptCapturedToken(early)) {
        listener.stop?.();
        return early;
      }
      if (isInvalidGrant(early)) {
        sawInvalidGrant = true;
        invalidGrantMessage = formatTokenExchangeError(early);
        log?.('token', 'Refresh token rejected — trying session-based capture before requiring Re-login.');
        return captureViaSavedSession(page, listener, log, dismissPrompts, {
          sawInvalidGrant,
          invalidGrantMessage,
          context,
          refreshFromProfile,
        });
      }
    }

    await ensureOutlookMailPage(page, log, dismissPrompts);
    await waitForOutlookMailReady(page, log, dismissPrompts);

    if (await isOutlookLoginPage(page)) {
      log?.('token', 'Microsoft sign-in required — use Re-login.');
      listener.stop?.();
      return null;
    }

    const storageState = context ? await context.storageState().catch(() => null) : null;
    const refreshFromMsal =
      (await readMsalRefreshToken(page)) || collectMsalRefreshFromOrigins(storageState?.origins)[0] || null;
    // forceRenew skips cached access tokens only — always reuse saved refresh_token when present.
    let refreshToken = refreshFromMsal || (refreshTokenKnownBad ? null : refreshFromProfile);

    if (!forceRenew) {
      const cached =
        (await readMsalLiveProfileToken(page)) || readMsalAccessFromOrigins(storageState?.origins);
      if (isLiveProfileCardToken(cached) && isTokenValid(cached)) {
        log?.('token', 'Using MSAL cached LiveProfileCard token');
        listener.stop?.();
        return cached;
      }
    }

    if (refreshToken) {
      log?.('token', 'Exchanging refresh_token for LiveProfileCard.Access…');
      const exchanged = await exchangeLiveProfileToken(page, context, refreshToken, log);
      if (isLiveProfileCardToken(exchanged) && isTokenValid(exchanged)) {
        listener.stop?.();
        return {
          ...exchanged,
          refresh_token: exchanged.refresh_token || refreshToken,
        };
      }
      const errMsg = formatTokenExchangeError(exchanged);
      log?.('token', `Exchange failed: ${errMsg}`);
      if (isInvalidGrant(exchanged)) {
        sawInvalidGrant = true;
        invalidGrantMessage = errMsg;
        await clearMsalRefreshTokens(page).catch(() => {});
        log?.('token', 'Refresh token rejected — trying session-based capture before requiring Re-login.');
        return captureViaSavedSession(page, listener, log, dismissPrompts, {
          sawInvalidGrant,
          invalidGrantMessage,
          context,
          refreshFromProfile,
        });
      }
      if (isSpaOriginError(exchanged)) {
        log?.('token', 'SPA token endpoint — capturing from Outlook network instead…');
      }
    } else {
      // Fresh password login: Outlook MSAL first, then roadtx cookie SSO / Loki / Teams.
      log?.('token', 'No refresh_token yet — capturing from Outlook MSAL…');
    }

    const freshLogin = !refreshToken;
    // Fresh login under LOGIN_PARALLEL=2: Outlook is slow on one mobile IP.
    // Prefer a longer MSAL listen that mid-polls any overheard RT → Loki (TokenMan),
    // instead of burning the budget on PKCE (always login_required right after password).
    let tokens = await triggerOutlookTokenCapture(page, listener, log, dismissPrompts, {
      readyTimeoutMs: freshLogin ? 40_000 : undefined,
      listenMs: freshLogin ? 55_000 : undefined,
    });

    // TokenMan/FOCI: any MSA refresh_token → Loki LiveProfileCard (also mid-polled above).
    if (!acceptCapturedToken(tokens)) {
      const redeemed = await tryRedeemOverheardRefresh(page, listener, log);
      if (acceptCapturedToken(redeemed)) tokens = redeemed;
    }

    // Cookie PKCE only for existing sessions — right after password it is always login_required.
    if (!acceptCapturedToken(tokens) && context && !freshLogin) {
      log?.('token', 'Trying context cookie SSO PKCE (same Camoufox session)…');
      const cookieTokens = await tryContextRequestPkceAuthCode(context, log);
      if (acceptCapturedToken(cookieTokens)) tokens = cookieTokens;
    }

    if (!acceptCapturedToken(tokens) && !freshLogin) {
      log?.('token', 'Second Outlook reload to trigger MSAL…');
      tokens = await triggerOutlookTokenCapture(page, listener, log, dismissPrompts);
    }

    if (!acceptCapturedToken(tokens) && refreshToken && !sawInvalidGrant) {
      log?.('token', 'Retrying refresh_token exchange (in-browser)…');
      const retried = await exchangeLiveProfileToken(page, context, refreshToken, log);
      if (acceptCapturedToken(retried)) tokens = retried;
    }

    if (!acceptCapturedToken(tokens) && context && !isProxyEnabled()) {
      log?.('token', 'Trying Chromium fallback (proxy off only)…');
      const fallback = await captureViaChromium(context, log, refreshToken);
      if (acceptCapturedToken(fallback)) tokens = fallback;
    }

    if (!acceptCapturedToken(tokens)) {
      log?.('token', 'Outlook incomplete — Teams capture + Loki RT exchange…');
      const teamsTokens = await captureViaTeamsQuick(page, listener, log, dismissPrompts);
      if (acceptCapturedToken(teamsTokens)) tokens = teamsTokens;
    }

    // Last chance after Teams: second Outlook poke on fresh login (no PKCE).
    if (!acceptCapturedToken(tokens) && freshLogin) {
      log?.('token', 'Final Outlook reload for MSAL / Loki RT…');
      tokens = await triggerOutlookTokenCapture(page, listener, log, dismissPrompts, {
        readyTimeoutMs: 25_000,
        listenMs: 35_000,
      });
      if (!acceptCapturedToken(tokens)) {
        const redeemed = await tryRedeemOverheardRefresh(page, listener, log);
        if (acceptCapturedToken(redeemed)) tokens = redeemed;
      }
    }

    listener.stop?.();
    if (!acceptCapturedToken(tokens) && (await isBackupEmailScreen(page))) {
      log?.('token', 'Backup-email prompt still blocking Outlook — MSAL cannot load. Re-login with skip enabled.');
    }
    if (!acceptCapturedToken(tokens) && sawInvalidGrant) {
      return {
        error: 'invalid_grant',
        error_description: invalidGrantMessage || 'Refresh token rejected by Microsoft',
      };
    }
    const accepted = acceptCapturedToken(tokens);
    if (accepted) {
      return {
        ...accepted,
        refresh_token: accepted.refresh_token || listener.getRefreshToken?.() || refreshToken || null,
      };
    }
    return null;
  };

  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Token capture timed out after ${Math.round(CAPTURE_TIMEOUT_MS / 1000)}s`)),
          CAPTURE_TIMEOUT_MS
        )
      ),
    ]);
  } catch (err) {
    log?.('token', err.message);
    return null;
  } finally {
    // no-op: work() already stops listener; timeout path may leave it — safe to stop twice
  }
}

async function captureViaSavedSession(
  page,
  listener,
  log,
  dismissPrompts,
  { sawInvalidGrant, invalidGrantMessage, context, refreshFromProfile }
) {
  log?.('token', 'Using saved session for MSAL token capture…');
  const navTimeout = navTimeoutMs();

  // FAST PATH: Teams-first. Production logs show RT is captured on Teams;
  // Outlook mail load is slow and often dies with NS_ERROR_PROXY_CONNECTION_REFUSED.
  // Outlook is only a fallback if Teams does not yield a fresh refresh_token.
  log?.('token', 'Opening Teams to capture access + refresh tokens (skip Outlook first)…');
  await ensureTeamsPage(page, log, dismissPrompts, navTimeout);
  await page.waitForTimeout(3500);

  let tokens = await listener.wait(22_000);
  let networkRt = listener.getRefreshToken?.() || null;
  let clientId = listener.getClientId?.() || '';

  if (!acceptCapturedToken(tokens, { fresh: true }) || !networkRt) {
    log?.('token', 'Retrying Teams for token traffic…');
    await page.goto(TEAMS_LIVEPROFILE.appUrl, { waitUntil: NAV_WAIT, timeout: navTimeout }).catch(() => {});
    await page.waitForTimeout(4500);
    tokens = listener.getCaptured?.() || (await listener.wait(18_000));
    networkRt = listener.getRefreshToken?.() || networkRt;
    clientId = listener.getClientId?.() || clientId;
  }

  if (!networkRt && !(await isOutlookLoginPage(page))) {
    log?.('token', 'Teams had no refresh_token — waking Outlook once…');
    await ensureOutlookMailPage(page, log, dismissPrompts, navTimeout);
    if (await isOutlookLoginPage(page)) {
      log?.('token', 'Microsoft sign-in required — use Re-login.');
      listener.stop?.();
      return null;
    }
    await pokeOutlookMsal(page);
    await page.waitForTimeout(1500);
    // Fresh cookies after Outlook wake — try fast PKCE before another Teams round-trip.
    if (context) {
      const ctxTokens = await tryContextRequestPkceAuthCode(context, log);
      if (acceptCapturedToken(ctxTokens, { fresh: true })) {
        listener.stop?.();
        return ctxTokens;
      }
      const browserTokens = await tryInBrowserPkceAuthCode(page, context, log);
      if (acceptCapturedToken(browserTokens, { fresh: true })) {
        listener.stop?.();
        return browserTokens;
      }
    }
    await ensureTeamsPage(page, log, dismissPrompts, navTimeout);
    await page.waitForTimeout(4000);
    tokens = listener.getCaptured?.() || (await listener.wait(18_000));
    networkRt = listener.getRefreshToken?.() || networkRt;
    clientId = listener.getClientId?.() || clientId;
  } else if (await isOutlookLoginPage(page)) {
    // Common right after password login: Teams SSO not ready yet, but Outlook session is.
    log?.('token', 'Teams asked for sign-in — falling back to Outlook session…');
    await ensureOutlookMailPage(page, log, dismissPrompts, navTimeout);
    if (await isOutlookLoginPage(page)) {
      log?.('token', 'Microsoft sign-in required — use Re-login.');
      listener.stop?.();
      return null;
    }
    if (context) {
      const ctxTokens = await tryContextRequestPkceAuthCode(context, log);
      if (acceptCapturedToken(ctxTokens, { fresh: true })) {
        listener.stop?.();
        return ctxTokens;
      }
      const browserTokens = await tryInBrowserPkceAuthCode(page, context, log);
      if (acceptCapturedToken(browserTokens, { fresh: true })) {
        listener.stop?.();
        return browserTokens;
      }
    }
    await pokeOutlookMsal(page);
    tokens = listener.getCaptured?.() || (await listener.wait(20_000));
    networkRt = listener.getRefreshToken?.() || networkRt;
    clientId = listener.getClientId?.() || clientId;
  }

  // Prefer a freshly captured refresh_token — never trust a previously rejected one.
  const refreshFromMsal = await readMsalRefreshToken(page);
  const freshRt = networkRt || refreshFromMsal || null;

  if (freshRt) {
    log?.('token', 'Redeeming captured refresh_token (Loki scope)…');
    const redeemed = await tryLokiScopeRedeem(freshRt, log, { clientId: clientId || undefined });
    if (acceptCapturedToken(redeemed, { fresh: true })) {
      listener.stop?.();
      return {
        ...redeemed,
        refresh_token: redeemed.refresh_token || freshRt,
      };
    }
    if (context) {
      const exchanged = await exchangeLiveProfileToken(page, context, freshRt, log);
      if (acceptCapturedToken(exchanged, { fresh: true })) {
        listener.stop?.();
        return {
          ...exchanged,
          refresh_token: exchanged.refresh_token || freshRt,
        };
      }
    }
  } else if (refreshFromProfile && !sawInvalidGrant && context) {
    log?.('token', 'Trying saved refresh_token exchange…');
    const exchanged = await exchangeLiveProfileToken(page, context, refreshFromProfile, log);
    if (acceptCapturedToken(exchanged, { fresh: true })) {
      listener.stop?.();
      return exchanged;
    }
    if (isInvalidGrant(exchanged)) {
      sawInvalidGrant = true;
      invalidGrantMessage = formatTokenExchangeError(exchanged);
    }
  }

  if (!acceptCapturedToken(tokens, { fresh: true })) {
    const cached = await readMsalLiveProfileToken(page);
    if (acceptCapturedToken(cached, { fresh: true })) tokens = cached;
  }

  if (!acceptCapturedToken(tokens, { fresh: true })) {
    log?.('token', 'Reloading Outlook to trigger MSAL…');
    await ensureOutlookMailPage(page, log, dismissPrompts, navTimeout);
    await pokeOutlookMsal(page);
    tokens = listener.getCaptured?.() || (await listener.wait(20_000));
    networkRt = listener.getRefreshToken?.() || networkRt;
  }

  listener.stop?.();

  const accepted = acceptCapturedToken(tokens, { fresh: true });
  if (accepted) {
    return {
      ...accepted,
      refresh_token: accepted.refresh_token || networkRt || refreshFromMsal || null,
    };
  }

  if (sawInvalidGrant) {
    return {
      error: 'invalid_grant',
      error_description: invalidGrantMessage || 'Refresh token rejected by Microsoft',
    };
  }
  return null;
}

/**
 * TokenMan/FOCI: any overheard MSA refresh_token → Loki LiveProfileCard AT(+RT).
 * Checks network listener + MSAL localStorage (any first-party client).
 * @param {Set<string>} [triedRts] skip RTs already attempted this capture
 */
async function tryRedeemOverheardRefresh(page, listener, log, triedRts = null) {
  const candidates = [];
  const push = (rt, clientId, via) => {
    if (!rt || typeof rt !== 'string' || rt.length < 20) return;
    if (triedRts?.has(rt)) return;
    if (candidates.some((c) => c.rt === rt)) return;
    candidates.push({ rt, clientId: clientId || '', via });
  };

  push(listener?.getRefreshToken?.(), listener?.getClientId?.() || '', 'network');
  push(await readMsalRefreshToken(page).catch(() => null), '', 'msal');
  push(await readAnyMsalRefreshToken(page).catch(() => null), '', 'msal-any');

  for (const { rt, clientId, via } of candidates) {
    triedRts?.add(rt);
    log?.('token', `Redeeming ${via} refresh_token (Loki scope, TokenMan-style)…`);
    const redeemed = await tryLokiScopeRedeem(rt, log, { clientId: clientId || undefined });
    if (acceptCapturedToken(redeemed)) {
      return { ...redeemed, refresh_token: redeemed.refresh_token || rt };
    }
  }
  return null;
}

/** Poll MSAL / network during listen — redeem RT as soon as it appears (don't wait for LiveProfile AT). */
async function listenAndRedeem(page, listener, log, listenMs, triedRts = new Set()) {
  const end = Date.now() + listenMs;
  while (Date.now() < end) {
    const captured = acceptCapturedToken(listener.getCaptured?.());
    if (captured) return captured;

    const redeemed = await tryRedeemOverheardRefresh(page, listener, log, triedRts);
    if (redeemed) return redeemed;

    const slice = Math.min(3_000, end - Date.now());
    if (slice <= 0) break;
    await page.waitForTimeout(slice);
    await pokeOutlookMsal(page);
  }

  return (
    acceptCapturedToken(listener.getCaptured?.()) ||
    acceptCapturedToken(await readMsalLiveProfileToken(page).catch(() => null)) ||
    (await tryRedeemOverheardRefresh(page, listener, log, triedRts))
  );
}

async function triggerOutlookTokenCapture(
  page,
  listener,
  log,
  dismissPrompts,
  { readyTimeoutMs, listenMs } = {}
) {
  log?.('token', 'Reloading Outlook to trigger token request…');
  await page.reload({ waitUntil: NAV_WAIT, timeout: 60_000 }).catch(() => {});
  const readyBudget = readyTimeoutMs ?? (isProxyEnabled() ? 45_000 : 90_000);
  await waitForOutlookMailReady(page, log, dismissPrompts, readyBudget);
  await pokeOutlookMsal(page);

  const triedRts = new Set();
  // Early RT→Loki if Outlook already posted tokens during load.
  const early = await tryRedeemOverheardRefresh(page, listener, log, triedRts);
  if (early) return early;

  const firstListen = listenMs ?? 55_000;
  let tokens = await listenAndRedeem(page, listener, log, firstListen, triedRts);

  if (!acceptCapturedToken(tokens)) {
    log?.('token', 'Checking MSAL cache…');
    const cached = (await readMsalLiveProfileToken(page)) || null;
    if (acceptCapturedToken(cached)) tokens = cached;
  }

  // Full (non-fresh) path: short second listen.
  if (!acceptCapturedToken(tokens) && !listenMs) {
    await page.waitForTimeout(5000);
    tokens =
      (await listenAndRedeem(page, listener, log, 25_000, triedRts)) ||
      acceptCapturedToken(await readMsalLiveProfileToken(page).catch(() => null));
  }

  return acceptCapturedToken(tokens);
}

/** Teams after login — listen for RT and Loki-redeem (TokenMan), not just LiveProfile AT. */
async function captureViaTeamsQuick(page, listener, log, dismissPrompts) {
  const navTimeout = Math.min(navTimeoutMs(), 45_000);
  await ensureTeamsPage(page, log, dismissPrompts, navTimeout);
  if (/login\.(live|microsoftonline)\.com/i.test(page.url())) {
    log?.('token', 'Teams asked for sign-in — skipping');
    return null;
  }
  await page.waitForTimeout(4000);
  await pokeOutlookMsal(page);

  const triedRts = new Set();
  let tokens = await listenAndRedeem(page, listener, log, 28_000, triedRts);
  if (acceptCapturedToken(tokens)) return tokens;

  await page.goto(TEAMS_LIVEPROFILE.appUrl, { waitUntil: NAV_WAIT, timeout: navTimeout }).catch(() => {});
  await page.waitForTimeout(3000);
  tokens = await listenAndRedeem(page, listener, log, 20_000, triedRts);
  if (acceptCapturedToken(tokens)) return tokens;

  if (!listener.getRefreshToken?.()) {
    log?.('token', 'Teams loaded but no refresh_token overheard — MSAL idle on this IP');
  }
  return acceptCapturedToken(tokens);
}

function acceptCapturedToken(tokens, { fresh = false } = {}) {
  if (!isLiveProfileCardToken(tokens) || !isTokenValid(tokens)) return null;
  if (fresh && tokenNeedsRenewal(tokens)) return null;
  return tokens;
}

async function clearMsalRefreshTokens(page) {
  await page.evaluate((clientId) => {
    const want = clientId.toLowerCase();
    for (const storage of [localStorage, sessionStorage]) {
      const keys = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key && key.toLowerCase().includes(want) && /refreshtoken/i.test(key)) keys.push(key);
      }
      for (const key of keys) storage.removeItem(key);
    }
  }, LIVEPROFILE.clientId);
}

/** POST to oauth2/v2.0/token — tries Outlook then Teams MSAL params. */
export async function exchangeLiveProfileToken(page, context, refreshToken, log) {
  if (!page) return { error: 'no_page', error_description: 'Browser page required for token exchange' };

  let lastError = null;
  for (const profile of TOKEN_PROFILES) {
    const body = buildRefreshTokenBody(refreshToken, profile);

    if (context) {
      const viaRequest = await exchangeViaContextRequest(context, body, profile);
      if (isLiveProfileCardToken(viaRequest)) return normalizeTokenPayload(viaRequest, `refresh_exchange_${profile.label.toLowerCase()}`);
      if (viaRequest?.error && isInvalidGrant(viaRequest)) {
        lastError = viaRequest;
        log?.('token', `${profile.label} refresh token rejected — trying ${profile === LIVEPROFILE ? 'Teams' : 'Outlook'} MSAL…`);
        continue;
      }
      if (viaRequest?.error) lastError = viaRequest;
    }

    if (profile === TEAMS_LIVEPROFILE) await ensureTeamsPage(page, log);
    else await ensureOutlookMailPage(page, log);
    if (profile === LIVEPROFILE) await waitForOutlookMailReady(page, log);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const json = await exchangeInBrowser(page, body, profile);
      if (isLiveProfileCardToken(json)) return normalizeTokenPayload(json, `refresh_exchange_${profile.label.toLowerCase()}`);
      if (json?.error && !isNetworkError(json)) {
        if (isInvalidGrant(json)) {
          lastError = json;
          break;
        }
        if (!isSpaOriginError(json) && attempt === 3) lastError = json;
      }

      if (context) {
        const viaRequest = await exchangeViaContextRequest(context, body, profile);
        if (isLiveProfileCardToken(viaRequest)) return normalizeTokenPayload(viaRequest, `refresh_exchange_${profile.label.toLowerCase()}`);
        if (viaRequest?.error && isInvalidGrant(viaRequest)) {
          lastError = viaRequest;
          break;
        }
      }

      if (attempt < 3) {
        log?.('token', `${profile.label} exchange attempt ${attempt} failed — waiting for app to settle…`);
        await page.waitForTimeout(4000);
        if (profile === LIVEPROFILE) await waitForOutlookMailReady(page, log);
      }
    }
  }

  return lastError || { error: 'unknown', error_description: 'Token exchange returned no access token' };
}

function buildRefreshTokenBody(refreshToken, profile = LIVEPROFILE) {
  const payload = {
    client_id: profile.clientId,
    redirect_uri: profile.redirectUri,
    scope: profile.scope,
    grant_type: 'refresh_token',
    client_info: '1',
    refresh_token: refreshToken,
  };
  return new URLSearchParams(payload).toString();
}

function buildLokiRedeemBody(refreshToken, clientId = LOKI_TEAMS.clientId) {
  // Match the fast-refresh apps: no redirect_uri, Teams MSAL browser telemetry headers.
  return new URLSearchParams({
    client_id: clientId,
    scope: LOKI_TEAMS.scope,
    grant_type: 'refresh_token',
    client_info: '1',
    'x-client-SKU': 'msal.js.browser',
    'x-client-VER': '5.4.1',
    'x-ms-lib-capability': 'retry-after, h429',
    'x-client-current-telemetry': '5|61,0,,,,|,',
    'x-client-last-telemetry': '5|0|||0,0',
    refresh_token: refreshToken,
  }).toString();
}

async function playwrightProxyOpts() {
  if (!isProxyEnabled()) return undefined;

  // Browserless token POSTs: prefer HTTP CONNECT. Parallel SOCKS relay creates
  // race-kill other workers' 127.0.0.1 relays (ECONNREFUSED storms in logs).
  try {
    const { getProxyHttpUrl, parseProxyUrl } = await import('./settings.js');
    const httpUrl = getProxyHttpUrl();
    if (httpUrl) {
      const p = parseProxyUrl(httpUrl);
      return {
        server: `http://${p.host}:${p.port}`,
        username: p.username,
        password: p.password,
      };
    }
  } catch {
    // fall through
  }

  const cfg = await getPlaywrightProxyConfig();
  if (cfg?.mode === 'http-direct') {
    return { server: cfg.server, username: cfg.username, password: cfg.password };
  }
  if (cfg?.server) return { server: cfg.server };
  return undefined;
}

/**
 * Pure HTTP Loki-scope redeem — no cookies, no Camoufox.
 * This is the main speed trick from the other headless refresh apps.
 */
export async function tryLokiScopeRedeem(refreshToken, log, { clientId } = {}) {
  if (!refreshToken) return null;
  if (isProxyEnabled()) assertProxyReady();

  const clientIds = [...new Set([
    (clientId || '').trim(),
    LOKI_TEAMS.clientId,
    LIVEPROFILE.clientId,
  ].filter(Boolean))];

  const proxy = await playwrightProxyOpts();
  let lastError = null;

  for (const actualClientId of clientIds) {
    const isOutlookClient = actualClientId === LIVEPROFILE.clientId;
    const origin = isOutlookClient ? LIVEPROFILE.origin : LOKI_TEAMS.origin;
    const referer = isOutlookClient ? LIVEPROFILE.referer : LOKI_TEAMS.referer;
    log?.('token', `Browserless redeem (Loki scope, ${isOutlookClient ? 'Outlook' : 'Teams'} client, no Camoufox)…`);

    const ctx = await playwrightRequest.newContext({
      proxy,
      timeout: BROWSERLESS_HTTP_TIMEOUT_MS,
    });

    try {
      const res = await ctx.post(LOKI_TEAMS.tokenUrl, {
        timeout: BROWSERLESS_HTTP_TIMEOUT_MS,
        headers: {
          'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
          Accept: '*/*',
          Origin: origin,
          Referer: referer,
        },
        data: buildLokiRedeemBody(refreshToken, actualClientId),
      });
      const json = await res.json().catch(() => null);
      if (json?.access_token) {
        const normalized = normalizeTokenPayload(
          {
            ...json,
            scope: json.scope || LOKI_TEAMS.scope,
          },
          'loki_redeem'
        );
        if (isTokenValid(normalized)) {
          log?.('token', 'Loki-scope access token redeemed');
          return normalized;
        }
      }
      if (json?.error) {
        lastError = json;
        if (isInvalidGrant(json)) {
          log?.('token', `Loki redeem rejected (${isOutlookClient ? 'Outlook' : 'Teams'} client)`);
          continue;
        }
        log?.('token', `Loki redeem: ${json.error}`);
      } else {
        lastError = { error: 'loki_redeem_failed', error_description: `HTTP ${res.status()}` };
      }
    } catch (err) {
      lastError = { error: 'browserless_failed', error_description: err.message };
    } finally {
      await ctx.dispose().catch(() => {});
    }
  }

  return lastError;
}

async function tryBrowserlessTokenRefreshProfile(savedState, refreshToken, profile) {
  const proxy = await playwrightProxyOpts();
  const ctx = await playwrightRequest.newContext({
    storageState: {
      cookies: savedState.cookies,
      origins: savedState.origins || [],
    },
    proxy,
    timeout: BROWSERLESS_HTTP_TIMEOUT_MS,
  });

  try {
    const body = buildRefreshTokenBody(refreshToken, profile);
    const res = await ctx.post(profile.tokenUrl, {
      timeout: BROWSERLESS_HTTP_TIMEOUT_MS,
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
        Origin: profile.origin,
        Referer: profile.referer,
      },
      data: body,
    });
    return await res.json();
  } catch (err) {
    return { error: 'browserless_failed', error_description: err.message };
  } finally {
    await ctx.dispose().catch(() => {});
  }
}

/** Exchange refresh_token via Playwright API + saved cookies — no Camoufox launch. */
export async function tryBrowserlessTokenRefresh(savedState, refreshToken, log) {
  if (!refreshToken) return null;
  if (isProxyEnabled()) assertProxyReady();

  // Fast path first: Loki redeem needs only the refresh_token (no cookie jar).
  const loki = await tryLokiScopeRedeem(refreshToken, log);
  if (loki?.access_token && isTokenValid(loki)) return loki;

  // Dead RT — Outlook/Teams LiveProfile MSAL will also invalid_grant. Go Camoufox.
  if (isInvalidGrant(loki)) {
    return loki;
  }

  if (!savedState?.cookies?.length) {
    return loki?.error ? loki : null;
  }

  let lastError = loki?.error ? loki : null;
  for (const profile of TOKEN_PROFILES) {
    log?.('token', `Browserless refresh (${profile.label} MSAL, no Camoufox)…`);
    const result = await tryBrowserlessTokenRefreshProfile(savedState, refreshToken, profile);
    if (result?.access_token && isLiveProfileCardToken(result)) {
      const normalized = normalizeTokenPayload(result, `refresh_exchange_${profile.label.toLowerCase()}`);
      if (isTokenValid(normalized)) return normalized;
    }
    if (result?.error) {
      lastError = result;
      if (isInvalidGrant(result)) {
        log?.('token', `${profile.label} refresh token rejected by Microsoft`);
        continue;
      }
    }
  }
  return lastError || loki;
}

/** Exchange refresh_token using Camoufox context cookies — no page load. */
export async function tryLightweightTokenRefresh(context, refreshToken, log) {
  if (!refreshToken) return null;

  const loki = await tryLokiScopeRedeem(refreshToken, log);
  if (loki?.access_token && isTokenValid(loki)) return loki;

  if (!context) return loki?.error ? loki : null;

  let lastError = isInvalidGrant(loki) ? loki : null;
  for (const profile of TOKEN_PROFILES) {
    log?.('token', `Lightweight refresh (${profile.label} MSAL)…`);
    const body = buildRefreshTokenBody(refreshToken, profile);
    const json = await exchangeViaContextRequest(context, body, profile);
    if (isLiveProfileCardToken(json)) {
      const normalized = normalizeTokenPayload(json, `refresh_exchange_${profile.label.toLowerCase()}`);
      if (isTokenValid(normalized)) return normalized;
    }
    if (json?.error) {
      lastError = json;
      if (isInvalidGrant(json)) continue;
    }
  }
  return lastError || loki;
}

async function exchangeInBrowser(page, body, profile = LIVEPROFILE) {
  try {
    return await page.evaluate(
      async ({ tokenUrl, body, origin, referer }) => {
        const post = async () => {
          const res = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
              Origin: origin,
              Referer: referer,
            },
            body,
            credentials: 'include',
          });
          return res.json();
        };
        try {
          return await post();
        } catch {
          return await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', tokenUrl, true);
            xhr.setRequestHeader('content-type', 'application/x-www-form-urlencoded;charset=utf-8');
            xhr.withCredentials = true;
            xhr.onload = () => {
              try {
                resolve(JSON.parse(xhr.responseText));
              } catch (e) {
                reject(e);
              }
            };
            xhr.onerror = () => reject(new Error('XMLHttpRequest network error'));
            xhr.send(body);
          });
        }
      },
      { tokenUrl: profile.tokenUrl, body, origin: profile.origin, referer: profile.referer }
    );
  } catch (err) {
    return { error: 'page_fetch_failed', error_description: err.message };
  }
}

async function exchangeViaContextRequest(context, body, profile = LIVEPROFILE) {
  try {
    const res = await context.request.post(profile.tokenUrl, {
      timeout: BROWSERLESS_HTTP_TIMEOUT_MS,
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
        Origin: profile.origin,
        Referer: profile.referer,
      },
      data: body,
    });
    return await res.json();
  } catch (err) {
    return { error: 'context_request_failed', error_description: err.message };
  }
}

function isNetworkError(result) {
  const text = `${result?.error || ''} ${result?.error_description || ''}`.toLowerCase();
  return (
    text.includes('networkerror') ||
    text.includes('network error') ||
    text.includes('page_fetch_failed') ||
    text.includes('context_request_failed') ||
    text.includes('xmlhttprequest')
  );
}

async function gotoWithProxyRetry(page, url, log, { waitUntil = NAV_WAIT, timeout = navTimeoutMs() } = {}) {
  const opts = { waitUntil, timeout };
  try {
    await page.goto(url, opts);
    await page.waitForLoadState('domcontentloaded', { timeout: Math.min(25_000, timeout) }).catch(() => {});
    return true;
  } catch (err) {
    if (!isProxyEnabled()) throw err;
    log?.('proxy', `Navigation failed (${err.message}) — retrying once`);
    await page.waitForTimeout(1_500).catch(() => {});
    await page.goto(url, opts);
    await page.waitForLoadState('domcontentloaded', { timeout: Math.min(25_000, timeout) }).catch(() => {});
    return true;
  }
}

async function ensureOutlookMailPage(page, log, dismissPrompts, timeout = navTimeoutMs()) {
  if (!/outlook\.live\.com\/mail/i.test(page.url())) {
    log?.('token', 'Loading Outlook mail…');
    await gotoWithProxyRetry(page, LIVEPROFILE.appUrl, log, { timeout }).catch(() => {});
  }
  await runDismissPrompts(page, dismissPrompts);
}

async function ensureTeamsPage(page, log, dismissPrompts, timeout = navTimeoutMs()) {
  if (!/teams\.live\.com/i.test(page.url())) {
    log?.('token', 'Loading Teams…');
    await gotoWithProxyRetry(page, TEAMS_LIVEPROFILE.appUrl, log, { timeout }).catch(() => {});
  }
  await runDismissPrompts(page, dismissPrompts);
}

async function captureViaTeamsSession(page, listener, log, dismissPrompts) {
  await ensureTeamsPage(page, log, dismissPrompts);

  if (/login\.(live|microsoftonline)\.com/i.test(page.url())) {
    log?.('token', 'Microsoft sign-in required — use Re-login.');
    return null;
  }

  await page.waitForTimeout(3000);
  let tokens = await listener.wait(45_000);

  if (!acceptCapturedToken(tokens, { fresh: true })) {
    log?.('token', 'Reloading Teams to trigger MSAL token request…');
    await page.reload({ waitUntil: NAV_WAIT, timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(3000);
    tokens = await listener.wait(45_000);
  }

  return acceptCapturedToken(tokens, { fresh: true });
}

async function runDismissPrompts(page, dismissPrompts) {
  if (!dismissPrompts) return;
  try {
    await dismissPrompts(page);
  } catch {
    // ignore
  }
}

async function waitForMsalReady(page, log, dismissPrompts, timeoutMs = 35_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await runDismissPrompts(page, dismissPrompts);

    const url = page.url();
    if (/login\.(live|microsoftonline)\.com/i.test(url)) return false;

    if (/outlook\.live\.com/i.test(url)) {
      const ready = await page
        .evaluate((clientId) => {
          const want = clientId.toLowerCase();
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.toLowerCase().includes(want) && /accesstoken/i.test(key)) return true;
          }
          const body = document.body?.innerText || '';
          if (/new mail|inbox|focused|other/i.test(body)) return true;
          if (document.querySelector('[role="main"], #app, [data-app-section]')) return true;
          return false;
        }, LIVEPROFILE.clientId)
        .catch(() => false);
      if (ready) {
        await runDismissPrompts(page, dismissPrompts);
        return true;
      }
    }

    await page.waitForTimeout(1000);
  }

  log?.('token', 'MSAL still loading — continuing token capture anyway…');
  await runDismissPrompts(page, dismissPrompts);
  return true;
}

async function waitForOutlookMailReady(page, log, dismissPrompts, timeoutMs) {
  const budget = timeoutMs ?? (isProxyEnabled() ? 45_000 : 90_000);
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    await runDismissPrompts(page, dismissPrompts);

    const url = page.url();
    if (/login\.(live|microsoftonline)\.com/i.test(url)) return false;

    if (/outlook\.live\.com\/mail/i.test(url)) {
      const ready = await page
        .evaluate(() => {
          const body = document.body?.innerText || '';
          if (/new mail|inbox|focused|other|calendar|people/i.test(body)) return true;
          if (document.querySelector('[role="main"], [role="navigation"], #app, [data-app-section]')) return true;
          return false;
        })
        .catch(() => false);
      if (ready) {
        await runDismissPrompts(page, dismissPrompts);
        return true;
      }
    }

    await page.waitForTimeout(2500);
  }

  log?.('token', 'Outlook mail still loading — continuing token capture anyway…');
  await runDismissPrompts(page, dismissPrompts);
  return true;
}

async function pokeOutlookMsal(page) {
  try {
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('visibilitychange'));
    });
  } catch {
    // ignore
  }
}

function isSpaOriginError(result) {
  const text = `${result?.error || ''} ${result?.error_description || ''}`.toLowerCase();
  return text.includes('aadsts90023') || text.includes('single-page application') || text.includes('origin header');
}

function formatTokenExchangeError(result) {
  if (!result) return 'unknown';
  return result.error_description || result.error || 'unknown';
}

function isInvalidGrant(result) {
  const code = String(result?.error || '').toLowerCase();
  const desc = String(result?.error_description || '').toLowerCase();
  return (
    code === 'invalid_grant' ||
    desc.includes('invalid_grant') ||
    desc.includes('aadsts70000') ||
    desc.includes('grant is expired') ||
    desc.includes('must sign in again')
  );
}

export { isInvalidGrant };

async function isOutlookLoginPage(page) {
  try {
    const url = page.url();
    if (/login\.(live|microsoftonline)\.com/i.test(url)) return true;
    return await page.evaluate(() => {
      const u = location.href;
      if (/login\.(live|microsoftonline)\.com/i.test(u)) return true;
      const body = document.body?.innerText || '';
      return /sign in|enter password|verify your identity/i.test(body) && !/outlook\.live\.com\/mail/i.test(u);
    });
  } catch {
    return false;
  }
}

async function captureViaChromium(context, log, refreshToken) {
  log?.('token', 'Capturing LiveProfileCard token via Chromium session…');
  const { chromium } = await import('playwright');
  const state = await context.storageState();
  const browser = await chromium.launch({ headless: true });
  const ctx2 = await browser.newContext({ storageState: state });
  const page2 = await ctx2.newPage();

  if (refreshToken) {
    const exchanged = await exchangeLiveProfileToken(page2, ctx2, refreshToken, log);
    if (isLiveProfileCardToken(exchanged)) {
      await ctx2.close();
      await browser.close();
      return exchanged;
    }
  }

  const listener = attachTokenListener(page2);
  await page2.goto(OUTLOOK_MAIL, { waitUntil: NAV_WAIT, timeout: 60_000 }).catch(() => {});
  await page2.waitForTimeout(10000);
  let tokens = await listener.wait(30_000);
  if (!isLiveProfileCardToken(tokens)) tokens = await readMsalLiveProfileToken(page2);
  await ctx2.close();
  await browser.close();
  return tokens;
}

function parseMsalStorageItems(storageItems, clientId) {
  const want = clientId.toLowerCase();
  const refresh = [];
  const access = [];

  for (const item of storageItems || []) {
    const key = item.name || '';
    const keyLower = key.toLowerCase();
    if (!keyLower.includes(want)) continue;

    try {
      const raw = JSON.parse(item.value);
      if (/refreshtoken/i.test(keyLower)) {
        const secret = raw?.secret || raw?.refreshToken;
        if (secret) refresh.push({ key, secret });
      }
      if (/accesstoken/i.test(keyLower)) {
        const secret = raw?.secret || raw?.accessToken;
        if (!secret) continue;
        const expiresOn = raw?.expiresOn || raw?.extendedExpiresOn;
        const expiresIn = expiresOn
          ? Math.max(0, Math.floor((expiresOn - Date.now()) / 1000))
          : raw?.expiresIn;
        access.push({
          key,
          token: {
            access_token: secret,
            refresh_token: null,
            token_type: 'Bearer',
            scope: raw?.target || raw?.scopes?.join?.(' ') || 'LiveProfileCard.Access',
            expires_in: expiresIn,
            expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
            captured_at: new Date().toISOString(),
            source: 'msal_storage',
          },
        });
      }
    } catch {
      // skip
    }
  }

  return { refresh, access };
}

function readMsalRefreshFromOriginMatch(origins, originPattern, clientId) {
  for (const origin of origins || []) {
    if (!originPattern.test(origin.origin || '')) continue;
    const { refresh } = parseMsalStorageItems(origin.localStorage, clientId);
    const preferred = refresh.find((f) => /liveprofilecard/i.test(f.key));
    if (preferred?.secret) return preferred.secret;
    if (refresh[0]?.secret) return refresh[0].secret;
  }
  return null;
}

export function collectMsalRefreshFromOrigins(origins) {
  const seen = new Set();
  const out = [];
  const add = (token) => {
    if (token && !seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  };
  add(readMsalRefreshFromOriginMatch(origins, /outlook\.live\.com/i, LIVEPROFILE.clientId));
  add(readMsalRefreshFromOriginMatch(origins, /teams\.live\.com/i, TEAMS_LIVEPROFILE.clientId));
  return out;
}

export function readMsalRefreshFromOrigins(origins) {
  const candidates = collectMsalRefreshFromOrigins(origins);
  return candidates[0] || null;
}

function readMsalAccessFromOriginMatch(origins, originPattern, clientId) {
  for (const origin of origins || []) {
    if (!originPattern.test(origin.origin || '')) continue;
    const { access } = parseMsalStorageItems(origin.localStorage, clientId);
    const preferred = access.find((c) => /liveprofilecard/i.test(c.key));
    return (preferred || access[0])?.token || null;
  }
  return null;
}

function readMsalAccessFromOrigins(origins) {
  return (
    readMsalAccessFromOriginMatch(origins, /outlook\.live\.com/i, LIVEPROFILE.clientId) ||
    readMsalAccessFromOriginMatch(origins, /teams\.live\.com/i, TEAMS_LIVEPROFILE.clientId)
  );
}

/** True when access token is missing, expired, or inside the pre-expiry refresh window. */
export function tokenNeedsRenewal(tokens) {
  if (!isLiveProfileCardToken(tokens)) return true;
  if (!isTokenValid(tokens)) return true;
  if (!tokens?.expires_at) return true;
  return new Date(tokens.expires_at).getTime() - Date.now() <= REFRESH_BUFFER_MS;
}

/** Read valid token from saved profile file (origins cache or tokens field) — zero network. */
export function readCachedTokenFromProfile(savedState) {
  const fromOrigins = readMsalAccessFromOrigins(savedState?.origins);
  if (isLiveProfileCardToken(fromOrigins) && isTokenValid(fromOrigins)) return fromOrigins;
  if (isLiveProfileCardToken(savedState?.tokens) && isTokenValid(savedState.tokens)) {
    return savedState.tokens;
  }
  return null;
}

export function isHttpRefreshRejected(savedState) {
  if (!savedState?.httpRefreshRejectedAt) return false;
  const ago = Date.now() - new Date(savedState.httpRefreshRejectedAt).getTime();
  return ago >= 0 && ago < HTTP_REFRESH_REJECTED_SKIP_MS;
}

function makePkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function redeemAuthCode(profile, code, verifier, requestCtx, log) {
  const body = new URLSearchParams({
    client_id: profile.clientId,
    redirect_uri: profile.redirectUri,
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    scope: profile.scope,
  }).toString();

  const tok = await requestCtx.post(profile.tokenUrl, {
    timeout: Math.max(BROWSERLESS_HTTP_TIMEOUT_MS, 25_000),
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
      Origin: profile.origin,
      Referer: profile.referer,
    },
    data: body,
  });
  const json = await tok.json().catch(() => null);
  if (json?.access_token) {
    const normalized = normalizeTokenPayload(json, 'cookie_pkce');
    if (isTokenValid(normalized) && isLiveProfileCardToken(normalized)) {
      log?.('token', `Cookie SSO redeemed LiveProfileCard token (${profile.label}, no Camoufox)`);
      return normalized;
    }
  }
  if (json?.error) log?.('token', `Cookie SSO token redeem: ${json.error}`);
  return null;
}

/**
 * PKCE authorize using BrowserContext.request — shares Camoufox cookies AND proxy
 * (no separate HTTP CONNECT context that can thrash the SOCKS relay).
 */
export async function tryContextRequestPkceAuthCode(context, log) {
  if (!context?.request) return null;
  const profiles = [TEAMS_LIVEPROFILE, LIVEPROFILE];
  const ssoTimeoutMs = Math.max(BROWSERLESS_HTTP_TIMEOUT_MS, 35_000);

  // Warm MSA SSO cookies before prompt=none (fresh password login often needs this).
  try {
    await context.request.get('https://login.live.com/login.srf?wa=wsignin1.0', {
      timeout: 15_000,
      maxRedirects: 5,
    });
  } catch {
    // ignore — authorize may still work
  }

  for (const profile of profiles) {
    const { verifier, challenge } = makePkce();
    log?.('token', `Context cookie SSO (PKCE auth-code, ${profile.label})…`);

    const authUrl = new URL('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
    authUrl.searchParams.set('client_id', profile.clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', profile.redirectUri);
    authUrl.searchParams.set('scope', profile.scope);
    authUrl.searchParams.set('response_mode', 'query');
    authUrl.searchParams.set('prompt', 'none');
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    try {
      let url = authUrl.toString();
      let code = null;
      for (let hop = 0; hop < 12; hop++) {
        const res = await context.request.get(url, { maxRedirects: 0, timeout: ssoTimeoutMs });
        const loc = res.headers().location || res.headers().Location || '';
        if (!loc) break;
        const abs = new URL(loc, url).toString();
        const m = /[?&#]code=([^&]+)/.exec(abs);
        if (m) {
          code = decodeURIComponent(m[1]);
          break;
        }
        if (/error=/i.test(abs)) {
          const err = /error=([^&]+)/i.exec(abs)?.[1] || 'error';
          log?.('token', `Context SSO failed (${profile.label}): ${decodeURIComponent(err)}`);
          break;
        }
        url = abs;
      }

      if (!code) continue;
      const redeemed = await redeemAuthCode(profile, code, verifier, context.request, log);
      if (redeemed) return redeemed;
    } catch (err) {
      log?.('token', `Context SSO error (${profile.label}): ${err.message}`);
    }
  }
  return null;
}

/**
 * Right after password login, API-context cookie SSO often fails (ESTSAUTH not settled).
 * Drive authorize in the live Camoufox page so the browser cookie jar is used.
 */
export async function tryInBrowserPkceAuthCode(page, context, log) {
  if (!page || !context) return null;
  const profiles = [TEAMS_LIVEPROFILE, LIVEPROFILE];
  const navTimeout = Math.min(navTimeoutMs(), 35_000);

  for (const profile of profiles) {
    const { verifier, challenge } = makePkce();
    log?.('token', `In-browser cookie SSO (PKCE auth-code, ${profile.label})…`);

    const authUrl = new URL('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
    authUrl.searchParams.set('client_id', profile.clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', profile.redirectUri);
    authUrl.searchParams.set('scope', profile.scope);
    authUrl.searchParams.set('response_mode', 'query');
    authUrl.searchParams.set('prompt', 'none');
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    try {
      await page.goto(authUrl.toString(), { waitUntil: NAV_WAIT, timeout: navTimeout }).catch(() => {});
      // Follow SPA redirects until code lands on redirect_uri or error appears.
      let code = null;
      for (let i = 0; i < 20; i++) {
        const url = page.url();
        const m = /[?&#]code=([^&]+)/.exec(url);
        if (m) {
          code = decodeURIComponent(m[1]);
          break;
        }
        if (/[?&#]error=/i.test(url)) {
          log?.('token', `In-browser SSO failed (${profile.label}): login interaction required`);
          break;
        }
        // Redirect URI host reached without code yet — wait a tick.
        if (url.includes(new URL(profile.redirectUri).host)) {
          await page.waitForTimeout(500);
          continue;
        }
        await page.waitForTimeout(400);
      }

      if (!code) continue;

      const redeemed = await redeemAuthCode(profile, code, verifier, context.request, log);
      if (redeemed) return redeemed;
    } catch (err) {
      log?.('token', `In-browser SSO error (${profile.label}): ${err.message}`);
    }
  }
  return null;
}

/**
 * Session-cookie → OAuth auth code (prompt=none + PKCE) → LiveProfileCard AT+RT.
 * No Camoufox. ~10s when ESTSAUTH/MSPAuth SSO still valid — much faster than Outlook→Teams SPA.
 * Inspired by roadtx / ESTSAUTH SSO patterns; SPA clients need Origin on token redeem.
 */
export async function tryCookiePkceAuthCode(savedState, log) {
  const cookies = savedState?.cookies;
  if (!Array.isArray(cookies) || cookies.length < 3) return null;
  if (isProxyEnabled()) assertProxyReady();

  // Prefer HTTP CONNECT (same as Loki) — SOCKS local relay dies when login rotates IP
  // (ECONNREFUSED 127.0.0.1), which was killing cookie SSO mid-flight.
  let proxy;
  try {
    proxy = await playwrightProxyOpts();
  } catch {
    proxy = undefined;
  }
  const profiles = [TEAMS_LIVEPROFILE, LIVEPROFILE];
  /** Auth redirects are slower than a single token POST. */
  const ssoTimeoutMs = Math.max(BROWSERLESS_HTTP_TIMEOUT_MS, 35_000);

  for (const profile of profiles) {
    const { verifier, challenge } = makePkce();
    log?.('token', `Browserless cookie SSO (PKCE auth-code, ${profile.label})…`);

    const ctx = await playwrightRequest.newContext({
      proxy,
      storageState: { cookies, origins: [] },
      timeout: ssoTimeoutMs,
    });

    try {
      const authUrl = new URL('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
      authUrl.searchParams.set('client_id', profile.clientId);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('redirect_uri', profile.redirectUri);
      authUrl.searchParams.set('scope', profile.scope);
      authUrl.searchParams.set('response_mode', 'query');
      authUrl.searchParams.set('prompt', 'none');
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');

      let url = authUrl.toString();
      let code = null;
      for (let hop = 0; hop < 12; hop++) {
        const res = await ctx.get(url, { maxRedirects: 0, timeout: ssoTimeoutMs });
        const loc = res.headers().location || res.headers().Location || '';
        if (!loc) break;
        const abs = new URL(loc, url).toString();
        const m = /[?&#]code=([^&]+)/.exec(abs);
        if (m) {
          code = decodeURIComponent(m[1]);
          break;
        }
        if (/error=/i.test(abs)) {
          log?.('token', `Cookie SSO failed (${profile.label}): login interaction required`);
          break;
        }
        url = abs;
      }

      if (!code) continue;

      const redeemed = await redeemAuthCode(profile, code, verifier, ctx, log);
      if (redeemed) return redeemed;
    } catch (err) {
      log?.('token', `Cookie SSO error (${profile.label}): ${err.message}`);
    } finally {
      await ctx.dispose().catch(() => {});
    }
  }

  return null;
}

/**
 * Try every no-browser path: cache → Loki RT → cookie PKCE SSO → done.
 * Returns { tokens, refreshTokenKnownBad }.
 */
export async function tryAllBrowserlessRefresh(savedState, log, { forceRefresh = false } = {}) {
  const cached = readCachedTokenFromProfile(savedState);
  if (cached && !forceRefresh && !tokenNeedsRenewal(cached)) {
    log?.('token', 'Saved access token still valid in profile — no network needed');
    return { tokens: cached, refreshTokenKnownBad: false, fromCache: true };
  }
  if (cached && forceRefresh) {
    log?.('token', 'Token expires soon — forcing refresh_token exchange');
  }

  const rtRejected = isHttpRefreshRejected(savedState);
  let sawInvalidGrant = rtRejected;

  // Dead stored RT: skip Loki/MSAL RT redeem, but still try cookie SSO (often still works).
  if (!rtRejected) {
    const candidates = [];
    if (savedState?.tokens?.refresh_token) candidates.push(savedState.tokens.refresh_token);
    for (const rt of collectMsalRefreshFromOrigins(savedState?.origins)) {
      if (!candidates.includes(rt)) candidates.push(rt);
    }

    for (const rt of candidates) {
      const result = await tryBrowserlessTokenRefresh(savedState, rt, log);
      if (result?.access_token && isTokenValid(result)) {
        return {
          tokens: result,
          refreshTokenKnownBad: false,
          fromCache: false,
          via: result.source === 'loki_redeem' ? 'loki' : 'browserless',
        };
      }
      if (isInvalidGrant(result)) {
        sawInvalidGrant = true;
        log?.('token', 'Refresh token rejected by Microsoft');
      }
    }
  } else {
    log?.('token', 'Stored refresh_token previously rejected — trying session-cookie SSO…');
  }

  const cookieTokens = await tryCookiePkceAuthCode(savedState, log);
  if (cookieTokens?.access_token && isTokenValid(cookieTokens)) {
    return {
      tokens: cookieTokens,
      refreshTokenKnownBad: false,
      fromCache: false,
      via: 'cookie-pkce',
    };
  }

  return {
    tokens: null,
    refreshTokenKnownBad: sawInvalidGrant,
    fromCache: false,
    skippedHttp: false,
  };
}

async function readMsalRefreshToken(page) {
  for (const clientId of [LIVEPROFILE.clientId, TEAMS_LIVEPROFILE.clientId]) {
    const token = await readMsalRefreshTokenForClient(page, clientId);
    if (token) return token;
  }
  return null;
}

/** Any MSAL refresh_token in page storage (FOCI family — TokenMan can swap scopes). */
async function readAnyMsalRefreshToken(page) {
  try {
    return await page.evaluate(() => {
      const found = [];
      for (const storage of [localStorage, sessionStorage]) {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (!key || !/refreshtoken/i.test(key)) continue;
          try {
            const raw = JSON.parse(storage.getItem(key) || '');
            const secret = raw?.secret || raw?.refreshToken;
            if (typeof secret === 'string' && secret.length > 40) {
              found.push({ key, secret });
            }
          } catch {
            // skip
          }
        }
      }
      const preferred = found.find((f) => /liveprofilecard/i.test(f.key));
      return preferred?.secret || found[0]?.secret || null;
    });
  } catch {
    return null;
  }
}

async function readMsalRefreshTokenForClient(page, clientId) {
  try {
    return await page.evaluate((wantClientId) => {
      const want = wantClientId.toLowerCase();
      const found = [];
      const storages = [localStorage, sessionStorage];
      for (const storage of storages) {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (!key || !key.toLowerCase().includes(want) || !/refreshtoken/i.test(key)) continue;
          try {
            const raw = JSON.parse(storage.getItem(key));
            const secret = raw?.secret || raw?.refreshToken;
            if (secret) found.push({ key, secret });
          } catch {
            // skip
          }
        }
      }
      const preferred = found.find((f) => /liveprofilecard/i.test(f.key));
      return preferred?.secret || found[0]?.secret || null;
    }, clientId);
  } catch {
    return null;
  }
}

async function readMsalLiveProfileToken(page) {
  for (const clientId of [LIVEPROFILE.clientId, TEAMS_LIVEPROFILE.clientId]) {
    const token = await readMsalLiveProfileTokenForClient(page, clientId);
    if (token) return token;
  }
  return null;
}

async function readMsalLiveProfileTokenForClient(page, clientId) {
  try {
    return await page.evaluate((wantClientId) => {
      const want = wantClientId.toLowerCase();
      const candidates = [];
      const storages = [localStorage, sessionStorage];
      for (const storage of storages) {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (!key || !key.toLowerCase().includes(want) || !/accesstoken/i.test(key)) continue;
          try {
            const raw = JSON.parse(storage.getItem(key));
            const secret = raw?.secret || raw?.accessToken;
            if (!secret) continue;
            const expiresOn = raw?.expiresOn || raw?.extendedExpiresOn;
            const expiresIn = expiresOn
              ? Math.max(0, Math.floor((expiresOn - Date.now()) / 1000))
              : raw?.expiresIn;
            candidates.push({
              key,
              token: {
                access_token: secret,
                refresh_token: null,
                token_type: 'Bearer',
                scope: raw?.target || raw?.scopes?.join?.(' ') || 'LiveProfileCard.Access',
                expires_in: expiresIn,
                expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
                captured_at: new Date().toISOString(),
                source: 'msal_storage',
              },
            });
          } catch {
            // skip
          }
        }
      }
      const preferred = candidates.find((c) => /liveprofilecard/i.test(c.key));
      return (preferred || candidates[0])?.token || null;
    }, clientId);
  } catch {
    return null;
  }
}

function expiresInFromAccessToken(accessToken, fallbackSeconds = 86400) {
  const raw = String(accessToken || '').trim();
  // MSA LiveProfileCard tokens are often opaque (EwA…); only JWTs (eyJ…) carry exp.
  if (!raw.startsWith('eyJ')) return fallbackSeconds;
  try {
    const payload = raw.split('.')[1];
    if (!payload) return fallbackSeconds;
    const json = JSON.parse(Buffer.from(payload + '='.repeat((4 - (payload.length % 4)) % 4), 'base64url').toString('utf8'));
    const exp = Number(json?.exp || 0);
    if (!exp) return fallbackSeconds;
    const seconds = Math.floor(exp - Date.now() / 1000);
    return seconds > 60 ? seconds : fallbackSeconds;
  } catch {
    return fallbackSeconds;
  }
}

function normalizeTokenPayload(json, source) {
  // LiveProfileCard / Loki consumer tokens are ~24h when Microsoft returns expires_in.
  // Default must NOT be 3600 — that falsely marks healthy tokens as needs_refresh.
  const reported = json.expires_in ?? json.ext_expires_in;
  const expiresIn = Number(reported) > 0 ? Number(reported) : expiresInFromAccessToken(json.access_token, 86400);
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token || null,
    id_token: json.id_token || null,
    client_info: json.client_info || null,
    token_type: json.token_type || 'Bearer',
    scope: json.scope || 'LiveProfileCard.Access',
    expires_in: expiresIn,
    ext_expires_in: json.ext_expires_in ?? null,
    refresh_token_expires_in: json.refresh_token_expires_in ?? null,
    expires_at: new Date(Date.now() + Number(expiresIn) * 1000).toISOString(),
    captured_at: new Date().toISOString(),
    source,
  };
}

export function isTokenValid(tokens) {
  if (!isLiveProfileCardToken(tokens)) return false;
  if (!tokens.expires_at) return true;
  return new Date(tokens.expires_at).getTime() > Date.now() + 60_000;
}
