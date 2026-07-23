import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLiveProfileCardToken, isTokenValid } from './token-extract.js';
import { hasValidSession } from './profile-session.js';
import { isReauthRequired } from './account-health.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const PROFILES_DIR = process.env.PROFILES_DIR || path.join(DATA_DIR, 'profiles');

/** One account per email in API/UI — consumer LiveProfileCard tokens always use this target. */
export const CANONICAL_TARGET = 'outlook';

export function profilePath(email, _target = CANONICAL_TARGET) {
  return path.join(PROFILES_DIR, `${sanitize(email)}-${CANONICAL_TARGET}.json`);
}

export function legacyProfilePath(email, target) {
  return path.join(PROFILES_DIR, `${sanitize(email)}-${target}.json`);
}

async function readProfileFile(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const data = JSON.parse(raw);
    if (data.cookies?.length || data.origins?.length) return data;
    if (data.tokens || data.lastLoginAt || data.lastStatus) return data;
    return null;
  } catch {
    return null;
  }
}

function profileScore(data) {
  if (!data) return 0;
  const sessionValid = hasValidSession(data);
  const tokenValid = isTokenValid(data.tokens);
  const hasLive = isLiveProfileCardToken(data.tokens);
  if (tokenValid && hasLive) return 100;
  if (hasLive) return 80;
  if (sessionValid) return 50;
  if (data.lastStatus === 'success') return 40;
  if (data.lastStatus === 'failed') return 10;
  return 20;
}

function mergeProfileData(entries) {
  const sorted = [...entries].sort((a, b) => profileScore(b.data) - profileScore(a.data));
  const best = { ...sorted[0].data };
  for (const { data } of sorted.slice(1)) {
    if (!isTokenValid(best.tokens) && isLiveProfileCardToken(data.tokens)) {
      best.tokens = data.tokens;
    }
    if (!hasValidSession(best) && hasValidSession(data)) {
      best.cookies = data.cookies;
      best.origins = data.origins;
    }
    if (!best.fingerprint && data.fingerprint) best.fingerprint = data.fingerprint;
    if (!best.softbanCheck && data.softbanCheck) best.softbanCheck = data.softbanCheck;
    const bestLogin = best.lastLoginAt ? new Date(best.lastLoginAt).getTime() : 0;
    const candLogin = data.lastLoginAt ? new Date(data.lastLoginAt).getTime() : 0;
    if (candLogin > bestLogin) {
      best.lastLoginAt = data.lastLoginAt;
      best.lastStatus = data.lastStatus;
      best.lastError = data.lastError;
    }
  }
  best.email = best.email || sorted[0].data.email;
  best.target = CANONICAL_TARGET;
  best.loginVia = best.loginVia || sorted.find((e) => e.data.loginVia)?.data.loginVia || 'outlook';
  return best;
}

let consolidateDone = false;
let consolidateInFlight = null;

/** Merge duplicate outlook/teams JSON files into one canonical profile per email.
 *  Runs at most once per process — previously ran on every listAccounts (~2× disk scan). */
export async function consolidateLegacyProfiles() {
  if (consolidateDone) return 0;
  if (consolidateInFlight) return consolidateInFlight;

  consolidateInFlight = (async () => {
    await fs.mkdir(PROFILES_DIR, { recursive: true });
    const files = (await fs.readdir(PROFILES_DIR)).filter((f) => f.endsWith('.json'));
    const byEmail = new Map();

    for (const file of files) {
      const full = path.join(PROFILES_DIR, file);
      let data;
      try {
        data = JSON.parse(await fs.readFile(full, 'utf8'));
      } catch {
        continue;
      }
      if (!data?.email) continue;
      const list = byEmail.get(data.email) || [];
      list.push({ file: full, data });
      byEmail.set(data.email, list);
    }

    let merged = 0;
    for (const [email, entries] of byEmail) {
      const canonical = profilePath(email);
      if (entries.length === 1 && entries[0].file === canonical) continue;

      const payload = mergeProfileData(entries);
      await fs.writeFile(canonical, JSON.stringify(payload, null, 2));

      for (const { file } of entries) {
        if (file !== canonical) {
          await fs.unlink(file).catch(() => {});
        }
      }
      merged += 1;
    }
    if (merged > 0) {
      console.log(`[migrate] Consolidated ${merged} duplicate profile(s) → one per email (${CANONICAL_TARGET})`);
    }
    consolidateDone = true;
    return merged;
  })().finally(() => {
    consolidateInFlight = null;
  });

  return consolidateInFlight;
}

export async function loadProfile(email, _target = CANONICAL_TARGET) {
  await fs.mkdir(PROFILES_DIR, { recursive: true });
  const canonical = profilePath(email);
  let data = await readProfileFile(canonical);
  if (data) return { file: canonical, state: data };

  const legacyTargets = ['teams', 'outlook'];
  const legacyEntries = [];
  for (const t of legacyTargets) {
    const file = legacyProfilePath(email, t);
    if (file === canonical) continue;
    const legacy = await readProfileFile(file);
    if (legacy) legacyEntries.push({ file, data: legacy });
  }

  if (legacyEntries.length === 0) return null;

  const merged = mergeProfileData(legacyEntries);
  await fs.writeFile(canonical, JSON.stringify(merged, null, 2));
  for (const { file } of legacyEntries) {
    await fs.unlink(file).catch(() => {});
  }
  return { file: canonical, state: merged };
}

/**
 * Saves full browser state to the canonical profile (one file per email).
 */
export async function saveProfile(context, email, extra = {}) {
  await fs.mkdir(PROFILES_DIR, { recursive: true });
  const file = profilePath(email);

  let existing = {};
  try {
    existing = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    // new profile
  }

  const state = await context.storageState();
  const now = new Date().toISOString();
  const loginVia = extra.loginVia || extra.target || existing.loginVia || CANONICAL_TARGET;

  const payload = {
    email,
    target: CANONICAL_TARGET,
    loginVia,
    savedAt: now,
    lastLoginAt: extra.lastLoginAt || now,
    lastStatus: extra.lastStatus || 'success',
    staySignedIn: extra.staySignedIn ?? true,
    engine: extra.engine ?? existing.engine,
    fingerprint: extra.fingerprint ?? existing.fingerprint,
    mimicPhone:
      typeof extra.mimicPhone === 'boolean'
        ? extra.mimicPhone
        : !!(extra.fingerprint?.mimicPhone ?? existing.mimicPhone ?? existing.fingerprint?.mimicPhone),
    tokens: extra.tokens ?? existing.tokens,
    lastError: extra.lastError ?? null,
    lastTokenRefreshAt: extra.lastTokenRefreshAt ?? existing.lastTokenRefreshAt ?? null,
    backupEmailStatus: extra.backupEmailStatus ?? existing.backupEmailStatus ?? 'unknown',
    backupEmail: extra.backupEmail ?? existing.backupEmail ?? null,
    backupHubEmail: extra.backupHubEmail ?? existing.backupHubEmail ?? null,
    backupEmailSkippedAt: extra.backupEmailSkippedAt ?? existing.backupEmailSkippedAt ?? null,
    backupEmailVerifiedAt: extra.backupEmailVerifiedAt ?? existing.backupEmailVerifiedAt ?? null,
    backupEmailCheckedAt: extra.backupEmailCheckedAt ?? existing.backupEmailCheckedAt ?? null,
    backupPromptSeenAt: extra.backupPromptSeenAt ?? existing.backupPromptSeenAt ?? null,
    backupSkipLabel: extra.backupSkipLabel ?? existing.backupSkipLabel ?? null,
    softbanCheck: existing.softbanCheck ?? null,
    httpRefreshRejectedAt: extra.clearHttpRefreshRejected
      ? null
      : (extra.httpRefreshRejectedAt ?? existing.httpRefreshRejectedAt ?? null),
    jobId: extra.jobId,
    cookies: state.cookies,
    origins: state.origins || [],
  };

  if ('tokens' in extra) {
    payload.tokens = extra.tokens;
    // Fresh tokens from Camoufox mean HTTP redeem can be tried again.
    payload.httpRefreshRejectedAt = null;
  }

  await fs.writeFile(file, JSON.stringify(payload, null, 2));

  await fs.unlink(legacyProfilePath(email, 'teams')).catch(() => {});

  return file;
}

/** Update tokens without launching a browser (browserless refresh path). */
export async function saveProfileTokens(email, tokens, extra = {}) {
  await fs.mkdir(PROFILES_DIR, { recursive: true });
  const file = profilePath(email);

  let existing = {};
  try {
    existing = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    // new profile
  }

  const now = new Date().toISOString();
  const payload = {
    ...existing,
    email,
    target: CANONICAL_TARGET,
    savedAt: now,
    lastLoginAt: extra.lastLoginAt || existing.lastLoginAt || now,
    lastStatus: extra.lastStatus || 'success',
    lastError: extra.lastError ?? null,
    lastTokenRefreshAt: extra.lastTokenRefreshAt || now,
    engine: extra.engine ?? existing.engine,
    fingerprint: extra.fingerprint ?? existing.fingerprint,
    loginVia: extra.loginVia || existing.loginVia || CANONICAL_TARGET,
    tokens,
    jobId: extra.jobId,
    httpRefreshRejectedAt: extra.clearHttpRefreshRejected
      ? null
      : (extra.httpRefreshRejectedAt ?? existing.httpRefreshRejectedAt ?? null),
  };

  await fs.writeFile(file, JSON.stringify(payload, null, 2));
  return file;
}

const TRANSIENT_REFRESH_RE =
  /timed out|timeout|page\.goto|cannot reach microsoft|navigation failed|token capture|could not obtain a fresh liveprofilecard|network|proxy|econnreset|etimedout|enotfound|heap|msal still loading|browserless_failed|context_request_failed/i;

/** Remember that HTTP refresh_token exchange is dead for this profile — skip slow retries. */
export async function markHttpRefreshRejected(email) {
  const file = profilePath(email);
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    data.httpRefreshRejectedAt = new Date().toISOString();
    await fs.writeFile(file, JSON.stringify(data, null, 2));
  } catch {
    // profile missing — ignore
  }
}

/** Record a token-refresh failure without downgrading a still-valid session to "failed". */
export async function markProfileRefreshFailed(email, error) {
  const file = profilePath(email);
  const message = String(error);
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    data.lastError = message;
    data.lastRefreshErrorAt = new Date().toISOString();
    const sessionOk = hasValidSession(data);
    const hardFail = isReauthRequired(message) || !sessionOk;
    const transient = TRANSIENT_REFRESH_RE.test(message);
    if (hardFail) {
      data.lastStatus = 'failed';
      data.lastLoginAt = new Date().toISOString();
    } else if (!transient && data.lastStatus !== 'mfa_required') {
      data.lastStatus = 'failed';
      data.lastLoginAt = new Date().toISOString();
    }
    await fs.writeFile(file, JSON.stringify(data, null, 2));
  } catch {
    await fs.mkdir(PROFILES_DIR, { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        email,
        target: CANONICAL_TARGET,
        savedAt: new Date().toISOString(),
        lastRefreshErrorAt: new Date().toISOString(),
        lastStatus: 'failed',
        lastError: message,
        cookies: [],
        origins: [],
      }, null, 2)
    );
  }
}

export async function markProfileFailed(email, error) {
  const file = profilePath(email);
  const message = String(error);
  const transient = TRANSIENT_REFRESH_RE.test(message);
  const now = new Date().toISOString();
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    data.lastError = message;
    data.lastLoginAttemptAt = now;
    const sessionOk = hasValidSession(data);
    if (transient && sessionOk) {
      data.lastRefreshErrorAt = now;
    } else {
      data.lastStatus = 'failed';
      data.lastLoginAt = now;
    }
    await fs.writeFile(file, JSON.stringify(data, null, 2));
  } catch {
    await fs.mkdir(PROFILES_DIR, { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        email,
        target: CANONICAL_TARGET,
        savedAt: now,
        lastLoginAt: now,
        lastLoginAttemptAt: now,
        lastStatus: 'failed',
        lastError: String(error),
        cookies: [],
        origins: [],
      }, null, 2)
    );
  }
}

/** Mark that a login/re-login job started — used by oldest/idle account filters. */
export async function touchLoginAttempt(email) {
  const file = profilePath(email);
  const now = new Date().toISOString();
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    data.lastLoginAttemptAt = now;
    await fs.writeFile(file, JSON.stringify(data, null, 2));
  } catch {
    await fs.mkdir(PROFILES_DIR, { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        email,
        target: CANONICAL_TARGET,
        savedAt: now,
        lastLoginAttemptAt: now,
        lastStatus: 'unknown',
        cookies: [],
        origins: [],
      }, null, 2)
    );
  }
}

export async function deleteAllProfilesForEmail(email) {
  const paths = [
    profilePath(email),
    legacyProfilePath(email, 'teams'),
    legacyProfilePath(email, 'outlook'),
  ];
  for (const p of [...new Set(paths)]) {
    await fs.unlink(p).catch(() => {});
  }
}

function sanitize(s) {
  return s.replace(/[^a-zA-Z0-9@._-]/g, '_');
}

export { hasValidSession } from './profile-session.js';
