import assert from 'node:assert/strict';
import { extractSsoCookies, toPlaywrightCookies, isLiveTicketCookie } from '../lib/truecaller/cookies.js';

const src = [
  {
    name: 'MSPAuth',
    value: 'Disabled',
    domain: '.live.com',
    path: '/',
    expires: 1817914717,
    httpOnly: true,
    secure: true,
    sameSite: 'None',
  },
  {
    name: '__Host-MSAAUTH',
    value: 'ticket',
    domain: 'login.live.com',
    path: '/',
    expires: 0,
    httpOnly: true,
    secure: true,
    sameSite: 'None',
  },
  {
    name: 'MUID',
    value: 'abc',
    domain: '.live.com',
    path: '/',
    expires: 1817914717,
    httpOnly: false,
    secure: true,
    sameSite: 'None',
  },
];

const extracted = extractSsoCookies(src);
assert.equal(extracted.names.has('MSPAuth'), false, 'Disabled MSPAuth is not a ticket');
assert.equal(extracted.names.has('__Host-MSAAUTH'), true);
assert.equal(extracted.cookies.some(isLiveTicketCookie), true);

const keep = toPlaywrightCookies(extracted.cookies, { hostPrefix: 'keep' });
assert.ok(!keep.cookies.some((c) => c.name === 'MSPAuth'));
const host = keep.cookies.find((c) => c.name === '__Host-MSAAUTH');
assert.ok(host, '__Host-MSAAUTH kept');
assert.equal(host.domain, 'login.live.com');
assert.equal(host.url, undefined);
assert.equal(host.expires, -1);
assert.equal(keep.cookies.filter((c) => c.name === '__Host-MSAAUTH').length, 1, 'no duplicate tickets');

const urlShape = toPlaywrightCookies(extracted.cookies, { hostPrefix: 'url' });
const hostUrl = urlShape.cookies.find((c) => c.name === '__Host-MSAAUTH');
assert.equal(hostUrl.domain, undefined);
assert.equal(hostUrl.url, 'https://login.live.com/');
assert.equal(hostUrl.secure, true);
assert.equal(hostUrl.path, '/');

console.log('truecaller cookie conversion ok');
