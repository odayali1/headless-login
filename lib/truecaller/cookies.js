/**
 * Read-only copy of Microsoft SSO cookies from an Outlook profile JSON.
 * Never writes the profile file. Skips Outlook/Teams product cookies.
 */
import fs from 'node:fs/promises';
import { profilePath } from '../profile.js';
import { hasValidSession } from '../profile-session.js';

const BLOCKED_HOST_RE = /outlook\.|office\.|teams\.|skype\.|sharepoint\.|onedrive\./i;
const STRONG_NAMES = new Set([
  'ESTSAUTH',
  'ESTSAUTHPERSISTENT',
  'MSPAuth',
  '__Host-MSAAUTH',
  '__Host-MSAAUTHP',
]);

function hostFromUrl(url = '') {
  try {
    return new URL(url).hostname.replace(/^\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function isSsoHost(domain = '') {
  const d = String(domain).replace(/^\./, '').toLowerCase();
  if (!d || BLOCKED_HOST_RE.test(d)) return false;
  return (
    d === 'live.com' ||
    d === 'login.live.com' ||
    d.endsWith('.login.live.com') ||
    d === 'login.microsoftonline.com' ||
    d.endsWith('.login.microsoftonline.com') ||
    d === 'login.microsoft.com' ||
    d === 'account.live.com' ||
    d === 'account.microsoft.com' ||
    d === 'microsoftonline.com' ||
    d === 'consent.microsoft.com' ||
    d === 'login.windows.net' ||
    d.endsWith('.login.windows.net')
  );
}

function normalizeSameSite(value) {
  const s = String(value || 'Lax').toLowerCase();
  if (s === 'none') return 'None';
  if (s === 'strict') return 'Strict';
  return 'Lax';
}

function isDisabledAuthValue(value) {
  return /^(disabled)?$/i.test(String(value || '').trim());
}

export function extractSsoCookies(cookies = []) {
  const out = [];
  const names = new Set();
  for (const c of cookies) {
    if (!c?.name || c.value == null || c.value === '') continue;
    const host = String(c.domain || '').replace(/^\./, '') || hostFromUrl(c.url);
    if (!isSsoHost(host)) continue;
    out.push({
      name: c.name,
      value: String(c.value),
      domain: c.domain || undefined,
      url: c.url || undefined,
      path: c.path || '/',
      expires: typeof c.expires === 'number' ? c.expires : -1,
      httpOnly: !!c.httpOnly,
      secure: c.secure !== false,
      sameSite: normalizeSameSite(c.sameSite),
    });
    names.add(c.name);
  }
  return { cookies: out, names };
}

export function ssoCookieSummary(names, cookies = []) {
  const set = names instanceof Set ? names : new Set(names || []);
  const byName = new Map((cookies || []).map((c) => [c.name, c]));
  const msp = byName.get('MSPAuth');
  return {
    estsauth: set.has('ESTSAUTH'),
    estsauthPersistent: set.has('ESTSAUTHPERSISTENT'),
    mspAuth: set.has('MSPAuth'),
    mspAuthDisabled: !!msp && isDisabledAuthValue(msp.value),
    hostMsa: set.has('__Host-MSAAUTH') || set.has('__Host-MSAAUTHP'),
    count: set.size,
    strong: [...STRONG_NAMES].filter((n) => set.has(n)),
  };
}

/**
 * Playwright Firefox is more reliable with storageState (same as Outlook Camoufox)
 * than addCookies after an empty context. Also pin strong tickets on login.live.com.
 */
export function toPlaywrightCookies(cookies = []) {
  const now = Date.now() / 1000;
  const dropped = [];
  const keyed = new Map();

  function add(cookie) {
    const key = `${cookie.name}|${cookie.domain || cookie.url || ''}|${cookie.path || '/'}`;
    keyed.set(key, cookie);
  }

  for (const c of cookies) {
    if (!c?.name || c.value == null || c.value === '') {
      dropped.push(`${c?.name || '?'}:empty`);
      continue;
    }
    if (typeof c.expires === 'number' && c.expires > 0 && c.expires < now) {
      dropped.push(`${c.name}:expired`);
      continue;
    }
    const base = {
      name: c.name,
      value: String(c.value),
      path: c.path || '/',
      expires: typeof c.expires === 'number' ? c.expires : -1,
      httpOnly: !!c.httpOnly,
      secure: c.secure !== false,
      sameSite: normalizeSameSite(c.sameSite),
    };
    if (c.name.startsWith('__Host-')) {
      add({
        ...base,
        url: 'https://login.live.com/',
        path: '/',
        secure: true,
      });
      continue;
    }
    if (c.domain) {
      add({ ...base, domain: c.domain });
    } else {
      add({ ...base, url: c.url || 'https://login.live.com/' });
    }
    if (STRONG_NAMES.has(c.name) && !c.name.startsWith('__Host-')) {
      add({ ...base, url: 'https://login.live.com/' });
    }
  }

  return { cookies: [...keyed.values()], dropped };
}

/**
 * Load Outlook profile JSON for cookie copy only. Never calls saveProfile / loadProfile
 * (loadProfile can merge-write legacy files).
 */
export async function readOutlookSso(email) {
  let data = null;
  try {
    data = JSON.parse(await fs.readFile(profilePath(email), 'utf8'));
  } catch {
    data = null;
  }
  if (!data) {
    return { ok: false, reason: 'no_outlook_profile', saved: null, cookies: [], names: new Set() };
  }
  const sessionOk = hasValidSession(data);
  const { cookies, names } = extractSsoCookies(data.cookies || []);
  const summary = ssoCookieSummary(names, cookies);
  if (!sessionOk || cookies.length < 2) {
    return {
      ok: false,
      reason: 'no_microsoft_sso_cookies',
      saved: data,
      cookies,
      names,
      summary,
      sessionOk,
    };
  }
  return {
    ok: true,
    saved: data,
    cookies,
    names,
    summary,
    sessionOk,
    fingerprint: data.fingerprint || null,
  };
}
