/**
 * Sign up a Microsoft account on Truecaller via official Microsoft SSO.
 *
 * Isolation rules:
 * - Copy SSO cookies from the Outlook profile JSON (read-only).
 * - Isolated Camoufox + Truecaller-only proxy.
 * - Never saveProfile / never write Outlook cookies back.
 * - If Microsoft asks for a password, MFA, or account-security changes → abort immediately.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { SIGNIN_URL, MICROSOFT_CALLBACK_PATH, TRUECALLER_SHOT_DIR } from './config.js';
import { launchTruecallerBrowser } from './browser.js';
import { readOutlookSso, ssoCookieSummary, extractSsoCookies } from './cookies.js';
import { getProxyUrl, upsertAccount, getAccount } from './store.js';

const DANGER_BODY_RE =
  /enter (your )?password|wrong password|incorrect password|verification code|enter the code|approve.*(sign-?in|request)|authenticator|more information is required|help us protect your account|unusual (sign-?in|activity)|verify your identity|confirm your identity|we don'?t recognize|let'?s keep your account|add a phone|add.*(security|backup) email|password sign-in isn'?t available/i;

const CONSENT_RE = /truecaller|let this app|permissions requested|wants to access|review permissions|accept|allow/i;
const KMSI_RE = /stay signed in|keep me signed in|هل تريد البقاء/i;
const PICK_ACCOUNT_RE = /pick an account|choose an account|select.*(account|user)|اختر حساب/i;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function decodeJwt(jwt) {
  try {
    const part = String(jwt).split('.')[1];
    if (!part) return null;
    const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (part.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function parseTcUserCookie(value) {
  if (!value) return null;
  let raw = String(value);
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // already decoded
  }
  try {
    const obj = JSON.parse(raw);
    const jwt = obj.token || obj.accessToken || raw;
    const payload = decodeJwt(jwt) || obj;
    return {
      tcUserCookie: raw,
      jwt: typeof jwt === 'string' && jwt.includes('.') ? jwt : null,
      innerToken: payload?.token || null,
      name: payload?.name || obj.name || null,
      email: payload?.email || obj.email || null,
      countryCode: payload?.countryCode || payload?.country_code || null,
      image: payload?.image || null,
      enhancedSearch: !!payload?.enhancedSearch,
      expiresAt: payload?.exp || null,
      payload,
    };
  } catch {
    const jwt = raw;
    const payload = decodeJwt(jwt);
    if (!payload) return null;
    return {
      tcUserCookie: raw,
      jwt,
      innerToken: payload.token || null,
      name: payload.name || null,
      email: payload.email || null,
      countryCode: payload.countryCode || null,
      image: payload.image || null,
      enhancedSearch: !!payload.enhancedSearch,
      expiresAt: payload.exp || null,
      payload,
    };
  }
}

async function readTcSession(context) {
  const cookies = await context.cookies('https://www.truecaller.com').catch(() => []);
  const tcUser = cookies.find((c) => c.name === 'tc_user');
  const parsed = parseTcUserCookie(tcUser?.value);
  const keep = cookies.filter((c) => /^tc/i.test(c.name) || c.name === 'tc_user');
  return { parsed, cookies: keep };
}

async function snapshot(page) {
  return page
    .evaluate(() => {
      const body = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 900);
      const buttons = [...document.querySelectorAll('button, a, [role="button"], input[type="submit"]')]
        .map((el) => (el.textContent || el.value || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 25);
      const password = [...document.querySelectorAll('#passwordEntry, #i0118, input[name="passwd"], input[type="password"]')].some(
        (el) => {
          const st = getComputedStyle(el);
          if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
          if (el.disabled || el.getAttribute('aria-hidden') === 'true') return false;
          const r = el.getBoundingClientRect();
          return r.width > 8 && r.height > 8;
        }
      );
      const emailInput = [...document.querySelectorAll('#usernameEntry, #i0116, input[name="loginfmt"], input[type="email"]')].some(
        (el) => {
          const st = getComputedStyle(el);
          if (st.display === 'none' || st.visibility === 'hidden') return false;
          const r = el.getBoundingClientRect();
          return r.width > 8 && r.height > 8;
        }
      );
      return { url: location.href, title: document.title || '', body, buttons, password, emailInput };
    })
    .catch(() => ({
      url: page.url(),
      title: '',
      body: '',
      buttons: [],
      password: false,
      emailInput: false,
    }));
}

async function screenshot(page, jobId, label) {
  try {
    await fs.mkdir(TRUECALLER_SHOT_DIR, { recursive: true });
    const file = path.join(TRUECALLER_SHOT_DIR, `${jobId}-${label}.png`);
    await page.screenshot({ path: file, fullPage: true }).catch(() => {});
    return file;
  } catch {
    return null;
  }
}

async function dismissBanners(page) {
  await page
    .evaluate(() => {
      const re = /accept( all)?|agree|allow all|i agree|got it|ok,?\s*got it|accept cookies/i;
      const els = [...document.querySelectorAll('button, a, [role="button"]')];
      for (const el of els) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (re.test(t) && t.length < 40) {
          el.click();
          return t;
        }
      }
      return null;
    })
    .catch(() => null);
}

async function clickMicrosoft(page) {
  const viaDom = await page
    .evaluate(() => {
      const els = [...document.querySelectorAll('button, a, [role="button"], div[role="button"]')];
      const el = els.find((e) => {
        const t = (e.textContent || e.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        return /microsoft/i.test(t) && !/linkedin|windows store/i.test(t);
      });
      if (!el) return null;
      el.click();
      return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    })
    .catch(() => null);
  if (viaDom) return viaDom;

  const loc = page.getByText(/microsoft/i).first();
  if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
    await loc.click({ timeout: 4000 }).catch(() => {});
    return 'locator-microsoft';
  }
  return null;
}

async function clickMatchingAccount(page, email) {
  const local = String(email).toLowerCase();
  return page
    .evaluate((want) => {
      const nodes = [...document.querySelectorAll('[data-test-id], [role="button"], [role="link"], div, span, small')];
      const hit = nodes.find((el) => (el.textContent || '').toLowerCase().includes(want) && el.childElementCount < 8);
      if (!hit) return false;
      const clickable = hit.closest('[role="button"], [role="link"], button, a, div') || hit;
      clickable.click();
      return true;
    }, local)
    .catch(() => false);
}

async function clickPrimaryByText(page, re) {
  return page
    .evaluate((source) => {
      const want = new RegExp(source, 'i');
      const els = [...document.querySelectorAll('button, input[type="submit"], [role="button"], a')];
      for (const el of els) {
        const t = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
        if (want.test(t) && t.length < 48) {
          el.click();
          return t;
        }
      }
      const idBtn = document.querySelector('#idSIButton9');
      if (idBtn) {
        idBtn.click();
        return idBtn.value || idBtn.textContent || '#idSIButton9';
      }
      const primary = document.querySelector('button[data-testid="primaryButton"], button[type="submit"]');
      if (primary) {
        primary.click();
        return (primary.textContent || '').trim() || 'primary';
      }
      return null;
    }, re.source)
    .catch(() => null);
}

async function fillVisibleInput(page, selectors, value) {
  return page
    .evaluate(
      ({ selectors, value }) => {
        for (const sel of selectors) {
          for (const el of document.querySelectorAll(sel)) {
            if (el.type === 'hidden' || el.disabled) continue;
            const st = getComputedStyle(el);
            if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue;
            const r = el.getBoundingClientRect();
            if (r.width < 8 || r.height < 8) continue;
            el.focus();
            el.value = '';
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      },
      { selectors, value }
    )
    .catch(() => false);
}

async function clickUsePasswordInstead(page) {
  return page
    .evaluate(() => {
      const re = /use (your )?password|password instead|sign in with (?:a )?password|use my password|استخدام كلمة المرور/i;
      const els = [...document.querySelectorAll('a, button, [role="button"], #idA_PWD_SwitchToPassword')];
      for (const el of els) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (re.test(t)) {
          el.click();
          return t;
        }
      }
      return null;
    })
    .catch(() => null);
}

async function submitMicrosoftNext(page) {
  const clicked = await clickPrimaryByText(page, /^(next|sign in|continue|التالي|دخول)$/i);
  if (clicked) return clicked;
  await page.keyboard.press('Enter').catch(() => {});
  return 'enter';
}

async function handleMicrosoftLogin(page, email, password, log) {
  const switched = await clickUsePasswordInstead(page);
  if (switched) {
    log('auth', `Switch to password: ${switched}`);
    await sleep(1200);
  }

  const snap = await snapshot(page);
  if (snap.emailInput) {
    const filled = await fillVisibleInput(
      page,
      ['#usernameEntry', '#i0116', 'input[type="email"]:not([type="hidden"])', 'input[name="loginfmt"]:not([type="hidden"])'],
      email
    );
    if (filled) log('auth', 'Filled Microsoft email (isolated browser only)');
    await sleep(400);
    await submitMicrosoftNext(page);
    await sleep(1800);
  }

  const snap2 = await snapshot(page);
  if (snap2.password || snap.password) {
    await clickUsePasswordInstead(page);
    await sleep(600);
    const filledPwd = await fillVisibleInput(
      page,
      ['#passwordEntry', '#i0118', 'input[name="passwd"]', 'input[type="password"]'],
      password
    );
    if (!filledPwd) return false;
    log('auth', 'Filled Microsoft password (isolated browser — Outlook profile not saved)');
    await sleep(400);
    await submitMicrosoftNext(page);
    await sleep(2200);
    return true;
  }
  return false;
}

async function clickSkipIfSafe(page) {
  return page
    .evaluate(() => {
      const re = /skip for now|skip this|not now|i.?ll do this later|remind me later|^skip$|تخطي/i;
      const els = [...document.querySelectorAll('button, a, [role="button"], #iShowSkip')];
      for (const el of els) {
        const t = (el.textContent || el.value || '').replace(/\s+/g, ' ').trim();
        if (re.test(t) && t.length < 40) {
          el.click();
          return t;
        }
      }
      return null;
    })
    .catch(() => null);
}

function isMicrosoftHost(url = '') {
  return /login\.live\.com|login\.microsoftonline\.com|login\.microsoft\.com|account\.live\.com|account\.microsoft\.com/i.test(
    url
  );
}

function isTruecallerHost(url = '') {
  return /truecaller\.com/i.test(url);
}

function abortReasonFromSnap(snap, { allowPassword = false } = {}) {
  if (snap.password && !allowPassword) {
    return 'Microsoft asked for a password — aborted so the Outlook session is not touched.';
  }
  if (DANGER_BODY_RE.test(snap.body) && isMicrosoftHost(snap.url)) {
    if (/help us protect|add a phone|add.*(security|backup) email|more information is required/i.test(snap.body)) {
      return 'Microsoft showed an account-security prompt — aborted (will not change the account).';
    }
    if (/verification code|authenticator|approve.*(sign-?in|request)/i.test(snap.body)) {
      return 'Microsoft asked for MFA/code — aborted.';
    }
    if (/unusual|don'?t recognize|verify your identity/i.test(snap.body)) {
      return 'Microsoft risk check — aborted so the account is not challenged further.';
    }
  }
  return null;
}

export async function signupMicrosoftAccount(email, { log = () => {}, jobId = 'manual', password = '' } = {}) {
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) {
    throw new Error('Set the Truecaller residential proxy first. This tab never uses the Outlook/mobile proxy.');
  }

  const allowPassword = !!String(password || '').trim();
  log('sso', 'Reading Truecaller-owned Microsoft cookies first (never Outlook writes)…');

  let cookies = [];
  let fingerprint = null;
  let source = 'none';

  const existingTc = getAccount(email);
  if (existingTc?.ms_cookies_json) {
    try {
      const parsed = JSON.parse(existingTc.ms_cookies_json);
      const extracted = extractSsoCookies(parsed);
      if (extracted.cookies.length >= 2) {
        cookies = extracted.cookies;
        source = 'truecaller-ms-session';
        log('sso', `Reusing ${extracted.cookies.length} Microsoft cookies saved under data/truecaller/ (Outlook untouched).`);
      }
    } catch {
      // ignore bad json
    }
  }

  const sso = await readOutlookSso(email);
  if (!cookies.length && sso.ok) {
    cookies = sso.cookies;
    fingerprint = sso.fingerprint;
    source = 'outlook-copy-readonly';
    const summary = ssoCookieSummary(sso.names);
    log(
      'sso',
      `Copied ${summary.count} Outlook SSO cookies read-only (ESTSAUTH=${summary.estsauth} persistent=${summary.estsauthPersistent} MSPAuth=${summary.mspAuth}). Outlook profile not opened.`
    );
  } else if (!cookies.length && !allowPassword) {
    const err = new Error(
      sso.reason === 'no_outlook_profile'
        ? 'No saved Outlook profile for this email. Login on the main tab first — Truecaller will not password-login.'
        : 'Outlook session cookies are missing/expired. Refresh/login on the main app first. Truecaller will not type the password.'
    );
    err.code = sso.reason;
    throw err;
  } else if (!cookies.length && allowPassword) {
    log('sso', 'No saved Microsoft cookies — isolated password sign-in (Outlook profile will not be written).');
  }

  upsertAccount(email, { status: 'signing_up', last_error: null });

  const session = await launchTruecallerBrowser({
    email,
    cookies,
    fingerprint: fingerprint || sso.fingerprint,
    proxyUrl,
  });
  const { page, context } = session;
  log('browser', `Isolated Camoufox via ${session.proxyLabel} (not the Outlook proxy)`);
  log(
    'sso',
    `Browser accepted ${session.cookiesAccepted} cookies` +
      (session.cookiesDropped?.length ? ` (dropped ${session.cookiesDropped.slice(0, 8).join(', ')})` : '')
  );

  let activePage = page;
  context.on('page', (p) => {
    activePage = p;
    log('nav', `popup opened`);
    p.on('close', () => {
      if (activePage === p) activePage = page;
    });
  });

  const captured = { parsed: null, apiTokens: [] };
  page.on('response', async (res) => {
    try {
      const url = res.url();
      if (!/truecaller|cloudfunctions|webapi/i.test(url)) return;
      const ct = String(res.headers()['content-type'] || '');
      if (!/json/i.test(ct)) return;
      const json = await res.json().catch(() => null);
      if (!json || typeof json !== 'object') return;
      const token = json.token || json.accessToken || json.access_token || json.jwt;
      if (token) captured.apiTokens.push({ url: url.slice(0, 160), token: String(token).slice(0, 80) });
    } catch {
      // ignore
    }
  });

  try {
    log('nav', `Open ${SIGNIN_URL}`);
    await page.goto(SIGNIN_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await sleep(2500);
    await dismissBanners(page);
    await page
      .waitForFunction(() => /microsoft/i.test(document.body?.innerText || ''), { timeout: 30_000 })
      .catch(() => {});
    await dismissBanners(page);
    await sleep(800);

    let snap = await snapshot(activePage);
    log('page', `${snap.url} — ${snap.buttons.slice(0, 8).join(' | ') || snap.body.slice(0, 120)}`);

    const already = await readTcSession(context);
    if (already.parsed?.jwt) {
      log('token', 'Already had a Truecaller session cookie');
      return await persistSuccess(email, already, jobId, page, log, context);
    }

    log('click', 'Click Sign in with Microsoft');
    const clicked = await clickMicrosoft(page);
    if (!clicked) {
      await screenshot(page, jobId, 'no-microsoft-btn');
      throw new Error('Could not find the Microsoft button on Truecaller sign-in. Page may have changed.');
    }
    log('click', `Clicked: ${clicked}`);
    await Promise.race([
      page.waitForURL(/login\.live\.com|login\.microsoftonline\.com|microsoft\/callback/i, { timeout: 20_000 }),
      context.waitForEvent('page', { timeout: 20_000 }),
    ]).catch(() => {});
    await sleep(1500);

    const deadline = Date.now() + (allowPassword ? 150_000 : 90_000);
    const clickedAt = Date.now();
    let lastUrl = '';
    let retriedClick = false;
    let passwordUsed = false;
    while (Date.now() < deadline) {
      const view = activePage.isClosed?.() ? page : activePage;
      snap = await snapshot(view);
      if (snap.url !== lastUrl) {
        lastUrl = snap.url;
        log('nav', snap.url.slice(0, 180));
      }

      const sessionNow = await readTcSession(context);
      if (sessionNow.parsed?.jwt && !isMicrosoftHost(snap.url)) {
        log('token', 'Captured tc_user cookie');
        return await persistSuccess(email, sessionNow, jobId, page, log, context);
      }

      if (allowPassword && isMicrosoftHost(snap.url) && (snap.password || snap.emailInput) && !passwordUsed) {
        try {
          const did = await handleMicrosoftLogin(view, email, password, log);
          if (did) passwordUsed = true;
        } catch (err) {
          log('auth', `Microsoft fill skipped: ${err.message}`.slice(0, 180));
        }
        await sleep(1500);
        continue;
      }

      const danger = abortReasonFromSnap(snap, { allowPassword });
      if (danger) {
        log('page', snap.body.slice(0, 240));
        await screenshot(view, jobId, 'aborted');
        throw new Error(danger);
      }

      if (isMicrosoftHost(snap.url) || PICK_ACCOUNT_RE.test(snap.body) || KMSI_RE.test(snap.body) || CONSENT_RE.test(snap.body)) {
        if (PICK_ACCOUNT_RE.test(snap.body) || /accounts\.login|login\.live\.com\/oauth20/i.test(snap.url)) {
          const picked = await clickMatchingAccount(view, email);
          if (picked) {
            log('sso', 'Picked matching Microsoft account tile');
            await sleep(1500);
            continue;
          }
        }

        if (KMSI_RE.test(snap.body)) {
          const kmsi = await clickPrimaryByText(view, /^(yes|نعم|oui|ok)$/i);
          log('sso', `Stay signed in (isolated context only): ${kmsi || 'clicked primary'}`);
          await sleep(1600);
          continue;
        }

        if (/interrupt|proofup|reminders/i.test(snap.url)) {
          const skipped = await clickSkipIfSafe(view);
          if (skipped) {
            log('sso', `Skipped Microsoft interrupt: ${skipped}`);
            await sleep(1500);
            continue;
          }
          await screenshot(view, jobId, 'interrupt');
          throw new Error('Microsoft account interrupt with no Skip — aborted so the Outlook account is not changed.');
        }

        if (CONSENT_RE.test(snap.body) && isMicrosoftHost(snap.url)) {
          const accept = await clickPrimaryByText(view, /^(yes|accept|allow|continue|نعم|قبول)$/i);
          log('sso', `Truecaller Microsoft consent: ${accept || 'primary'}`);
          await sleep(1800);
          continue;
        }

        if (isMicrosoftHost(snap.url) && /oauth20_authorize|consent/i.test(snap.url)) {
          const accept = await clickPrimaryByText(view, /^(yes|accept|allow|continue|نعم)$/i);
          if (accept) {
            log('sso', `OAuth continue: ${accept}`);
            await sleep(1800);
            continue;
          }
        }
      }

      if (
        !retriedClick &&
        Date.now() - clickedAt > 8000 &&
        isTruecallerHost(snap.url) &&
        /sign-in/i.test(snap.url)
      ) {
        retriedClick = true;
        log('click', 'Still on sign-in — retry Microsoft button');
        await clickMicrosoft(view);
        await sleep(2000);
        continue;
      }

      await sleep(1200);
    }

    const finalSess = await readTcSession(context);
    if (finalSess.parsed?.jwt) {
      return await persistSuccess(email, finalSess, jobId, page, log, context);
    }

    await screenshot(page, jobId, 'timeout');
    snap = await snapshot(page);
    throw new Error(`Timed out on ${snap.url}. ${snap.body.slice(0, 180)}`);
  } finally {
    await session.close().catch(() => {});
    log('browser', 'Isolated browser closed — Outlook profile was not written.');
  }
}

async function persistSuccess(email, sessionNow, jobId, page, log, context) {
  const p = sessionNow.parsed;
  let msCookies = [];
  let tcCookies = sessionNow.cookies || [];
  if (context?.cookies) {
    const all = await context.cookies().catch(() => []);
    msCookies = extractSsoCookies(all).cookies;
    const fromCtx = all.filter(
      (c) => /truecaller\.com/i.test(String(c.domain || '')) || /^tc/i.test(c.name)
    );
    if (fromCtx.length) tcCookies = fromCtx;
  }
  const now = new Date().toISOString();
  const row = upsertAccount(email, {
    status: 'signed_up',
    tc_jwt: p.jwt,
    tc_token: p.innerToken,
    tc_user_cookie: p.tcUserCookie,
    name: p.name,
    tc_email: p.email,
    country_code: p.countryCode,
    image: p.image,
    enhanced_search: p.enhancedSearch,
    expires_at: p.expiresAt,
    cookies_json: JSON.stringify(tcCookies),
    ms_cookies_json: msCookies.length ? JSON.stringify(msCookies) : null,
    last_error: null,
    last_signup_at: now,
    last_refresh_at: now,
  });
  await screenshot(page, jobId, 'success');
  log(
    'done',
    `Truecaller token saved (expires ${p.expiresAt || 'unknown'}). Isolated Microsoft cookies: ${msCookies.length}. Outlook was not written.`
  );
  return {
    email,
    jwt: p.jwt,
    innerToken: p.innerToken,
    name: p.name,
    tcEmail: p.email,
    countryCode: p.countryCode,
    expiresAt: p.expiresAt,
    row,
  };
}
