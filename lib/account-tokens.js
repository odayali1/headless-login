import fs from 'node:fs/promises';
import path from 'node:path';
import { PROFILES_DIR } from './profile.js';
import { listAccounts } from './accounts.js';
import { isLiveProfileCardToken, isTokenValid } from './token-extract.js';

async function readProfileRaw(email, target) {
  const safe = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
  const file = path.join(PROFILES_DIR, `${safe}-${target}.json`);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export function formatTokenRecord(acc, raw, { includeRefreshToken = false } = {}) {
  const tokens = raw?.tokens;
  const hasLiveToken = isLiveProfileCardToken(tokens) && !!tokens?.access_token;
  const tokenValid = isTokenValid(tokens);

  const record = {
    email: acc.email,
    target: acc.target,
    group: acc.group || null,
    health: acc.health,
    health_label: acc.healthLabel,
    status: acc.status,
    session_valid: !!acc.sessionValid,
    has_token: hasLiveToken && tokenValid,
    access_token: hasLiveToken ? tokens.access_token : null,
    token_expires_at: tokens?.expires_at || acc.tokenExpiresAt || null,
    token_expires_in_minutes: acc.tokenExpiresInMin ?? null,
    token_scope: tokens?.scope || acc.tokenScope || null,
    last_login_at: acc.lastLoginAt || raw?.lastLoginAt || raw?.savedAt || null,
    token_captured_at: tokens?.captured_at || acc.tokenCapturedAt || null,
    has_refresh_token: !!(tokens?.refresh_token || acc.hasRefreshToken),
  };

  if (includeRefreshToken && tokens?.refresh_token) {
    record.refresh_token = tokens.refresh_token;
  }

  return record;
}

export async function listTokenRecords({
  target = 'outlook',
  group = '',
  health = '',
  tokensOnly = false,
  includeRefreshToken = false,
} = {}) {
  const accounts = await listAccounts();
  const rows = [];

  for (const acc of accounts) {
    if (target && acc.target !== target) continue;
    if (group && String(acc.group || '').toLowerCase() !== String(group).toLowerCase()) continue;
    if (health && acc.health !== health) continue;

    const raw = await readProfileRaw(acc.email, acc.target);
    const record = formatTokenRecord(acc, raw, { includeRefreshToken });

    if (tokensOnly && !record.has_token) continue;
    rows.push(record);
  }

  return rows;
}

export async function getTokenRecord(email, target, options = {}) {
  const accounts = await listAccounts();
  const acc = accounts.find((a) => a.email === email && a.target === target);
  if (!acc) return null;
  const raw = await readProfileRaw(email, target);
  return formatTokenRecord(acc, raw, options);
}

export { readProfileRaw };
