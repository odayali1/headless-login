import { isProxyEnabled } from './settings.js';

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

export function attachTokenListener(page) {
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

  page.on('response', onResponse);

  return {
    wait: (timeoutMs = 45_000) =>
      Promise.race([
        done,
        new Promise((r) => setTimeout(() => r(captured), timeoutMs)),
      ]).finally(() => page.off('response', onResponse)),
  };
}

export async function captureOutlookTokens(page, { log, context, engine, existingTokens, forceRenew = false } = {}) {
  const CAPTURE_TIMEOUT_MS = 120_000;

  const work = async () => {
    if (!forceRenew && isLiveProfileCardToken(existingTokens) && isTokenValid(existingTokens)) {
      log?.('token', 'Using saved LiveProfileCard.Access token');
      return existingTokens;
    }
    if (forceRenew) {
      log?.('token', 'Force refresh requested — renewing token instead of reusing cached token');
    }

    const listener = attachTokenListener(page);
    await ensureOutlookMailPage(page, log);
    await page.waitForTimeout(3000);

    if (await isOutlookLoginPage(page)) {
      log?.('token', 'Microsoft sign-in required — use Re-login.');
      listener.wait(1).catch(() => {});
      return null;
    }

    const refreshFromProfile = existingTokens?.refresh_token;
    const refreshFromMsal = await readMsalRefreshToken(page);
    const refreshToken = refreshFromMsal || refreshFromProfile;

    if (!forceRenew) {
      const cached = await readMsalLiveProfileToken(page);
      if (isLiveProfileCardToken(cached) && isTokenValid(cached)) {
        log?.('token', 'Using MSAL cached LiveProfileCard token');
        listener.wait(1).catch(() => {});
        return cached;
      }
    }

    if (refreshToken) {
      log?.('token', 'Exchanging refresh_token for LiveProfileCard.Access…');
      const exchanged = await exchangeLiveProfileToken(page, refreshToken);
      if (isLiveProfileCardToken(exchanged)) {
        listener.wait(1).catch(() => {});
        return exchanged;
      }
      const errMsg = formatTokenExchangeError(exchanged);
      log?.('token', `Exchange failed: ${errMsg}`);
      if (isInvalidGrant(exchanged)) {
        log?.('token', 'Refresh token rejected — use Re-login.');
        listener.wait(1).catch(() => {});
        return null;
      }
      if (isSpaOriginError(exchanged)) {
        log?.('token', 'SPA token endpoint — capturing from Outlook network instead…');
      }
    } else {
      log?.('token', 'No refresh_token yet — waiting for Outlook MSAL token request…');
    }

    log?.('token', 'Reloading Outlook to trigger token request…');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    await page.waitForTimeout(6000);

    let tokens = await listener.wait(50_000);

    if (!isLiveProfileCardToken(tokens)) {
      log?.('token', 'Checking MSAL cache…');
      tokens = await readMsalLiveProfileToken(page);
    }

    if (!isLiveProfileCardToken(tokens)) {
      await page.waitForTimeout(5000);
      tokens = (await listener.wait(20_000)) || (await readMsalLiveProfileToken(page));
    }

    if (!isLiveProfileCardToken(tokens) && refreshToken) {
      log?.('token', 'Retrying refresh_token exchange (in-browser)…');
      tokens = await exchangeLiveProfileToken(page, refreshToken);
    }

    if (!isLiveProfileCardToken(tokens) && context && !isProxyEnabled()) {
      log?.('token', 'Trying Chromium fallback (proxy off only)…');
      tokens = await captureViaChromium(context, log, refreshToken);
    }

    listener.wait(1).catch(() => {});
    return isLiveProfileCardToken(tokens) ? tokens : null;
  };

  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Token capture timed out after 100s')), CAPTURE_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    log?.('token', err.message);
    return null;
  }
}

/** POST to consumers/oauth2/v2.0/token — must run inside outlook.live.com (SPA Origin). */
export async function exchangeLiveProfileToken(page, refreshToken) {
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

  await ensureOutlookMailPage(page);

  try {
    const json = await page.evaluate(
      async ({ tokenUrl, body }) => {
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
      },
      { tokenUrl: LIVEPROFILE.tokenUrl, body }
    );
    if (isLiveProfileCardToken(json)) {
      return normalizeTokenPayload(json, 'refresh_exchange');
    }
    if (json?.error) return json;
  } catch (err) {
    return { error: 'page_fetch_failed', error_description: err.message };
  }

  return { error: 'unknown', error_description: 'Token exchange returned no access token' };
}

async function ensureOutlookMailPage(page, log) {
  if (!/outlook\.live\.com\/mail/i.test(page.url())) {
    log?.('token', 'Loading Outlook mail…');
    await page.goto(OUTLOOK_MAIL, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
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
    const exchanged = await exchangeLiveProfileToken(page2, refreshToken);
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

async function readMsalRefreshToken(page) {
  try {
    return await page.evaluate((clientId) => {
      const want = clientId.toLowerCase();
      const found = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.toLowerCase().includes(want) || !/refreshtoken/i.test(key)) continue;
        try {
          const raw = JSON.parse(localStorage.getItem(key));
          const secret = raw?.secret || raw?.refreshToken;
          if (secret) found.push({ key, secret });
        } catch {
          // skip
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
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.toLowerCase().includes(want) || !/accesstoken/i.test(key)) continue;
        try {
          const raw = JSON.parse(localStorage.getItem(key));
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
