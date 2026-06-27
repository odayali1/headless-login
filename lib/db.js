import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptPassword, decryptPassword } from './credentials.js';
import { initSettings, bindSettingsStore } from './settings.js';

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

export function saveAccountCredentials(email, target, password, engine = 'auto') {
  const now = new Date().toISOString();
  upsertStmt.run({
    email: email.trim(),
    target,
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

/** Password for target, or same email under outlook/teams if only one side was saved. */
export function getAccountPasswordWithFallback(email, target) {
  const direct = getAccountPassword(email, target);
  if (direct) return direct;
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

export function getAccountRecord(email, target) {
  return getStmt.get(email.trim(), target) || null;
}

export function listStoredAccounts() {
  return listStmt.all();
}

export function deleteAccountCredentials(email, target) {
  deleteStmt.run(email.trim(), target);
  deleteGroupStmt.run(email.trim(), target);
}

export function hasStoredPassword(email, target) {
  return !!getStmt.get(email.trim(), target);
}

export function setAccountGroup(email, target, groupName) {
  const cleaned = String(groupName || '').trim();
  if (!cleaned) {
    deleteGroupStmt.run(email.trim(), target);
    return;
  }
  setGroupStmt.run(email.trim(), target, cleaned, new Date().toISOString());
}

export function getAccountGroup(email, target) {
  return getGroupStmt.get(email.trim(), target)?.group_name || null;
}

export function listGroups() {
  return listGroupsStmt.all();
}

export { DB_PATH };
