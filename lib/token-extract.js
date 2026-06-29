import { isProxyEnabled } from './settings.js';
import { isBackupEmailScreen } from './security-prompts.js';

const OUTLOOK_MAIL = 'https://outlook.live.com/mail/';
const TOKEN_URL_RE = /oauth2\/v2\.0\/token/i;

/** Outlook consumer MSAL app — LiveProfileCard token (matches DevTools curl). */
export const LIVEPROFILE = {
  clientId: '9199bf20-a13f-4107-85dc-02114787ef48',
  tokenUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
  redirectUri: 'https://outlook.live.com/mail/oauthRedirect.html',
  scope: 'liveprofilecard.access openid profile offline_access',
};

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

export async function captureOutlookTokens(page, { log, context, engine, existingTokens, forceRenew = false, dismissPrompts } = {}) {
  const CAPTURE_TIMEOUT_MS = 150_000;

  const work = async () => {
    let sawInvalidGrant = false;
    let invalidGrantMessage = null;

    if (!forceRenew && isLiveProfileCardToken(existingTokens) && isTokenValid(existingTokens)) {
      log?.('token', 'Using saved LiveProfileCard.Access token');
      return existingTokens;
    }
    if (forceRenew) {
      log?.('token', 'Force refresh requested — renewing token instead of reusing cached token');
    }

    const listener = attachTokenListener(page, context);
    await ensureOutlookMailPage(page, log, dismissPrompts);
    await waitForOutlookMailReady(page, log, dismissPrompts);

    if (await isOutlookLoginPage(page)) {
      log?.('token', 'Microsoft sign-in required — use Re-login.');
      listener.wait(1).catch(() => {});
      return null;
    }

    const storageState = context ? await context.storageState().catch(() => null) : null;
    const refreshFromMsal = (await readMsalRefreshToken(page)) || readMsalRefreshFromOrigins(storageState?.origins);
    // forceRenew skips cached access tokens only — always reuse saved refresh_token when present.
    const refreshFromProfile = existingTokens?.refresh_token;
    const refreshToken = refreshFromMsal || refreshFromProfile;

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
      if (isLiveProfileCardToken(exchanged)) {
        listener.wait(1).catch(() => {});
        return exchanged;
      }
      const errMsg = formatTokenExchangeError(exchanged);
      log?.('token', `Exchange failed: ${errMsg}`);
      if (isInvalidGrant(exchanged)) {
        sawInvalidGrant = true;
        invalidGrantMessage = errMsg;
        log?.('token', 'Refresh token rejected — trying session-based capture before requiring Re-login.');
      }
      if (isSpaOriginError(exchanged)) {
        log?.('token', 'SPA token endpoint — capturing from Outlook network instead…');
      }
    } else {
      log?.('token', 'No refresh_token yet — waiting for Outlook MSAL token request…');
    }

    let tokens = await triggerOutlookTokenCapture(page, listener, log, dismissPrompts);

    if (!isLiveProfileCardToken(tokens)) {
      log?.('token', 'Second Outlook reload to trigger MSAL…');
      tokens = await triggerOutlookTokenCapture(page, listener, log, dismissPrompts);
    }

    if (!isLiveProfileCardToken(tokens) && refreshToken) {
      log?.('token', 'Retrying refresh_token exchange (in-browser)…');
      tokens = await exchangeLiveProfileToken(page, context, refreshToken, log);
    }

    if (!isLiveProfileCardToken(tokens) && context && !isProxyEnabled()) {
      log?.('token', 'Trying Chromium fallback (proxy off only)…');
      tokens = await captureViaChromium(context, log, refreshToken);
    }

    listener.wait(1).catch(() => {});
    if (!isLiveProfileCardToken(tokens) && (await isBackupEmailScreen(page))) {
      log?.('token', 'Backup-email prompt still blocking Outlook — MSAL cannot load. Re-login with skip enabled.');
    }
    if (!isLiveProfileCardToken(tokens) && sawInvalidGrant) {
      return {
        error: 'invalid_grant',
        error_description: invalidGrantMessage || 'Refresh token rejected by Microsoft',
      };
    }
    return isLiveProfileCardToken(tokens) ? tokens : null;
  };

  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Token capture timed out after 150s')), CAPTURE_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    log?.('token', err.message);
    return null;
  }
}

async function triggerOutlookTokenCapture(page, listener, log, dismissPrompts) {
  log?.('token', 'Reloading Outlook to trigger token request…');
  await page.reload({ waitUntil: 'load', timeout: 60_000 }).catch(() => {});
  await waitForOutlookMailReady(page, log, dismissPrompts);
  await pokeOutlookMsal(page);

  let tokens = await listener.wait(55_000);

  if (!isLiveProfileCardToken(tokens)) {
    log?.('token', 'Checking MSAL cache…');
    tokens = (await readMsalLiveProfileToken(page)) || null;
  }

  if (!isLiveProfileCardToken(tokens)) {
    await page.waitForTimeout(5000);
    tokens = (await listener.wait(25_000)) || (await readMsalLiveProfileToken(page));
  }

  return tokens;
}

/** POST to consumers/oauth2/v2.0/token — must run inside outlook.live.com (SPA Origin). */
export async function exchangeLiveProfileToken(page, context, refreshToken, log) {
  if (!page) return { error: 'no_page', error_description: 'Browser page required for token exchange' };

  const payload = {
    client_id: LIVEPROFILE.clientId,
    redirect_uri: LIVEPROFILE.redirectUri,
    scope: LIVEPROFILE.scope,
    grant_type: 'refresh_token',
    client_info: '1',
    refresh_token: refreshToken,
  };

  const body = new URLSearchParams(payload).toString();

  await ensureOutlookMailPage(page, log);
  await waitForOutlookMailReady(page, log);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const json = await exchangeInBrowser(page, body);
    if (isLiveProfileCardToken(json)) return normalizeTokenPayload(json, 'refresh_exchange');
    if (json?.error && !isNetworkError(json)) {
      if (isInvalidGrant(json)) return json;
      if (!isSpaOriginError(json) && attempt === 3) return json;
    }

    if (context) {
      const viaRequest = await exchangeViaContextRequest(context, body);
      if (isLiveProfileCardToken(viaRequest)) return normalizeTokenPayload(viaRequest, 'refresh_exchange');
      if (viaRequest?.error && isInvalidGrant(viaRequest)) return viaRequest;
    }

    if (attempt < 3) {
      log?.('token', `Exchange attempt ${attempt} failed — waiting for Outlook to settle…`);
      await page.waitForTimeout(4000);
      await waitForOutlookMailReady(page, log);
    }
  }

  return { error: 'unknown', error_description: 'Token exchange returned no access token' };
}

async function exchangeInBrowser(page, body) {
  try {
    return await page.evaluate(
      async ({ tokenUrl, body }) => {
        const post = async () => {
          const res = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
              Origin: 'https://outlook.live.com',
              Referer: 'https://outlook.live.com/mail/',
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
      { tokenUrl: LIVEPROFILE.tokenUrl, body }
    );
  } catch (err) {
    return { error: 'page_fetch_failed', error_description: err.message };
  }
}

async function exchangeViaContextRequest(context, body) {
  try {
    const res = await context.request.post(LIVEPROFILE.tokenUrl, {
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
        Origin: 'https://outlook.live.com',
        Referer: 'https://outlook.live.com/mail/',
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

async function ensureOutlookMailPage(page, log, dismissPrompts) {
  if (!/outlook\.live\.com\/mail/i.test(page.url())) {
    log?.('token', 'Loading Outlook mail…');
    await page.goto(OUTLOOK_MAIL, { waitUntil: 'load', timeout: 60_000 }).catch(() => {});
  }
  await runDismissPrompts(page, dismissPrompts);
}

async function runDismissPrompts(page, dismissPrompts) {
  if (!dismissPrompts) return;
  try {
    await dismissPrompts(page);
  } catch {
    // ignore
  }
}

async function waitForOutlookMailReady(page, log, dismissPrompts, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
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
  return code === 'invalid_grant' || desc.includes('invalid_grant') || desc.includes('expired');
}

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
  await page2.goto(OUTLOOK_MAIL, { waitUntil: 'load', timeout: 60_000 }).catch(() => {});
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

function readMsalRefreshFromOrigins(origins) {
  for (const origin of origins || []) {
    if (!/outlook\.live\.com/i.test(origin.origin || '')) continue;
    const { refresh } = parseMsalStorageItems(origin.localStorage, LIVEPROFILE.clientId);
    const preferred = refresh.find((f) => /liveprofilecard/i.test(f.key));
    if (preferred?.secret) return preferred.secret;
    if (refresh[0]?.secret) return refresh[0].secret;
  }
  return null;
}

function readMsalAccessFromOrigins(origins) {
  for (const origin of origins || []) {
    if (!/outlook\.live\.com/i.test(origin.origin || '')) continue;
    const { access } = parseMsalStorageItems(origin.localStorage, LIVEPROFILE.clientId);
    const preferred = access.find((c) => /liveprofilecard/i.test(c.key));
    return (preferred || access[0])?.token || null;
  }
  return null;
}

async function readMsalRefreshToken(page) {
  try {
    return await page.evaluate((clientId) => {
      const want = clientId.toLowerCase();
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
    }, LIVEPROFILE.clientId);
  } catch {
    return null;
  }
}

async function readMsalLiveProfileToken(page) {
  try {
    return await page.evaluate((clientId) => {
      const want = clientId.toLowerCase();
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
    }, LIVEPROFILE.clientId);
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
