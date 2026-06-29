import { isTokenValid, isLiveProfileCardToken } from './token-extract.js';

export const REFRESH_BUFFER_MS = Number(process.env.SMART_REFRESH_BUFFER_MS || 30 * 60 * 1000);

const SOFTBAN_RE =
  /unusual activity|account.?lock|locked|suspend|blocked|verify your identity|help us secure|too many attempts|abuse|restricted|compromised|sign.?in was blocked/i;
const REAUTH_RE =
  /aadsts70000|invalid_grant|grant is expired|user must sign in again|refresh token rejected/i;

export function detectSoftban(lastError) {
  return SOFTBAN_RE.test(String(lastError || ''));
}

/** Microsoft explicitly requires interactive sign-in again. */
export function isReauthRequired(lastError) {
  return REAUTH_RE.test(String(lastError || ''));
}

export function tokenExpiresInMs(tokens) {
  if (!tokens?.expires_at) return null;
  return new Date(tokens.expires_at).getTime() - Date.now();
}

export function needsSmartRefresh(tokens, sessionValid) {
  if (!sessionValid) return false;
  const hasRefresh = !!tokens?.refresh_token;
  const hasLive = isLiveProfileCardToken(tokens);

  if (!hasLive && !hasRefresh) return false;

  if (!tokens?.expires_at) return !isTokenValid(tokens);

  return tokenExpiresInMs(tokens) <= REFRESH_BUFFER_MS;
}

/** Dashboard bucket for counters. */
export function deriveHealth(data, sessionValid, tokenValid, status) {
  if (data.softbanCheck?.status === 'softban') return 'softban';

  const lastError = data.lastError || '';

  if (detectSoftban(lastError)) return 'softban';
  if (status === 'failed') return 'failed';
  if (status === 'mfa_required') return 'mfa_required';
  if (status === 'unknown') return 'not_logged_in';

  const hasRefresh = !!data.tokens?.refresh_token;
  const hasLiveToken = isLiveProfileCardToken(data.tokens);

  if (tokenValid && hasLiveToken) {
    const ms = tokenExpiresInMs(data.tokens);
    if (ms !== null && ms <= REFRESH_BUFFER_MS) return 'needs_refresh';
    return 'available';
  }

  if (hasRefresh && sessionValid && (status === 'token_expired' || !tokenValid)) {
    return 'needs_refresh';
  }

  if (status === 'token_expired') return 'token_expired';
  if (status === 'session_only') return 'session_only';
  if (status === 'token_only') return 'token_only';
  if (status === 'expired') return 'expired';

  return status || 'unknown';
}

export function healthLabel(health) {
  const map = {
    available: 'Available',
    needs_refresh: 'Needs refresh',
    token_expired: 'Token expired',
    failed: 'Failed',
    softban: 'Softban / flagged',
    mfa_required: 'MFA required',
    session_only: 'Session only',
    token_only: 'Token only',
    expired: 'Session expired',
    not_logged_in: 'Not logged in',
    unknown: 'Unknown',
  };
  return map[health] || health;
}

export function computeAccountStats(accounts) {
  const main = ['available', 'needs_refresh', 'failed', 'softban', 'mfa_required'];
  const stats = {
    total: accounts.length,
    available: 0,
    needs_refresh: 0,
    failed: 0,
    softban: 0,
    mfa_required: 0,
    not_logged_in: 0,
    other: 0,
    with_refresh_token: 0,
    backup_unknown: 0,
    backup_skipped: 0,
    backup_verified: 0,
    backup_required: 0,
  };

  for (const acc of accounts) {
    const h = acc.health || 'unknown';
    if (h === 'not_logged_in') stats.not_logged_in++;
    else if (main.includes(h)) stats[h]++;
    else stats.other++;
    if (acc.hasRefreshToken) stats.with_refresh_token++;
    const bs = acc.backupEmailStatus || 'unknown';
    if (bs === 'unknown') stats.backup_unknown++;
    else if (bs === 'skipped') stats.backup_skipped++;
    else if (bs === 'verified') stats.backup_verified++;
    else if (bs === 'required') stats.backup_required++;
  }

  return stats;
}
