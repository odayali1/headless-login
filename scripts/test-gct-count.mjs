#!/usr/bin/env node
/** Count GetCredentialType requests during one forceFresh email attempt. */
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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}
loadEnv();
process.env.DATA_DIR = process.env.DATA_DIR || './data';
process.env.PROXY_ROTATE_WAIT_MS = '10000';

const Database = (await import('better-sqlite3')).default;
const { getAccountPasswordWithFallback } = await import('../lib/db.js');
const { rotateProxyIp, beforeAccountLogin } = await import('../lib/proxy.js');
const { connectBrowser } = await import('../lib/browser.js');
const { TARGETS } = await import('../lib/microsoft-login.js');

const db = new Database('data/app.db', { readonly: true });
const row = db.prepare(`select email, target from accounts where length(password_enc)>0 limit 1`).get();
db.close();
const email = row.email;
const password = getAccountPasswordWithFallback(email, row.target);
const config = TARGETS.outlook;

const log = (s, m) => console.log(`[${s}] ${m}`);
await rotateProxyIp(log, { force: true });
await beforeAccountLogin(log);

const session = await connectBrowser({
  email,
  target: 'outlook',
  fingerprint: null,
  saved: null,
  forceFresh: true,
});
const page = session.page;
const hits = [];
page.on('request', (req) => {
  if (/GetCredentialType/i.test(req.url())) {
    hits.push({ t: Date.now(), type: 'req', url: req.url().slice(0, 80) });
    console.log(`[GCT#${hits.length}] REQUEST`);
  }
});
page.on('response', (res) => {
  if (/GetCredentialType/i.test(res.url())) {
    console.log(`[GCT] RESPONSE status=${res.status()}`);
  }
});

console.log('[test] Opening login…');
await page.goto(config.loginUrl || config.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(2000);
console.log(`[test] After page load: ${hits.length} GetCredentialType request(s)`);

const input = page.locator('#usernameEntry, #i0116, input[name="loginfmt"], input[type="email"]').first();
await input.waitFor({ state: 'visible', timeout: 20_000 });
await input.fill(email);
await page.waitForTimeout(1000);
console.log(`[test] After fill(): ${hits.length} GetCredentialType request(s)`);

await page.locator('button[data-testid="primaryButton"], input[type="submit"], #idSIButton9').first().click({ noWaitAfter: true });
await page.waitForTimeout(5000);
console.log(`[test] After Next: ${hits.length} GetCredentialType request(s)`);
console.log('[test] Hits:', hits.length);
await session.close().catch(() => {});
process.exit(hits.length > 3 ? 2 : 0);
