import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const PROFILES_DIR = process.env.PROFILES_DIR || path.join(DATA_DIR, 'profiles');

export function profilePath(email, target) {
  return path.join(PROFILES_DIR, `${sanitize(email)}-${target}.json`);
}

export async function loadProfile(email, target) {
  const file = profilePath(email, target);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const data = JSON.parse(raw);
    if (data.cookies?.length || data.origins?.length) return { file, state: data };
    return null;
  } catch {
    return null;
  }
}

/**
 * Saves full browser state:
 * - cookies (session/auth)
 * - origins[].localStorage (MSAL token cache lives here)
 * - OAuth tokens (access_token, refresh_token, expiry)
 * - per-account fingerprint metadata
 */
export async function saveProfile(context, email, target, extra = {}) {
  await fs.mkdir(PROFILES_DIR, { recursive: true });
  const file = profilePath(email, target);

  let existing = {};
  try {
    existing = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    // new profile
  }

  const state = await context.storageState();
  const now = new Date().toISOString();

  const payload = {
    email,
    target,
    savedAt: now,
    lastLoginAt: extra.lastLoginAt || now,
    lastStatus: extra.lastStatus || 'success',
    staySignedIn: extra.staySignedIn ?? true,
    engine: extra.engine ?? existing.engine,
    fingerprint: extra.fingerprint ?? existing.fingerprint,
    tokens: extra.tokens ?? existing.tokens,
    lastError: extra.lastError ?? null,
    jobId: extra.jobId,
    cookies: state.cookies,
    origins: state.origins || [],
  };

  await fs.writeFile(file, JSON.stringify(payload, null, 2));
  return file;
}

export async function markProfileFailed(email, target, error) {
  const file = profilePath(email, target);
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    data.lastStatus = 'failed';
    data.lastError = String(error);
    data.lastLoginAt = new Date().toISOString();
    await fs.writeFile(file, JSON.stringify(data, null, 2));
  } catch {
    await fs.mkdir(PROFILES_DIR, { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        email,
        target,
        savedAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
        lastStatus: 'failed',
        lastError: String(error),
        cookies: [],
        origins: [],
      }, null, 2)
    );
  }
}

export function hasValidSession(state) {
  if (!state?.cookies?.length) return false;
  const names = new Set(state.cookies.map((c) => c.name));
  const authNames = [
    'ESTSAUTH', 'ESTSAUTHPERSISTENT', 'WLSSC', 'NAP', 'ANON',
    'MSPAuth', 'MSPProf', '__Host-MSAAUTH', 'ESTSAUTHLIGHT', 'JSHP', 'JSH',
  ];
  const hasAuth = authNames.some((n) => names.has(n));
  if (hasAuth) {
    const now = Date.now() / 1000;
    const sessionCookies = state.cookies.filter((c) => authNames.includes(c.name));
    if (sessionCookies.length === 0) return true;
    return sessionCookies.some((c) => !c.expires || c.expires === -1 || c.expires > now);
  }
  // Recent successful login with substantial cookie set (Obscura may omit ESTSAUTH in export)
  if (state.lastStatus === 'success' && state.lastLoginAt && state.cookies.length >= 5) {
    const age = Date.now() - new Date(state.lastLoginAt).getTime();
    if (age < 7 * 24 * 60 * 60 * 1000) {
      return state.cookies.some((c) => /live\.com|microsoftonline|outlook/i.test(c.domain));
    }
  }
  return false;
}

function sanitize(s) {
  return s.replace(/[^a-zA-Z0-9@._-]/g, '_');
}
