import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptPassword, decryptPassword } from './credentials.js';
import { initSettings, bindSettingsStore } from './settings.js';
import { CANONICAL_TARGET } from './profile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_PATH = process.env.DATABASE_PATH || path.join(DATA_DIR, 'app.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const settingsStore = initSettings(db);
bindSettingsStore(settingsStore);

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    email TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT 'outlook',
    password_enc TEXT NOT NULL,
    engine TEXT NOT NULL DEFAULT 'auto',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (email, target)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS account_groups (
    email TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT 'outlook',
    group_name TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (email, target)
  );
`);

const upsertStmt = db.prepare(`
  INSERT INTO accounts (email, target, password_enc, engine, created_at, updated_at)
  VALUES (@email, @target, @password_enc, @engine, @created_at, @updated_at)
  ON CONFLICT(email, target) DO UPDATE SET
    password_enc = excluded.password_enc,
    engine = excluded.engine,
    updated_at = excluded.updated_at
`);

const getStmt = db.prepare('SELECT * FROM accounts WHERE email = ? AND target = ?');
const listStmt = db.prepare(`
  SELECT a.email, a.target, a.engine, a.created_at, a.updated_at, g.group_name
  FROM accounts a
  LEFT JOIN account_groups g ON g.email = a.email AND g.target = a.target
  ORDER BY a.updated_at DESC
`);
const deleteStmt = db.prepare('DELETE FROM accounts WHERE email = ? AND target = ?');
const setGroupStmt = db.prepare(`
  INSERT INTO account_groups (email, target, group_name, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(email, target) DO UPDATE SET
    group_name = excluded.group_name,
    updated_at = excluded.updated_at
`);
const getGroupStmt = db.prepare('SELECT group_name FROM account_groups WHERE email = ? AND target = ?');
const deleteGroupStmt = db.prepare('DELETE FROM account_groups WHERE email = ? AND target = ?');
const listGroupsStmt = db.prepare(`
  SELECT group_name, COUNT(*) AS count
  FROM account_groups
  GROUP BY group_name
  ORDER BY group_name COLLATE NOCASE
`);

export function consolidateDbCredentials() {
  const rows = listStmt.all();
  const byEmail = new Map();
  for (const row of rows) {
    const existing = byEmail.get(row.email);
    if (!existing || row.target === CANONICAL_TARGET) byEmail.set(row.email, row);
  }
  let merged = 0;
  for (const row of rows) {
    if (row.target === CANONICAL_TARGET) continue;
    const canonical = byEmail.get(row.email);
    if (!canonical) {
      const now = new Date().toISOString();
      upsertStmt.run({
        email: row.email,
        target: CANONICAL_TARGET,
        password_enc: row.password_enc,
        engine: row.engine,
        created_at: row.created_at,
        updated_at: now,
      });
      if (row.group_name) {
        setGroupStmt.run(row.email, CANONICAL_TARGET, row.group_name, now);
      }
      merged += 1;
    }
    deleteStmt.run(row.email, row.target);
    deleteGroupStmt.run(row.email, row.target);
  }
  if (merged > 0) console.log(`[migrate] Merged ${merged} credential row(s) → ${CANONICAL_TARGET} per email`);
}

export function saveAccountCredentials(email, target, password, engine = 'auto') {
  const now = new Date().toISOString();
  const canonical = CANONICAL_TARGET;
  db.prepare('DELETE FROM accounts WHERE email = ? AND target != ?').run(email.trim(), canonical);
  upsertStmt.run({
    email: email.trim(),
    target: canonical,
    password_enc: encryptPassword(password),
    engine,
    created_at: now,
    updated_at: now,
  });
}

export function getAccountPassword(email, target) {
  const row = getStmt.get(email.trim(), target);
  if (!row) return null;
  return decryptPassword(row.password_enc);
}

export function getAccountPasswordWithFallback(email, target) {
  const direct = getStmt.get(email.trim(), target);
  if (direct) {
    const p = decryptPassword(direct.password_enc);
    if (p) return p;
  }
  const canonical = getStmt.get(email.trim(), CANONICAL_TARGET);
  if (canonical) {
    const p = decryptPassword(canonical.password_enc);
    if (p) return p;
  }
  const rows = db.prepare('SELECT password_enc FROM accounts WHERE email = ?').all(email.trim());
  for (const row of rows) {
    const p = decryptPassword(row.password_enc);
    if (p) return p;
  }
  return null;
}

export function hasDecryptablePassword(email, target) {
  return !!getAccountPasswordWithFallback(email, target);
}

export function getAccountRecord(email, _target) {
  const rows = db.prepare('SELECT * FROM accounts WHERE email = ?').all(email.trim());
  return rows.find((r) => r.target === CANONICAL_TARGET) || rows[0] || null;
}

export function listStoredAccounts() {
  consolidateDbCredentials();
  const rows = listStmt.all();
  const byEmail = new Map();
  for (const row of rows) {
    if (!byEmail.has(row.email)) {
      byEmail.set(row.email, { ...row, target: CANONICAL_TARGET });
    }
  }
  return [...byEmail.values()];
}

export function deleteAccountCredentials(email, _target) {
  const e = email.trim();
  db.prepare('DELETE FROM accounts WHERE email = ?').run(e);
  db.prepare('DELETE FROM account_groups WHERE email = ?').run(e);
}

export function hasStoredPassword(email, target) {
  return !!getAccountPasswordWithFallback(email, target);
}

export function setAccountGroup(email, _target, groupName) {
  const cleaned = String(groupName || '').trim();
  if (!cleaned) {
    deleteGroupStmt.run(email.trim(), CANONICAL_TARGET);
    return;
  }
  setGroupStmt.run(email.trim(), CANONICAL_TARGET, cleaned, new Date().toISOString());
}

export function getAccountGroup(email, _target) {
  return getGroupStmt.get(email.trim(), CANONICAL_TARGET)?.group_name || null;
}

export function listGroups() {
  return listGroupsStmt.all();
}

export { DB_PATH };
