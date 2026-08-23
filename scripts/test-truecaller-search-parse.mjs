import assert from 'node:assert/strict';
import { parseSearchHtml } from '../lib/truecaller/search.js';

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

console.log('truecaller search parse ok');
