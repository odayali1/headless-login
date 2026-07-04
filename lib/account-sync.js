import fs from 'node:fs/promises';
import path from 'node:path';
import { PROFILES_DIR, CANONICAL_TARGET, hasValidSession } from './profile.js';
import { getAccountGroup, listGroupsChangedSince } from './db.js';
import { formatTokenRecord } from './account-tokens.js';
import { isTokenValid } from './token-extract.js';
import { deriveHealth, healthLabel, tokenExpiresInMs } from './account-health.js';

const MAX_BULK = Number(process.env.SYNC_BULK_MAX || 100);
const DEFAULT_DELTA_LIMIT = Number(process.env.SYNC_DELTA_LIMIT || 500);

export function accountChangedAt(raw) {
  if (!raw) return null;
  const stamps = [
    raw.lastTokenRefreshAt,
    raw.tokens?.captured_at,
    raw.savedAt,
    raw.lastLoginAt,
    raw.updatedAt,
  ].filter(Boolean);
  return stamps.length ? stamps.sort().at(-1) : null;
}

function profilePath(email, target = CANONICAL_TARGET) {
  const safe = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
  return path.join(PROFILES_DIR, `${safe}-${target}.json`);
}

async function readProfile(email, target = CANONICAL_TARGET) {
  try {
    return JSON.parse(await fs.readFile(profilePath(email, target), 'utf8'));
  } catch {
    return null;
  }
}

function summarizeFromProfile(raw, email) {
  const sessionValid = hasValidSession(raw);
  const tokenValid = isTokenValid(raw?.tokens);
  const status = raw?.lastStatus || 'unknown';
  const health = deriveHealth(raw || {}, sessionValid, tokenValid, status);
  const expiresMs = tokenExpiresInMs(raw?.tokens);

  return {
    email,
    target: CANONICAL_TARGET,
    group: getAccountGroup(email, CANONICAL_TARGET),
    health,
    healthLabel: healthLabel(health),
    status,
    sessionValid,
    tokenValid,
    tokenExpiresAt: raw?.tokens?.expires_at || null,
    tokenExpiresInMin: expiresMs !== null ? Math.round(expiresMs / 60_000) : null,
    lastLoginAt: raw?.lastLoginAt || raw?.savedAt || null,
    hasRefreshToken: !!raw?.tokens?.refresh_token,
    tokenScope: raw?.tokens?.scope || null,
    tokenCapturedAt: raw?.tokens?.captured_at || null,
  };
}

function toSyncRecord(raw, email, { includeRefreshToken = false } = {}) {
  const acc = summarizeFromProfile(raw, email);
  const record = formatTokenRecord(acc, raw, { includeRefreshToken });
  record.changed_at = accountChangedAt(raw);
  record.sync_version = record.changed_at;
  return record;
}

export async function getBulkSyncRecords({
  emails = [],
  target = CANONICAL_TARGET,
  includeRefreshToken = false,
} = {}) {
  const unique = [...new Set(emails.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
  if (!unique.length) {
    const err = new Error('Provide emails: ["user@outlook.com", ...]');
    err.code = 'INVALID_BODY';
    throw err;
  }
  if (unique.length > MAX_BULK) {
    const err = new Error(`Maximum ${MAX_BULK} emails per bulk sync request.`);
    err.code = 'BULK_LIMIT';
    throw err;
  }

  const accounts = [];
  const notFound = [];

  for (const email of unique) {
    const raw = await readProfile(email, target);
    if (!raw?.email) {
      notFound.push(email);
      continue;
    }
    accounts.push(toSyncRecord(raw, raw.email, { includeRefreshToken }));
  }

  return {
    accounts,
    found: accounts.length,
    not_found: notFound,
    requested: unique.length,
  };
}

export async function listDeltaSyncRecords({
  since,
  target = CANONICAL_TARGET,
  group = '',
  limit = DEFAULT_DELTA_LIMIT,
  includeRefreshToken = false,
} = {}) {
  const sinceDate = new Date(since);
  if (!since || Number.isNaN(sinceDate.getTime())) {
    const err = new Error('Query param since is required (ISO-8601 datetime).');
    err.code = 'INVALID_SINCE';
    throw err;
  }
  const sinceIso = sinceDate.toISOString();
  const cap = Math.min(Math.max(1, Number(limit) || DEFAULT_DELTA_LIMIT), 2000);

  await fs.mkdir(PROFILES_DIR, { recursive: true });
  const files = (await fs.readdir(PROFILES_DIR)).filter((f) => f.endsWith(`-${target}.json`));

  const changed = new Map();

  for (const file of files) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(PROFILES_DIR, file), 'utf8'));
      if (!raw?.email) continue;
      const changedAt = accountChangedAt(raw);
      if (!changedAt || changedAt <= sinceIso) continue;

      const acc = summarizeFromProfile(raw, raw.email);
      if (group && String(acc.group || '').toLowerCase() !== String(group).toLowerCase()) continue;

      changed.set(raw.email.toLowerCase(), {
        record: toSyncRecord(raw, raw.email, { includeRefreshToken }),
        changedAt,
      });
    } catch {
      // skip corrupt profile
    }
  }

  for (const row of listGroupsChangedSince(sinceIso)) {
    if (row.target !== target) continue;
    const key = row.email.toLowerCase();
    if (changed.has(key)) continue;

    const raw = await readProfile(row.email, target);
    if (!raw?.email) continue;
    const acc = summarizeFromProfile(raw, row.email);
    if (group && String(acc.group || '').toLowerCase() !== String(group).toLowerCase()) continue;

    changed.set(key, {
      record: toSyncRecord(raw, raw.email, { includeRefreshToken }),
      changedAt: row.updated_at,
    });
  }

  const sorted = [...changed.values()].sort((a, b) => a.changedAt.localeCompare(b.changedAt));
  const slice = sorted.slice(0, cap);
  const accounts = slice.map((x) => x.record);
  const hasMore = sorted.length > cap;
  const serverTime = new Date().toISOString();
  const watermark =
    slice.length > 0
      ? slice[slice.length - 1].changedAt
      : sinceIso;

  return {
    since: sinceIso,
    server_time: serverTime,
    count: accounts.length,
    total_matched: sorted.length,
    has_more: hasMore,
    next_since: watermark,
    accounts,
  };
}

export { MAX_BULK as SYNC_BULK_MAX };
