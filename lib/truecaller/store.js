/**
 * Isolated SQLite for Truecaller sessions. Does not touch app.db accounts/profiles.
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { TRUECALLER_DIR, TRUECALLER_DB_PATH, DEFAULT_PROXY_URL } from './config.js';

fs.mkdirSync(TRUECALLER_DIR, { recursive: true });

const db = new Database(TRUECALLER_DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accounts (
    email TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending',
    tc_jwt TEXT,
    tc_token TEXT,
    tc_user_cookie TEXT,
    name TEXT,
    tc_email TEXT,
    country_code TEXT,
    image TEXT,
    enhanced_search INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER,
    cookies_json TEXT,
    last_error TEXT,
    last_signup_at TEXT,
    last_search_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

function addColumn(sql) {
  try {
    db.exec(sql);
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
}
addColumn('ALTER TABLE accounts ADD COLUMN ms_cookies_json TEXT');
addColumn('ALTER TABLE accounts ADD COLUMN last_refresh_at TEXT');

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
  `INSERT INTO settings (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);

if (!getSettingStmt.get('proxy_url')?.value && DEFAULT_PROXY_URL) {
  setSettingStmt.run('proxy_url', DEFAULT_PROXY_URL);
}

export function getSetting(key, fallback = '') {
  return String(getSettingStmt.get(key)?.value ?? fallback ?? '');
}

export function setSetting(key, value) {
  setSettingStmt.run(String(key), String(value ?? ''));
}

export function getProxyPresetId() {
  return getSetting('proxy_preset', '');
}

export function setProxyPresetId(id) {
  setSetting('proxy_preset', String(id || ''));
  return getProxyPresetId();
}

export function listTokenAccounts({ q = '', limit = 80 } = {}) {
  const s = String(q || '').trim().toLowerCase();
  const cap = Math.min(200, Math.max(1, Number(limit) || 80));
  const out = [];
  for (const row of listStmt.all()) {
    if (!row.tc_jwt) continue;
    const pub = publicAccount(row);
    if (pub.expired) continue;
    if (s && !String(row.email).includes(s)) continue;
    out.push(pub);
    if (out.length >= cap) break;
  }
  return out;
}

export function getParallel() {
  const n = Number(getSetting('parallel', '1')) || 1;
  return Math.min(10, Math.max(1, n));
}

export function setParallel(n) {
  const v = Math.min(10, Math.max(1, Number(n) || 1));
  setSetting('parallel', String(v));
  return v;
}

export function tcStatusOf(row) {
  if (!row) return 'not_signed_up';
  const pub = publicAccount(row);
  if (pub.expired) return 'expired';
  if (row.status === 'signed_up' && pub.hasToken) return 'signed_up';
  if (row.status === 'failed') return 'failed';
  if (row.status === 'signing_up') return 'signing_up';
  return row.status || 'not_signed_up';
}

export function setProxyUrl(url) {
  const next = String(url || '').trim();
  setSettingStmt.run('proxy_url', next);
  return next;
}

const upsertStmt = db.prepare(`
  INSERT INTO accounts (
    email, status, tc_jwt, tc_token, tc_user_cookie, name, tc_email, country_code,
    image, enhanced_search, expires_at, cookies_json, last_error, last_signup_at,
    last_search_at, ms_cookies_json, last_refresh_at, created_at, updated_at
  ) VALUES (
    @email, @status, @tc_jwt, @tc_token, @tc_user_cookie, @name, @tc_email, @country_code,
    @image, @enhanced_search, @expires_at, @cookies_json, @last_error, @last_signup_at,
    @last_search_at, @ms_cookies_json, @last_refresh_at, @created_at, @updated_at
  )
  ON CONFLICT(email) DO UPDATE SET
    status = excluded.status,
    tc_jwt = COALESCE(excluded.tc_jwt, accounts.tc_jwt),
    tc_token = COALESCE(excluded.tc_token, accounts.tc_token),
    tc_user_cookie = COALESCE(excluded.tc_user_cookie, accounts.tc_user_cookie),
    name = COALESCE(excluded.name, accounts.name),
    tc_email = COALESCE(excluded.tc_email, accounts.tc_email),
    country_code = COALESCE(excluded.country_code, accounts.country_code),
    image = COALESCE(excluded.image, accounts.image),
    enhanced_search = excluded.enhanced_search,
    expires_at = COALESCE(excluded.expires_at, accounts.expires_at),
    cookies_json = COALESCE(excluded.cookies_json, accounts.cookies_json),
    last_error = excluded.last_error,
    last_signup_at = COALESCE(excluded.last_signup_at, accounts.last_signup_at),
    last_search_at = COALESCE(excluded.last_search_at, accounts.last_search_at),
    ms_cookies_json = COALESCE(excluded.ms_cookies_json, accounts.ms_cookies_json),
    last_refresh_at = COALESCE(excluded.last_refresh_at, accounts.last_refresh_at),
    updated_at = excluded.updated_at
`);

const getStmt = db.prepare('SELECT * FROM accounts WHERE email = ?');
const listStmt = db.prepare('SELECT * FROM accounts ORDER BY updated_at DESC');
const deleteStmt = db.prepare('DELETE FROM accounts WHERE email = ?');

function nowIso() {
  return new Date().toISOString();
}

export function getAccount(email) {
  return getStmt.get(String(email || '').trim().toLowerCase()) || null;
}

export function listAccounts() {
  return listStmt.all();
}

export function deleteAccount(email) {
  deleteStmt.run(String(email || '').trim().toLowerCase());
}

export function upsertAccount(email, patch = {}) {
  const key = String(email || '').trim().toLowerCase();
  const existing = getStmt.get(key);
  const created = existing?.created_at || nowIso();
  upsertStmt.run({
    email: key,
    status: patch.status ?? existing?.status ?? 'pending',
    tc_jwt: patch.tc_jwt ?? null,
    tc_token: patch.tc_token ?? null,
    tc_user_cookie: patch.tc_user_cookie ?? null,
    name: patch.name ?? null,
    tc_email: patch.tc_email ?? null,
    country_code: patch.country_code ?? null,
    image: patch.image ?? null,
    enhanced_search:
      typeof patch.enhanced_search === 'boolean' || typeof patch.enhanced_search === 'number'
        ? patch.enhanced_search
          ? 1
          : 0
        : existing?.enhanced_search || 0,
    expires_at: patch.expires_at ?? null,
    cookies_json: patch.cookies_json ?? null,
    last_error: patch.last_error ?? null,
    last_signup_at: patch.last_signup_at ?? null,
    last_search_at: patch.last_search_at ?? null,
    ms_cookies_json: patch.ms_cookies_json ?? null,
    last_refresh_at: patch.last_refresh_at ?? null,
    created_at: created,
    updated_at: nowIso(),
  });
  return getStmt.get(key);
}

export function publicAccount(row) {
  if (!row) return null;
  const exp = Number(row.expires_at) || 0;
  const expMs = exp > 1e12 ? exp : exp * 1000;
  return {
    email: row.email,
    status: row.status,
    name: row.name,
    tcEmail: row.tc_email,
    countryCode: row.country_code,
    image: row.image,
    enhancedSearch: !!row.enhanced_search,
    hasToken: !!row.tc_jwt,
    tokenPreview: row.tc_jwt ? `${String(row.tc_jwt).slice(0, 24)}…` : null,
    expiresAt: expMs ? new Date(expMs).toISOString() : null,
    expired: expMs ? Date.now() > expMs : false,
    lastError: row.last_error,
    lastSignupAt: row.last_signup_at,
    lastSearchAt: row.last_search_at,
    lastRefreshAt: row.last_refresh_at,
    hasMsSession: !!row.ms_cookies_json,
    updatedAt: row.updated_at,
  };
}
