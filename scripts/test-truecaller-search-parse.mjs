import assert from 'node:assert/strict';
import { parseSearchHtml, buildSearchCookieHeader, playwrightTcCookies } from '../lib/truecaller/search.js';

const html = `
<title>Free Reverse Phone Number Lookup by Truecaller</title>
<meta property="og:title" content="Free Reverse Phone Number Lookup by Truecaller">
<button>Log out</button>
<script>userState</script>
<article>
  <div class="flex-none font-bold break-all sm:text-xl" data-astro-cid-vtzuftsq> Test Person  </div>
  <a download="test-person.vcf" href="data:text/vcard;charset=utf-8,BEGIN%3AVCARD%0D%0AVERSION%3A3.0%0D%0AN%3A%20Person%3BTest%0D%0AFN%3A%20Test%20Person%0D%0ATEL%3BTYPE%3Dcell%3A%20%2B962700000000%0D%0AEMAIL%3A%20test%40example.com%0D%0AEND%3AVCARD">Save</a>
  <a href="tel://+962700000000"><div class="mb-1 text-xs">M - Zain</div><div class="flex gap-2 text-sm font-semibold">07 0000 0000</div></a>
  <a href="https://www.google.com/maps?q=Jordan"><div class="mb-1 text-xs">Address</div><div class="flex gap-2 text-sm font-semibold">Jordan</div></a>
  <a href="mailto://test@example.com">Email</a>
</article>
`;

const parsed = parseSearchHtml(html);
assert.equal(parsed.found, true);
assert.equal(parsed.name, 'Test Person');
assert.equal(parsed.email, 'test@example.com');
assert.equal(parsed.phone, '+962700000000');
assert.equal(parsed.carrier, 'M - Zain');
assert.equal(parsed.address, 'Jordan');
assert.equal(parsed.signedIn, true);
assert.equal(parsed.limitExceeded, false);

const empty = parseSearchHtml(
  '<title>Free Reverse Phone Number Lookup by Truecaller</title><nav>Android app Sign in Afghanistan Albania</nav>'
);
assert.equal(empty.found, false);
assert.equal(empty.name, null);

const cmsOnlyLimit = parseSearchHtml(`
<title>Free Reverse Phone Number Lookup by Truecaller</title>
<button>Log out</button>
<astro-island props="{&quot;limit_exceeded_header_text&quot;:[1,[[0,{&quot;text&quot;:[0,&quot;Oops! Search limit exceeded.&quot;]}]]]}" opts="{&quot;name&quot;:&quot;X&quot;}"></astro-island>
<article>
  <div class="flex-none font-bold break-all sm:text-xl"> Found Name </div>
  <a href="data:text/vcard;charset=utf-8,BEGIN%3AVCARD%0D%0AFN%3A%20Found%20Name%0D%0AEND%3AVCARD">Save contact</a>
</article>
`);
assert.equal(cmsOnlyLimit.limitExceeded, false, 'CMS copy is not a real limit');
assert.equal(cmsOnlyLimit.found, true);
assert.equal(cmsOnlyLimit.name, 'Found Name');

const encodedOnly = parseSearchHtml(
  'nav Save contact href="data:text/vcard;charset=utf-8,BEGIN%3AVCARD%0D%0AFN%3A%20Found%20Name%0D%0AEND%3AVCARD"'
);
assert.equal(encodedOnly.found, true);
assert.equal(encodedOnly.name, 'Found Name');

const realLimit = parseSearchHtml(`
<title>Free Reverse Phone Number Lookup by Truecaller</title>
<main><h3>Oops! Search limit exceeded.</h3><p>Download Truecaller</p></main>
`);
assert.equal(realLimit.limitExceeded, true);
assert.equal(realLimit.found, false);

const cookie = buildSearchCookieHeader({
  tc_jwt: 'aaa.bbb.ccc',
  tc_user_cookie: '',
  cookies_json: '[]',
});
assert.equal(cookie, 'tc_user=' + encodeURIComponent(JSON.stringify({ token: 'aaa.bbb.ccc' })));
assert.ok(cookie.includes('%7B%22token%22%3A%22aaa.bbb.ccc%22%7D'));

const pw = playwrightTcCookies({
  tc_jwt: 'aaa.bbb.ccc',
  tc_user_cookie: '',
  cookies_json: JSON.stringify([{ name: 'tc_foo', value: '1', domain: '.truecaller.com', path: '/' }]),
});
assert.ok(pw.every((c) => (c.url && !c.path && !c.domain) || (c.domain && c.path && !c.url)));

console.log('truecaller search parse ok');
