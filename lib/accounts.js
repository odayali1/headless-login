import fs from 'node:fs/promises';
import path from 'node:path';
import { PROFILES_DIR, CANONICAL_TARGET, consolidateLegacyProfiles } from './profile.js';
import { hasValidSession } from './profile-session.js';
import { isTokenValid, isLiveProfileCardToken } from './token-extract.js';
import { listStoredAccounts, getAccountPasswordWithFallback } from './db.js';
import {
  deriveHealth,
  EXPIRES_20M_WINDOW_MS,
  EXPIRES_SOON_WINDOW_MS,
  healthLabel,
  tokenExpiresInMs,
} from './account-health.js';

/** Short TTL cache — full profile scan of ~1k accounts is expensive and was OOMing under smart-refresh. */
const ACCOUNTS_CACHE_TTL_MS = Number(process.env.ACCOUNTS_CACHE_TTL_MS || 8_000);
let accountsCache = null;
let accountsCacheAt = 0;
let accountsCacheInFlight = null;

export function invalidateAccountsCache() {
  accountsCache = null;
  accountsCacheAt = 0;
}

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

async function buildAccountsList() {
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
      hasAccessToken: false,
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

  return accounts.sort((a, b) =>
    (b.lastLoginAt || b.updatedAt || '').localeCompare(a.lastLoginAt || a.updatedAt || '')
  );
}

export async function listAccounts({ bustCache = false } = {}) {
  const now = Date.now();
  if (!bustCache && accountsCache && now - accountsCacheAt < ACCOUNTS_CACHE_TTL_MS) {
    return accountsCache;
  }
  if (accountsCacheInFlight) return accountsCacheInFlight;

  accountsCacheInFlight = buildAccountsList()
    .then((sorted) => {
      accountsCache = sorted;
      accountsCacheAt = Date.now();
      return sorted;
    })
    .finally(() => {
      accountsCacheInFlight = null;
    });

  return accountsCacheInFlight;
}

export function toPublicAccount(acc) {
  return {
    ...acc,
    tokenPreview: acc.hasAccessToken ? 'saved…' : null,
  };
}

/** Last successful or failed login attempt (failures also bump lastLoginAt). */
function lastTryAt(acc) {
  return acc.lastLoginAt || acc.updatedAt || null;
}

export function filterAccounts(accounts, { group = '', health = '', search = '', idleHours = 0 } = {}) {
  const q = String(search || '').trim().toLowerCase();
  const idleMs = Math.max(0, Number(idleHours) || 0) * 3600_000;
  const cutoff = idleMs > 0 ? Date.now() - idleMs : 0;
  return accounts.filter((acc) => {
    if (group && (acc.group || '') !== group) return false;
    if (q && !String(acc.email || '').toLowerCase().includes(q)) return false;
    if (idleMs > 0) {
      const t = lastTryAt(acc);
      if (t) {
        const ms = new Date(t).getTime();
        if (Number.isFinite(ms) && ms >= cutoff) return false;
      }
      // null last try → include (never logged in / never tried)
    }
    if (!health) return true;
    if (health.startsWith('backup_')) {
      return (acc.backupEmailStatus || 'unknown') === health.replace('backup_', '');
    }
    if (health === 'needs_token') {
      return ['session_only', 'needs_refresh', 'failed'].includes(acc.health || '');
    }
    if (health === 'expires_soon') {
      const ms = Number.isFinite(acc.tokenExpiresInMin) ? acc.tokenExpiresInMin * 60_000 : null;
      return ms !== null && ms > 0 && ms <= EXPIRES_SOON_WINDOW_MS;
    }
    if (health === 'expires_20m') {
      const ms = Number.isFinite(acc.tokenExpiresInMin) ? acc.tokenExpiresInMin * 60_000 : null;
      return ms !== null && ms > 0 && ms <= EXPIRES_20M_WINDOW_MS;
    }
    return (acc.health || '') === health;
  });
}

/** login_newest (default) | login_oldest — never-tried accounts sort first when oldest. */
export function sortAccounts(accounts, sort = 'login_newest') {
  const key = (a) => lastTryAt(a) || '';
  const list = [...accounts];
  if (sort === 'login_oldest') {
    return list.sort((a, b) => {
      const ak = key(a);
      const bk = key(b);
      if (!ak && !bk) return 0;
      if (!ak) return -1;
      if (!bk) return 1;
      return ak.localeCompare(bk);
    });
  }
  return list.sort((a, b) => key(b).localeCompare(key(a)));
}

export async function listAccountsPage({
  page = 1,
  limit = 50,
  group = '',
  health = '',
  search = '',
  sort = 'login_newest',
  idleHours = 0,
} = {}) {
  const safeLimit = Math.min(200, Math.max(10, Number(limit) || 50));
  const all = await listAccounts();
  const filtered = sortAccounts(filterAccounts(all, { group, health, search, idleHours }), sort);
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
    hasAccessToken: isLiveProfileCardToken(data.tokens),
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
    httpRefreshRejectedAt: data.httpRefreshRejectedAt || null,
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
