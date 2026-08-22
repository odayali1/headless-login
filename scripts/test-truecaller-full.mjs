/**
 * Full isolated Truecaller workflow:
 * Microsoft sign-in (optional password) → Truecaller token → search.
 * Never writes Outlook profiles.
 *
 *   TRUECALLER_TEST_EMAIL=... TRUECALLER_TEST_PASSWORD=... TRUECALLER_PROXY_URL=... \
 *     node scripts/test-truecaller-full.mjs
 *   node scripts/test-truecaller-full.mjs --search jo 795910089
 */
import { setProxyUrl, getProxyUrl, getAccount } from '../lib/truecaller/store.js';
import { signupMicrosoftAccount } from '../lib/truecaller/signup.js';
import { searchWithAccount } from '../lib/truecaller/search.js';

const proxy = process.env.TRUECALLER_PROXY_URL || getProxyUrl();
if (!proxy) {
  console.error('Need TRUECALLER_PROXY_URL or a proxy saved on the Truecaller tab.');
  process.exit(1);
}
if (!getProxyUrl()) setProxyUrl(proxy);
else if (process.env.TRUECALLER_PROXY_URL) setProxyUrl(process.env.TRUECALLER_PROXY_URL);

const args = process.argv.slice(2);
const searchOnly = args[0] === '--search';
const email = process.env.TRUECALLER_TEST_EMAIL || args[searchOnly ? 3 : 0];
const password = process.env.TRUECALLER_TEST_PASSWORD || '';

if (searchOnly) {
  const country = args[1] || 'jo';
  const number = args[2];
  const who = email || getAccount(process.env.TRUECALLER_TEST_EMAIL || '')?.email;
  if (!who || !number) {
    console.error('Usage: node scripts/test-truecaller-full.mjs --search jo 795910089 [email]');
    process.exit(1);
  }
  const result = await searchWithAccount(who, country, number);
  console.log(JSON.stringify({ ok: result.ok, http: result.http, url: result.url, result: result.result }, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (!email) {
  console.error('Set TRUECALLER_TEST_EMAIL');
  process.exit(1);
}

console.log('email', email);
console.log('password', password ? 'yes (isolated browser only)' : 'no');
console.log('proxy', new URL(proxy.includes('://') ? proxy : `http://${proxy}`).host);

const signup = await signupMicrosoftAccount(email, {
  jobId: 'full-test',
  password,
  log: (step, message) => console.log(`[${step}] ${message}`),
});

console.log('SIGNUP', {
  email: signup.email,
  name: signup.name,
  tcEmail: signup.tcEmail,
  countryCode: signup.countryCode,
  hasJwt: !!signup.jwt,
  jwtPreview: signup.jwt ? `${signup.jwt.slice(0, 36)}…` : null,
  innerTokenPreview: signup.innerToken ? `${String(signup.innerToken).slice(0, 24)}…` : null,
});

const country = process.env.TRUECALLER_SEARCH_COUNTRY || 'jo';
const number = process.env.TRUECALLER_SEARCH_NUMBER || '795910089';
console.log('SEARCH', country, number);
const search = await searchWithAccount(email, country, number);
console.log(JSON.stringify({ ok: search.ok, http: search.http, url: search.url, result: search.result }, null, 2));
