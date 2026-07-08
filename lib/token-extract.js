import { request as playwrightRequest } from 'playwright-core';
import { isProxyEnabled } from './settings.js';
import { assertProxyReady } from './proxy.js';
import { closeLocalProxy, getLocalProxyForBrowser } from './proxy-local.js';
import { isBackupEmailScreen } from './security-prompts.js';

const OUTLOOK_MAIL = 'https://outlook.live.com/mail/';
const TOKEN_URL_RE = /oauth2\/v2\.0\/token/i;
/** Match dashboard "needs refresh" — same buffer as account-health.js */
const REFRESH_BUFFER_MS = Number(process.env.SMART_REFRESH_BUFFER_MS || 20 * 60 * 1000);
/** Fail fast on HTTP token refresh — Playwright default is 60s and blocks the whole refresh queue. */
const BROWSERLESS_HTTP_TIMEOUT_MS = Number(process.env.BROWSERLESS_HTTP_TIMEOUT_MS || 18_000);
/** Skip HTTP refresh for this long after Microsoft returns invalid_grant for stored refresh_token. */
const HTTP_REFRESH_REJECTED_SKIP_MS = Number(process.env.HTTP_REFRESH_REJECTED_SKIP_MS || 24 * 60 * 60 * 1000);
/** domcontentloaded avoids waiting for images/fonts — saves ~30-50% per navigation on mobile proxy. */
const NAV_WAIT = 'domcontentloaded';

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

const TOKEN_PROFILES = [LIVEPROFILE, TEAMS_LIVEPROFILE];

export function isLiveProfileCardToken(data) {
  if (!data?.access_token) return false;
  const scope = String(data.scope || '').toLowerCase();
  return scope.includes('liveprofilecard');
}

export function attachTokenListener(page, context) {
  let captured = null;
  let resolve;
  const done = new Promise((r) => {
    resolve = r;
  });

  const onResponse = async (response) => {
    if (captured) return;
    if (!TOKEN_URL_RE.test(response.url())) return;
    try {
      const json = await response.json();
      if (!isLiveProfileCardToken(json)) return;
      captured = normalizeTokenPayload(json, 'network');
      resolve(captured);
    } catch {
      // ignore non-json
    }
  };

  const bind = (p) => p.on('response', onResponse);
  bind(page);
  if (context) context.on('page', bind);

  return {
    wait: (timeoutMs = 45_000) =>
      Promise.race([
        done,
        new Promise((r) => setTimeout(() => r(captured), timeoutMs)),
      ]).finally(() => {
        page.off('response', onResponse);
        if (context) context.off('page', bind);
      }),
  };
}

export async function captureOutlookTokens(page, { log, context, engine, existingTokens, forceRenew = false, dismissPrompts, skipPreflightRefresh = false, refreshTokenKnownBad = false } = {}) {
  const proxySlow = isProxyEnabled();
  const CAPTURE_TIMEOUT_MS = refreshTokenKnownBad ? 90_000 : proxySlow ? 90_000 : 150_000;

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
      return captureViaSavedSession(page, listener, log, dismissPrompts, { sawInvalidGrant, invalidGrantMessage });
    }

    const refreshFromProfile = existingTokens?.refresh_token;
    if (!skipPreflightRefresh && refreshFromProfile && context) {
      log?.('token', 'Trying refresh_token exchange before Outlook load…');
      const early = await tryLightweightTokenRefresh(context, refreshFromProfile, log);
      if (acceptCapturedToken(early)) {
        listener.wait(1).catch(() => {});
        return early;
      }
      if (isInvalidGrant(early)) {
        sawInvalidGrant = true;
        invalidGrantMessage = formatTokenExchangeError(early);
        log?.('token', 'Refresh token rejected — trying session-based capture before requiring Re-login.');
        return captureViaSavedSession(page, listener, log, dismissPrompts, { sawInvalidGrant, invalidGrantMessage });
      }
    }

    await ensureOutlookMailPage(page, log, dismissPrompts);
    await waitForOutlookMailReady(page, log, dismissPrompts);

    if (await isOutlookLoginPage(page)) {
      log?.('token', 'Microsoft sign-in required — use Re-login.');
      listener.wait(1).catch(() => {});
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
        listener.wait(1).catch(() => {});
        return cached;
      }
    }

    if (refreshToken) {
      log?.('token', 'Exchanging refresh_token for LiveProfileCard.Access…');
      const exchanged = await exchangeLiveProfileToken(page, context, refreshToken, log);
      if (isLiveProfileCardToken(exchanged) && isTokenValid(exchanged)) {
        listener.wait(1).catch(() => {});
        return exchanged;
      }
      const errMsg = formatTokenExchangeError(exchanged);
      log?.('token', `Exchange failed: ${errMsg}`);
      if (isInvalidGrant(exchanged)) {
        sawInvalidGrant = true;
        invalidGrantMessage = errMsg;
        await clearMsalRefreshTokens(page).catch(() => {});
        log?.('token', 'Refresh token rejected — trying session-based capture before requiring Re-login.');
        return captureViaSavedSession(page, listener, log, dismissPrompts, { sawInvalidGrant, invalidGrantMessage });
      }
      if (isSpaOriginError(exchanged)) {
        log?.('token', 'SPA token endpoint — capturing from Outlook network instead…');
      }
    } else {
      log?.(
        'token',
        refreshTokenKnownBad
          ? 'Using saved session for MSAL token capture…'
          : 'No refresh_token yet — waiting for Outlook MSAL token request…'
      );
    }

    let tokens = await triggerOutlookTokenCapture(page, listener, log, dismissPrompts);

    if (!acceptCapturedToken(tokens)) {
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
      log?.('token', 'Outlook token capture incomplete — trying Teams…');
      tokens = await captureViaTeamsSession(page, listener, log, dismissPrompts);
    }

    listener.wait(1).catch(() => {});
    if (!acceptCapturedToken(tokens) && (await isBackupEmailScreen(page))) {
      log?.('token', 'Backup-email prompt still blocking Outlook — MSAL cannot load. Re-login with skip enabled.');
    }
    if (!acceptCapturedToken(tokens) && sawInvalidGrant) {
      return {
        error: 'invalid_grant',
        error_description: invalidGrantMessage || 'Refresh token rejected by Microsoft',
      };
    }
    return acceptCapturedToken(tokens);
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
  }
}

async function captureViaSavedSession(page, listener, log, dismissPrompts, { sawInvalidGrant, invalidGrantMessage }) {
  log?.('token', 'Using saved session for MSAL token capture…');
  if (!/outlook\.live\.com\/mail/i.test(page.url())) {
    await ensureOutlookMailPage(page, log, dismissPrompts);
  }
  await waitForMsalReady(page, log, dismissPrompts, 25_000);

  if (await isOutlookLoginPage(page)) {
    log?.('token', 'Microsoft sign-in required — use Re-login.');
    listener.wait(1).catch(() => {});
    return null;
  }

  await pokeOutlookMsal(page);
  let tokens = await listener.wait(30_000);

  if (!acceptCapturedToken(tokens, { fresh: true })) {
    const cached = await readMsalLiveProfileToken(page);
    if (acceptCapturedToken(cached, { fresh: true })) tokens = cached;
  }

  if (!acceptCapturedToken(tokens, { fresh: true })) {
    log?.('token', 'Reloading Outlook to trigger MSAL token request…');
    await page.reload({ waitUntil: NAV_WAIT, timeout: 45_000 }).catch(() => {});
    await waitForMsalReady(page, log, dismissPrompts, 25_000);
    await pokeOutlookMsal(page);
    tokens = await listener.wait(35_000);
    if (!acceptCapturedToken(tokens, { fresh: true })) {
      const cached = await readMsalLiveProfileToken(page);
      if (acceptCapturedToken(cached, { fresh: true })) tokens = cached;
    }
  }

  if (!acceptCapturedToken(tokens, { fresh: true })) {
    log?.('token', 'Outlook session capture did not yield a fresh token — trying Teams…');
    tokens = await captureViaTeamsSession(page, listener, log, dismissPrompts);
  }

  listener.wait(1).catch(() => {});
  if (!acceptCapturedToken(tokens, { fresh: true }) && sawInvalidGrant) {
    return {
      error: 'invalid_grant',
      error_description: invalidGrantMessage || 'Refresh token rejected by Microsoft',
    };
  }
  return acceptCapturedToken(tokens, { fresh: true });
}

async function triggerOutlookTokenCapture(page, listener, log, dismissPrompts) {
  log?.('token', 'Reloading Outlook to trigger token request…');
  await page.reload({ waitUntil: NAV_WAIT, timeout: 60_000 }).catch(() => {});
  await waitForOutlookMailReady(page, log, dismissPrompts);
  await pokeOutlookMsal(page);

  let tokens = await listener.wait(55_000);

  if (!acceptCapturedToken(tokens)) {
    log?.('token', 'Checking MSAL cache…');
    const cached = (await readMsalLiveProfileToken(page)) || null;
    if (acceptCapturedToken(cached)) tokens = cached;
  }

  if (!acceptCapturedToken(tokens)) {
    await page.waitForTimeout(5000);
    const fromNetwork = await listener.wait(25_000);
    if (acceptCapturedToken(fromNetwork)) {
      tokens = fromNetwork;
    } else {
      const cached = await readMsalLiveProfileToken(page);
      if (acceptCapturedToken(cached)) tokens = cached;
    }
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

/** Exchange refresh_token via Playwright API + saved cookies — no Camoufox launch. */
export async function tryBrowserlessTokenRefresh(savedState, refreshToken, log) {
  if (!refreshToken || !savedState?.cookies?.length) return null;
  if (isProxyEnabled()) assertProxyReady();

  let lastError = null;
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
  return lastError;
}

async function tryBrowserlessTokenRefreshProfile(savedState, refreshToken, profile) {
  const proxy = isProxyEnabled() ? { server: await getLocalProxyForBrowser() } : undefined;
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

/** Exchange refresh_token using Camoufox context cookies — no page load. */
export async function tryLightweightTokenRefresh(context, refreshToken, log) {
  if (!context || !refreshToken) return null;

  let lastError = null;
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
  return lastError;
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

async function gotoWithProxyRetry(page, url, log, { waitUntil = NAV_WAIT, timeout = 60_000 } = {}) {
  const opts = { waitUntil, timeout };
  try {
    await page.goto(url, opts);
    return true;
  } catch (err) {
    if (!isProxyEnabled()) throw err;
    log?.('proxy', `Navigation failed (${err.message}) — resetting proxy relay and retrying…`);
    await closeLocalProxy();
    await page.goto(url, opts);
    return true;
  }
}

async function ensureOutlookMailPage(page, log, dismissPrompts) {
  if (!/outlook\.live\.com\/mail/i.test(page.url())) {
    log?.('token', 'Loading Outlook mail…');
    await gotoWithProxyRetry(page, LIVEPROFILE.appUrl, log).catch(() => {});
  }
  await runDismissPrompts(page, dismissPrompts);
}

async function ensureTeamsPage(page, log, dismissPrompts) {
  if (!/teams\.live\.com/i.test(page.url())) {
    log?.('token', 'Loading Teams…');
    await gotoWithProxyRetry(page, TEAMS_LIVEPROFILE.appUrl, log).catch(() => {});
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

/**
 * Try every no-browser path: profile cache, profile refresh_token, MSAL refresh_token in origins.
 * Returns { tokens, refreshTokenKnownBad }.
 */
export async function tryAllBrowserlessRefresh(savedState, log) {
  const cached = readCachedTokenFromProfile(savedState);
  if (cached && !tokenNeedsRenewal(cached)) {
    log?.('token', 'Saved access token still valid in profile — no network needed');
    return { tokens: cached, refreshTokenKnownBad: false, fromCache: true };
  }

  if (isHttpRefreshRejected(savedState)) {
    log?.('token', 'Skipping HTTP refresh — refresh token previously rejected by Microsoft');
    return { tokens: null, refreshTokenKnownBad: true, fromCache: false, skippedHttp: true };
  }

  const candidates = [];
  if (savedState?.tokens?.refresh_token) candidates.push(savedState.tokens.refresh_token);
  for (const rt of collectMsalRefreshFromOrigins(savedState?.origins)) {
    if (!candidates.includes(rt)) candidates.push(rt);
  }

  if (!candidates.length) {
    return { tokens: null, refreshTokenKnownBad: false, fromCache: false };
  }

  let sawInvalidGrant = false;
  for (const rt of candidates) {
    const result = await tryBrowserlessTokenRefresh(savedState, rt, log);
    if (result?.access_token && isTokenValid(result)) {
      return { tokens: result, refreshTokenKnownBad: false, fromCache: false };
    }
    if (isInvalidGrant(result)) {
      sawInvalidGrant = true;
      log?.('token', 'Refresh token rejected by Microsoft');
    }
  }

  // Only treat refresh_token as dead when Microsoft returned invalid_grant.
  // Network/proxy errors should fall through to session-based capture with retries.
  return { tokens: null, refreshTokenKnownBad: sawInvalidGrant, fromCache: false };
}

async function readMsalRefreshToken(page) {
  for (const clientId of [LIVEPROFILE.clientId, TEAMS_LIVEPROFILE.clientId]) {
    const token = await readMsalRefreshTokenForClient(page, clientId);
    if (token) return token;
  }
  return null;
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

function normalizeTokenPayload(json, source) {
  const expiresIn = json.expires_in ?? json.ext_expires_in ?? 3600;
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
