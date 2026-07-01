import fs from 'node:fs/promises';
import path from 'node:path';
import { PROFILES_DIR, CANONICAL_TARGET, consolidateLegacyProfiles } from './profile.js';
import { hasValidSession } from './profile-session.js';
import { isTokenValid, isLiveProfileCardToken } from './token-extract.js';
import { listStoredAccounts, getAccountPasswordWithFallback } from './db.js';

let accountsCache = null;
let accountsCacheAt = 0;
const ACCOUNTS_CACHE_MS = 15_000;

export function invalidateAccountsCache() {
  accountsCache = null;
}
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

export async function listAccounts({ bustCache = false } = {}) {
  if (!bustCache && accountsCache && Date.now() - accountsCacheAt < ACCOUNTS_CACHE_MS) {
    return accountsCache;
  }

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
  const groupByEmail = new Map();
  for (const row of stored) {
    if (!storedByEmail.has(row.email)) storedByEmail.set(row.email, row);
    if (row.group_name) groupByEmail.set(row.email, row.group_name);
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
      backupEmailStatus: 'unknown',
      backupEmailStatusLabel: 'Unknown',
      backupEmail: null,
      backupHubEmail: null,
    });
  }

  const accounts = [...profileByEmail.values()].map((acc) => ({
    ...acc,
    target: CANONICAL_TARGET,
    group: groupByEmail.get(acc.email) || acc.group || null,
    hasStoredPassword: !!getAccountPasswordWithFallback(acc.email, CANONICAL_TARGET),
  }));

  const sorted = accounts.sort((a, b) => (b.lastLoginAt || b.updatedAt || '').localeCompare(a.lastLoginAt || a.updatedAt || ''));
  accountsCache = sorted;
  accountsCacheAt = Date.now();
  return sorted;
}

export function toPublicAccount(acc) {
  const accessToken = acc.accessToken || null;
  const { accessToken: _drop, ...rest } = acc;
  return {
    ...rest,
    hasAccessToken: !!accessToken,
    tokenPreview: accessToken ? `${accessToken.slice(0, 24)}…` : null,
  };
}

export function filterAccounts(accounts, { group = '', health = '', search = '' } = {}) {
  const q = String(search || '').trim().toLowerCase();
  return accounts.filter((acc) => {
    if (group && (acc.group || '') !== group) return false;
    if (q && !String(acc.email || '').toLowerCase().includes(q)) return false;
    if (!health) return true;
    if (health.startsWith('backup_')) {
      return (acc.backupEmailStatus || 'unknown') === health.replace('backup_', '');
    }
    if (health === 'needs_token') {
      return ['session_only', 'needs_refresh', 'failed'].includes(acc.health || '');
    }
    return (acc.health || '') === health;
  });
}

export async function listAccountsPage({ page = 1, limit = 50, group = '', health = '', search = '' } = {}) {
  const safeLimit = Math.min(200, Math.max(10, Number(limit) || 50));
  const all = await listAccounts();
  const filtered = filterAccounts(all, { group, health, search });
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / safeLimit));
  const safePage = Math.min(Math.max(1, Number(page) || 1), pages);
  const start = (safePage - 1) * safeLimit;
  return {
    accounts: filtered.slice(start, start + safeLimit).map(toPublicAccount),
    total,
    page: safePage,
    limit: safeLimit,
    pages,
  };
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
    backupEmailStatus: data.backupEmailStatus || 'unknown',
    backupEmailStatusLabel: backupEmailStatusLabel(data.backupEmailStatus),
    backupEmail: data.backupEmail || null,
    backupHubEmail: data.backupHubEmail || null,
    backupEmailSkippedAt: data.backupEmailSkippedAt || null,
    backupEmailVerifiedAt: data.backupEmailVerifiedAt || null,
    backupEmailCheckedAt: data.backupEmailCheckedAt || null,
    backupSkipLabel: data.backupSkipLabel || null,
  };
}

function backupEmailStatusLabel(status) {
  const map = {
    unknown: 'Not checked',
    not_prompted: 'No backup prompt',
    skipped: 'Prompt — skipped',
    verified: 'Backup verified',
    required: 'Prompt — add email',
  };
  return map[status] || status;
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
