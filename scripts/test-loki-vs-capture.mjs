/**
 * Local check: Loki RT exchange + cookie PKCE (TokenMan / roadtx paths).
 * Usage: node scripts/test-loki-vs-capture.mjs [email]
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSettings, bindSettingsStore } from '../lib/settings.js';
import {
  tryLokiScopeRedeem,
  tryCookiePkceAuthCode,
  isLiveProfileCardToken,
  isTokenValid,
} from '../lib/token-extract.js';
import { closeLocalProxy } from '../lib/proxy-local.js';

function loadEnv() {
  try {
    for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || process.env[m[1]]) continue;
      let v = m[2];
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  } catch {
    // optional
  }
}

function loadProfile(emailWant) {
  const dir = 'data/profiles';
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const email = p.email || p.state?.email || f;
    if (emailWant && email.toLowerCase() !== emailWant.toLowerCase()) continue;
    const tokens = p.tokens || p.state?.tokens || null;
    const cookies = p.cookies || p.state?.cookies || [];
    if (tokens?.refresh_token) return { email, tokens, cookies, file: f };
  }
  return null;
}

loadEnv();
const db = new Database('data/app.db');
initSettings(db);
bindSettingsStore({
  get: (k) => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value,
  set() {},
  has: (k) => !!db.prepare('SELECT 1 FROM settings WHERE key=?').get(k),
});

const want = process.argv[2] || null;
const picked = loadProfile(want);
if (!picked) {
  console.error('No profile with refresh_token found');
  process.exit(1);
}

const log = (step, msg) => console.log(`[${step}] ${msg}`);
console.log('Profile:', picked.email, 'cookies=', picked.cookies.length);

const t0 = Date.now();
const loki = await tryLokiScopeRedeem(picked.tokens.refresh_token, log);
console.log('LOKI', {
  ok: !!(loki?.access_token && isLiveProfileCardToken(loki) && isTokenValid(loki)),
  ms: Date.now() - t0,
  scope: String(loki?.scope || '').slice(0, 90),
  hasRt: !!loki?.refresh_token,
  error: loki?.error || null,
});

const t1 = Date.now();
const pkce = await tryCookiePkceAuthCode({ cookies: picked.cookies }, log);
console.log('COOKIE_PKCE', {
  ok: !!(pkce?.access_token && isLiveProfileCardToken(pkce) && isTokenValid(pkce)),
  ms: Date.now() - t1,
  hasRt: !!pkce?.refresh_token,
});

await closeLocalProxy().catch(() => {});
db.close();
