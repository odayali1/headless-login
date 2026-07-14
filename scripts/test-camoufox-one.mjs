/**
 * One-account Camoufox capture test (Outlook → Teams → Loki redeem).
 * Usage: node scripts/test-camoufox-one.mjs [email]
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSettings, bindSettingsStore } from '../lib/settings.js';
import { refreshAccountToken } from '../lib/account-actions.js';
import { closeLocalProxy } from '../lib/proxy-local.js';
import { isCamoufoxAvailable } from '../lib/camoufox-browser.js';

function loadEnvFile() {
  try {
    const raw = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || process.env[m[1]]) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  } catch {
    // optional
  }
}
loadEnvFile();

const emailArg = process.argv[2];
const PROFILES_DIR = path.join(process.env.DATA_DIR || './data', 'profiles');

function pickEmail() {
  if (emailArg) return emailArg;
  let best = null;
  for (const f of fs.readdirSync(PROFILES_DIR).filter((x) => x.endsWith('.json'))) {
    const p = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8'));
    const score = (p.cookies || []).length * 10 + (p.origins || []).length;
    if (!best || score > best.score) best = { email: p.email, score };
  }
  return best?.email;
}

const db = new Database(path.join(process.env.DATA_DIR || './data', 'app.db'));
bindSettingsStore(initSettings(db));

const email = pickEmail();
if (!email) {
  console.error('No profile found');
  process.exit(1);
}

console.log('Camoufox available:', await isCamoufoxAvailable());
console.log('Testing Camoufox refresh for', email);

try {
  const result = await refreshAccountToken(email, 'outlook', {
    engine: 'camoufox',
    skipBrowserless: true,
    jobId: 'local-test',
    onProgress: ({ step, message }) => console.log(`[${step}] ${message}`),
  });
  console.log('SUCCESS', {
    expires_at: result?.tokens?.expires_at,
    hasRT: !!result?.tokens?.refresh_token,
    scope: result?.tokens?.scope,
    via: result?.via,
  });
} catch (err) {
  console.error('FAIL', err.message);
  process.exitCode = 1;
} finally {
  await closeLocalProxy().catch(() => {});
  db.close();
}
