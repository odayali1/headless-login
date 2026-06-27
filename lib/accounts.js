import fs from 'node:fs/promises';
import path from 'node:path';
import { PROFILES_DIR, CANONICAL_TARGET, consolidateLegacyProfiles } from './profile.js';
import { hasValidSession } from './profile-session.js';
import { isTokenValid, isLiveProfileCardToken } from './token-extract.js';
import { listStoredAccounts, getAccountPasswordWithFallback } from './db.js';
import { deriveHealth, healthLabel, tokenExpiresInMs } from './account-health.js';

function accountRank(acc) {
  const order = {
    available: 100,
    needs_refresh: 80,
    session_only: 60,
    token_expired: 55,
    failed: 30,
    mfa_required: 20,
    softban: 15,
    not_logged_in: 5,
    unknown: 1,
  };
  return order[acc.health] || 10;
}

function pickCanonicalAccount(candidates) {
  return [...candidates].sort((a, b) => accountRank(b) - accountRank(a))[0];
}

export async function listAccounts() {
  await consolidateLegacyProfiles();
  await fs.mkdir(PROFILES_DIR, { recursive: true });
  const files = (await fs.readdir(PROFILES_DIR)).filter((f) => f.endsWith('.json'));
  const profileByEmail = new Map();

  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(PROFILES_DIR, file), 'utf8');
      const data = JSON.parse(raw);
      if (!data?.email) continue;
      const acc = formatAccount(data, file);
      const existing = profileByEmail.get(data.email);
      if (!existing) profileByEmail.set(data.email, acc);
      else profileByEmail.set(data.email, pickCanonicalAccount([existing, acc]));
    } catch {
      // skip corrupt profiles
    }
  }

  const stored = listStoredAccounts();
  const storedByEmail = new Map();
  for (const row of stored) {
    if (!storedByEmail.has(row.email)) storedByEmail.set(row.email, row);
  }

  for (const [email, row] of storedByEmail) {
    if (profileByEmail.has(email)) continue;
    profileByEmail.set(email, {
      id: `${email}-${CANONICAL_TARGET}`,
      email,
      target: CANONICAL_TARGET,
      loginVia: null,
      status: 'unknown',
      statusLabel: 'Not logged in yet',
      sessionValid: false,
      tokenValid: false,
      lastLoginAt: null,
      updatedAt: row.updated_at,
      profileSavedAt: null,
      tokenCapturedAt: null,
      tokenExpiresAt: null,
      cookieCount: 0,
      originCount: 0,
      engine: row.engine,
      fingerprintSeed: null,
      staySignedIn: false,
      accessToken: null,
      tokenScope: null,
      refreshToken: null,
      profileFile: null,
      lastError: null,
      hasStoredPassword: !!getAccountPasswordWithFallback(email, CANONICAL_TARGET),
      health: 'not_logged_in',
      healthLabel: healthLabel('not_logged_in'),
      hasRefreshToken: false,
      needsRefresh: false,
      softbanStatus: 'unchecked',
      softbanLabel: 'Not checked',
      softbanCheckedAt: null,
      group: row.group_name || null,
    });
  }

  const accounts = [...profileByEmail.values()].map((acc) => ({
    ...acc,
    target: CANONICAL_TARGET,
    hasStoredPassword: !!getAccountPasswordWithFallback(acc.email, CANONICAL_TARGET),
  }));

  return accounts.sort((a, b) => (b.lastLoginAt || b.updatedAt || '').localeCompare(a.lastLoginAt || a.updatedAt || ''));
}

function formatAccount(data, file) {
  const sessionValid = hasValidSession(data);
  const tokenValid = isTokenValid(data.tokens);
  const status = deriveStatus(data, sessionValid, tokenValid);
  const health = deriveHealth(data, sessionValid, tokenValid, status);
  const hasRefreshToken = !!data.tokens?.refresh_token;
  const expiresMs = tokenExpiresInMs(data.tokens);

  return {
    id: `${data.email}-${CANONICAL_TARGET}`,
    email: data.email,
    target: CANONICAL_TARGET,
    loginVia: data.loginVia || null,
    status,
    statusLabel: statusLabel(status),
    health,
    healthLabel: healthLabel(health),
    sessionValid,
    tokenValid,
    hasRefreshToken,
    needsRefresh: health === 'needs_refresh',
    tokenExpiresInMin: expiresMs !== null ? Math.round(expiresMs / 60_000) : null,
    lastLoginAt: data.lastLoginAt || data.savedAt || null,
    profileSavedAt: data.savedAt || null,
    tokenCapturedAt: data.tokens?.captured_at || null,
    tokenExpiresAt: data.tokens?.expires_at || null,
    cookieCount: data.cookies?.length ?? 0,
    originCount: data.origins?.length ?? 0,
    engine: data.engine || null,
    fingerprintSeed: data.fingerprint?.seed || null,
    staySignedIn: data.staySignedIn ?? false,
    accessToken: isLiveProfileCardToken(data.tokens) ? data.tokens.access_token : null,
    tokenScope: data.tokens?.scope || null,
    refreshToken: data.tokens?.refresh_token ? '***saved***' : null,
    profileFile: path.join('profiles', file),
    lastError: data.lastError || null,
    hasStoredPassword: !!getAccountPasswordWithFallback(data.email, CANONICAL_TARGET),
    softbanStatus: data.softbanCheck?.status || 'unchecked',
    softbanLabel: softbanLabel(data.softbanCheck),
    softbanCheckedAt: data.softbanCheck?.checkedAt || null,
    softbanMessage: data.softbanCheck?.message || null,
  };
}

function softbanLabel(check) {
  if (!check?.status || check.status === 'unchecked') return 'Not checked';
  if (check.status === 'softban') return 'Softban';
  if (check.status === 'clean') return 'OK';
  if (check.status === 'no_token') return 'No token';
  return 'Check failed';
}

function deriveStatus(data, sessionValid, tokenValid) {
  if (data.lastStatus === 'failed') return 'failed';
  if (data.lastStatus === 'mfa_required') return 'mfa_required';
  if (tokenValid && (sessionValid || data.lastStatus === 'success')) return 'logged_in';
  if (sessionValid && isLiveProfileCardToken(data.tokens)) return 'token_expired';
  if (sessionValid) return 'session_only';
  if (data.lastStatus === 'success' && isLiveProfileCardToken(data.tokens)) {
    return isTokenValid(data.tokens) ? 'logged_in' : 'token_expired';
  }
  if (data.lastStatus === 'success' && isRecent(data.lastLoginAt)) return 'session_only';
  if (isLiveProfileCardToken(data.tokens)) return 'token_only';
  if (data.cookies?.length) return 'expired';
  return 'unknown';
}

function isRecent(iso) {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() < 48 * 60 * 60 * 1000;
}

function statusLabel(status) {
  const map = {
    logged_in: 'Logged in',
    session_only: 'Session only (no token)',
    token_expired: 'Token expired',
    token_only: 'Token only',
    expired: 'Expired',
    failed: 'Last login failed',
    mfa_required: 'MFA required',
    unknown: 'Unknown',
  };
  return map[status] || status;
}

export async function getAccount(email, _target = CANONICAL_TARGET) {
  const list = await listAccounts();
  return list.find((a) => a.email.toLowerCase() === email.toLowerCase()) || null;
}
