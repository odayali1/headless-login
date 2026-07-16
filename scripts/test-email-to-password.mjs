/**
 * Minimal local proof: rotate → wait → email→password only (no full token).
 * Usage: node scripts/test-email-to-password.mjs email password
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function loadEnv() {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}
loadEnv();
process.env.DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');

const email = process.argv[2];
const password = process.argv[3];
if (!email || !password) {
  console.error('Usage: node scripts/test-email-to-password.mjs email password');
  process.exit(1);
}

const { rotateProxyIp, beforeAccountLogin, endLoginProxyExclusive } = await import('../lib/proxy.js');
const { loginMicrosoft } = await import('../lib/microsoft-login.js');

const log = (s, m) => console.log(`[${s}] ${m}`);
console.log('[test] Rotating IP…');
await rotateProxyIp(log, { force: true });
console.log('[test] Waiting 15s for proxy/IP settle (pause Coolify login/refresh if sharing this proxy)…');
await new Promise((r) => setTimeout(r, 15_000));
await beforeAccountLogin(log);

let hitPassword = false;
try {
  const result = await loginMicrosoft({
    email,
    password,
    target: 'outlook',
    engine: 'camoufox',
    forceFresh: true,
    skipBackupEmail: true,
    jobId: 'email-pwd-proof',
    onProgress: ({ step, message }) => {
      console.log(`[job] [${step}] ${message}`);
      if (step === 'password') hitPassword = true;
    },
    onEmailRetry: async () => {},
  });
  console.log(
    JSON.stringify(
      {
        hitPassword,
        status: result?.status,
        hasToken: !!result?.accessToken,
        message: result?.message,
      },
      null,
      2
    )
  );
  process.exit(hitPassword || result?.status === 'success' ? 0 : 2);
} catch (err) {
  // Navigation can destroy the page during post-password verify — email→password is the proof.
  if (hitPassword) {
    console.log(JSON.stringify({ hitPassword: true, note: 'password reached; later nav race ignored', error: err.message }, null, 2));
    process.exit(0);
  }
  console.error('FAIL', err.message, { hitPassword });
  process.exit(1);
} finally {
  endLoginProxyExclusive();
}
