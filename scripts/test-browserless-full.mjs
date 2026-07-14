/** Exercise tryAllBrowserlessRefresh (Loki + cookie PKCE) on a local profile. */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSettings, bindSettingsStore } from '../lib/settings.js';
import { tryAllBrowserlessRefresh } from '../lib/token-extract.js';
import { closeLocalProxy } from '../lib/proxy-local.js';

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

const email = process.argv[2] || 'AikinsBureau123@outlook.com';
const saved = JSON.parse(
  fs.readFileSync(path.join(process.env.DATA_DIR || './data', 'profiles', `${email}-outlook.json`), 'utf8')
);
// Simulate Camoufox-only account
saved.httpRefreshRejectedAt = saved.httpRefreshRejectedAt || new Date().toISOString();

const db = new Database(path.join(process.env.DATA_DIR || './data', 'app.db'));
bindSettingsStore(initSettings(db));

const t0 = Date.now();
const result = await tryAllBrowserlessRefresh(saved, (step, msg) => console.log(`[${step}] ${msg}`), {
  forceRefresh: true,
});
console.log('RESULT', {
  ok: !!result.tokens?.access_token,
  via: result.via,
  hasRT: !!result.tokens?.refresh_token,
  expires_at: result.tokens?.expires_at,
  ms: Date.now() - t0,
  refreshTokenKnownBad: result.refreshTokenKnownBad,
});
await closeLocalProxy().catch(() => {});
db.close();
