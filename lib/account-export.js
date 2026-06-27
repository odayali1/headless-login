import fs from 'node:fs/promises';
import path from 'node:path';
import { PROFILES_DIR } from './profile.js';
import { listAccounts } from './accounts.js';
import { isLiveProfileCardToken, isTokenValid } from './token-extract.js';
import { hasValidSession } from './profile.js';
import { needsSmartRefresh } from './account-health.js';

function csvEscape(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function toCsv(columns, rows) {
  const header = columns.map((c) => csvEscape(c.header)).join(',');
  const lines = rows.map((row) => columns.map((c) => csvEscape(c.value(row))).join(','));
  return [header, ...lines].join('\r\n');
}

async function readProfileRaw(email, target) {
  const safe = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
  const file = path.join(PROFILES_DIR, `${safe}-${target}.json`);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function buildExportRows(type, { group } = {}) {
  const accounts = await listAccounts();
  const rows = [];

  for (const acc of accounts) {
    const raw = await readProfileRaw(acc.email, acc.target);
    const tokens = raw?.tokens;
    const refreshToken = tokens?.refresh_token || null;
    const accessToken = isLiveProfileCardToken(tokens) ? tokens.access_token : acc.accessToken;
    const sessionValid = raw ? hasValidSession(raw) : acc.sessionValid;

    if (group && String(acc.group || '').toLowerCase() !== String(group).toLowerCase()) {
      continue;
    }

    const base = {
      email: acc.email,
      target: acc.target,
      status: acc.status,
      health: acc.health,
      lastError: acc.lastError || raw?.lastError || '',
      lastLoginAt: acc.lastLoginAt || raw?.lastLoginAt || raw?.savedAt || '',
      tokenExpiresAt: acc.tokenExpiresAt || tokens?.expires_at || '',
      refreshToken,
      accessToken,
      sessionValid,
      group: acc.group || '',
    };

    if (type === 'tokens') {
      if (!accessToken || !isTokenValid(tokens)) continue;
      rows.push(base);
      continue;
    }

    if (type === 'failed-refresh') {
      if (!refreshToken) continue;
      const failedLike = ['failed', 'softban', 'token_expired', 'needs_refresh', 'mfa_required'].includes(acc.health);
      if (!failedLike) continue;
      rows.push(base);
    }
  }

  return rows;
}

export async function exportCsv(type, options = {}) {
  const rows = await buildExportRows(type, options);

  if (type === 'tokens') {
    return {
      filename: `outlook-tokens-${new Date().toISOString().slice(0, 10)}.csv`,
      body: toCsv(
        [
          { header: 'email', value: (r) => r.email },
          { header: 'access_token', value: (r) => r.accessToken },
          { header: 'last_login', value: (r) => r.lastLoginAt },
          { header: 'token_expires', value: (r) => r.tokenExpiresAt },
          { header: 'health', value: (r) => r.health },
          { header: 'group', value: (r) => r.group },
        ],
        rows
      ),
      count: rows.length,
    };
  }

  if (type === 'failed-refresh') {
    return {
      filename: `outlook-failed-refresh-${new Date().toISOString().slice(0, 10)}.csv`,
      body: toCsv(
        [
          { header: 'email', value: (r) => r.email },
          { header: 'refresh_token', value: (r) => r.refreshToken },
          { header: 'health', value: (r) => r.health },
          { header: 'last_error', value: (r) => r.lastError },
        ],
        rows
      ),
      count: rows.length,
    };
  }

  throw new Error(`Unknown export type: ${type}`);
}

export async function listAccountsDueForRefresh() {
  const accounts = await listAccounts();
  const due = [];

  for (const acc of accounts) {
    const raw = await readProfileRaw(acc.email, acc.target);
    if (!raw) continue;
    if (needsSmartRefresh(raw.tokens, hasValidSession(raw))) {
      due.push(acc);
    }
  }

  return due;
}
