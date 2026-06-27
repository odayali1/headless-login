import fs from 'node:fs/promises';
import path from 'node:path';
import { PROFILES_DIR, hasValidSession } from './profile.js';
import { isTokenValid, isLiveProfileCardToken } from './token-extract.js';
import { listStoredAccounts, hasStoredPassword, getAccountPasswordWithFallback } from './db.js';
import { deriveHealth, healthLabel, tokenExpiresInMs } from './account-health.js';

export async function listAccounts() {
  await fs.mkdir(PROFILES_DIR, { recursive: true });
  const files = (await fs.readdir(PROFILES_DIR)).filter((f) => f.endsWith('.json'));
  const profileMap = new Map();

  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(PROFILES_DIR, file), 'utf8');
      const data = JSON.parse(raw);
      profileMap.set(`${data.email}::${data.target}`, formatAccount(data, file));
    } catch {
      // skip corrupt profiles
    }
  }

  const stored = listStoredAccounts();
  const storedMap = new Map(stored.map((r) => [`${r.email}::${r.target}`, r]));
  for (const row of stored) {
    const key = `${row.email}::${row.target}`;
    if (!profileMap.has(key)) {
      profileMap.set(key, {
        id: `${row.email}-${row.target}`,
        email: row.email,
        target: row.target,
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
        hasStoredPassword: true,
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
  }

  const accounts = [...profileMap.values()].map((acc) => {
    const row = storedMap.get(`${acc.email}::${acc.target}`);
    return {
      ...acc,
      group: acc.group ?? row?.group_name ?? null,
      hasStoredPassword: row ? !!getAccountPasswordWithFallback(row.email, row.target) : false,
    };
  });

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
    id: `${data.email}-${data.target}`,
    email: data.email,
    target: data.target,
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
    hasStoredPassword: !!getAccountPasswordWithFallback(data.email, data.target),
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

export async function getAccount(email, target) {
  const list = await listAccounts();
  return list.find((a) => a.email === email && a.target === target) || null;
}
