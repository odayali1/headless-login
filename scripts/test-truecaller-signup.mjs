/**
 * Isolated Truecaller Microsoft SSO test.
 * Does NOT open the Outlook Camoufox profile and does NOT write Outlook cookies.
 *
 *   node scripts/test-truecaller-signup.mjs [email]
 *   node scripts/test-truecaller-signup.mjs --search jo 795910089 [email]
 */
import { setProxyUrl, getProxyUrl } from '../lib/truecaller/store.js';
import { signupMicrosoftAccount } from '../lib/truecaller/signup.js';
import { searchWithAccount } from '../lib/truecaller/search.js';
import { readOutlookSso } from '../lib/truecaller/cookies.js';
import fs from 'node:fs';
import path from 'node:path';

const TEST_PROXY = process.env.TRUECALLER_PROXY_URL || getProxyUrl();
if (!TEST_PROXY) {
  console.error('Set TRUECALLER_PROXY_URL or save the proxy on the Truecaller tab first.');
  process.exit(1);
}
if (!getProxyUrl()) setProxyUrl(TEST_PROXY);

const args = process.argv.slice(2);
const searchMode = args[0] === '--search';

function pickEmail() {
  const explicit = searchMode ? args[3] : args[0];
  if (explicit) return explicit;
  const dir = path.join(process.env.DATA_DIR || './data', 'profiles');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('-outlook.json'));
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (d.email) return d.email;
    } catch {
      // skip
    }
  }
  return null;
}

const email = pickEmail();
if (!email) {
  console.error('No Outlook profile email found');
  process.exit(1);
}

if (searchMode) {
  const country = args[1] || 'jo';
  const number = args[2];
  if (!number) {
    console.error('Usage: node scripts/test-truecaller-signup.mjs --search jo 795910089 [email]');
    process.exit(1);
  }
  const result = await searchWithAccount(email, country, number);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const sso = await readOutlookSso(email);
console.log('email', email);
console.log('sso_ok', sso.ok, 'cookies', sso.cookies.length, 'reason', sso.reason || 'ok');
if (!sso.ok) process.exit(1);

const result = await signupMicrosoftAccount(email, {
  jobId: 'cli-test',
  log: (step, message) => console.log(`[${step}] ${message}`),
});
console.log('RESULT', {
  email: result.email,
  name: result.name,
  tcEmail: result.tcEmail,
  countryCode: result.countryCode,
  hasJwt: !!result.jwt,
  hasInnerToken: !!result.innerToken,
});
