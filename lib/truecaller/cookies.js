/**
 * Read-only copy of Microsoft SSO cookies from an Outlook profile JSON.
 * Never writes the profile file. Skips Outlook/Teams product cookies.
 */
import fs from 'node:fs/promises';
import { profilePath } from '../profile.js';
import { hasValidSession } from '../profile-session.js';

const BLOCKED_HOST_RE = /outlook\.|office\.|teams\.|skype\.|sharepoint\.|onedrive\./i;

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
    d === 'microsoftonline.com'
  );
}

function normalizeSameSite(value) {
  const s = String(value || 'Lax').toLowerCase();
  if (s === 'none') return 'None';
  if (s === 'strict') return 'Strict';
  return 'Lax';
}

export function extractSsoCookies(cookies = []) {
  const out = [];
  const names = new Set();
  for (const c of cookies) {
    if (!c?.name || !c?.value) continue;
    if (!isSsoHost(c.domain)) continue;
    out.push({
      name: c.name,
      value: c.value,
      domain: c.domain,
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

export function ssoCookieSummary(names) {
  const set = names instanceof Set ? names : new Set(names || []);
  return {
    estsauth: set.has('ESTSAUTH'),
    estsauthPersistent: set.has('ESTSAUTHPERSISTENT'),
    mspAuth: set.has('MSPAuth'),
    hostMsa: set.has('__Host-MSAAUTH') || set.has('__Host-MSAAUTHP'),
    count: set.size,
  };
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
  if (!sessionOk || cookies.length < 2) {
    return {
      ok: false,
      reason: 'no_microsoft_sso_cookies',
      saved: data,
      cookies,
      names,
      sessionOk,
    };
  }
  return { ok: true, saved: data, cookies, names, sessionOk, fingerprint: data.fingerprint || null };
}
