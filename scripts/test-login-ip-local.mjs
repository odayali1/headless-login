#!/usr/bin/env node
/**
 * Local smoke test: rotate wait + one Camoufox Outlook login (no smart-refresh).
 *
 *   node scripts/test-login-ip-local.mjs [email] [password]
 *
 * If email/password omitted, uses first account with a stored password in local DB.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function loadEnv() {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    process.env[m[1]] = v;
  }
}

loadEnv();
process.env.PROXY_ROTATE_WAIT_MS = process.env.PROXY_ROTATE_WAIT_MS || '10000';
process.env.PROXY_ROTATE_WAIT_MIN_MS = process.env.PROXY_ROTATE_WAIT_MIN_MS || '8000';
process.env.DATA_DIR = process.env.DATA_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

const { rotateProxyIp, beforeAccountLogin, afterAccountLoginSuccess } = await import('../lib/proxy.js');
const { loginMicrosoft } = await import('../lib/microsoft-login.js');
const { getAccountPassword, listAccountEmails } = await import('../lib/db.js').catch(() => ({}));

function log(step, message) {
  console.log(`[${step}] ${message}`);
}

let email = process.argv[2];
let password = process.argv[3];

if (!email || !password) {
  try {
    const Database = (await import('better-sqlite3')).default;
    const { getAccountPasswordWithFallback } = await import('../lib/db.js');
    const db = new Database(path.join(process.env.DATA_DIR, 'app.db'), { readonly: true });
    const rows = db
      .prepare(
        `select email, target from accounts
         where password_enc is not null and length(password_enc) > 0
         limit 40`
      )
      .all();
    db.close();
    for (const row of rows) {
      const pw = getAccountPasswordWithFallback(row.email, row.target || 'outlook');
      if (pw) {
        email = row.email;
        password = pw;
        console.log(`[test] Using stored credentials for ${email}`);
        break;
      }
    }
  } catch (err) {
    console.error('[test] Could not load DB credentials:', err.message);
  }
}

if (!email || !password) {
  console.error('Usage: node scripts/test-login-ip-local.mjs <email> <password>');
  process.exit(1);
}

console.log('[test] Step 1 — rotate IP (expect ~10s wait)…');
const t0 = Date.now();
const rot = await rotateProxyIp(log, { force: true });
const rotateSec = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`[test] Rotate result: ${JSON.stringify(rot)} in ${rotateSec}s`);
if (!rot?.rotated) {
  console.error('[test] FAIL — rotate did not change IP');
  process.exit(2);
}

console.log('[test] Step 2 — Camoufox login (smart-refresh NOT running)…');
await beforeAccountLogin(log);
const result = await loginMicrosoft({
  email,
  password,
  target: 'outlook',
  engine: 'camoufox',
  forceFresh: true,
  jobId: 'local-test',
  onProgress: ({ step, message }) => console.log(`[job:${email}] [${step}] ${message}`),
  onEmailRetry: async (attempt, { reason } = {}) => {
    if (reason !== 'throttled' && reason !== 'lookup_failed') return { rotated: false };
    console.log(`[test] Email retry ${attempt} reason=${reason} — force rotate`);
    return rotateProxyIp(log, { force: true });
  },
});

const gctOk = result?.success || result?.status === 'success';
const hitEmailStep = true; // forceFresh always goes through GetCredentialType path

if (gctOk && result?.hasToken) {
  await afterAccountLoginSuccess();
  console.log('[test] SUCCESS — fresh login + token OK');
  console.log(JSON.stringify({ success: true, email, hasToken: true }, null, 2));
  process.exit(0);
}

if (gctOk && !result?.accessToken && result?.reusedProfile) {
  console.log('[test] PARTIAL — session reused (unexpected with forceFresh)');
}

console.error('[test] Result (check GetCredentialType lines above for 429)');
console.error(JSON.stringify({
  status: result?.status,
  message: result?.message,
  hasToken: !!result?.accessToken,
  reusedProfile: !!result?.reusedProfile,
}, null, 2));
process.exit(result?.accessToken ? 0 : 3);
