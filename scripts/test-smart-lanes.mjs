/**
 * Unit test: lane split must keep dead-RT accounts out of the HTTP fast lane.
 * Run: node scripts/test-smart-lanes.mjs
 */
import { partitionDueForLanes } from '../lib/smart-refresh.js';
import { ACCOUNTS_PER_IP } from '../lib/settings.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const eligible = [
  { email: 'a@test.com', target: 'outlook', expiresSoon: true, httpRefreshRejected: true },
  { email: 'b@test.com', target: 'outlook', expiresSoon: true, httpRefreshRejected: false },
  { email: 'c@test.com', target: 'outlook', expiresSoon: false, httpRefreshRejected: false },
  { email: 'd@test.com', target: 'outlook', expiresSoon: true, httpRefreshRejected: true },
];

const { httpLane, camoufoxOnly } = partitionDueForLanes(eligible);

assert(httpLane.length === 2, `expected 2 HTTP, got ${httpLane.length}`);
assert(camoufoxOnly.length === 2, `expected 2 Camoufox-only, got ${camoufoxOnly.length}`);
assert(
  httpLane.every((a) => !a.httpRefreshRejected),
  'HTTP lane must not include rejected RTs'
);
assert(
  camoufoxOnly.every((a) => a.httpRefreshRejected),
  'Camoufox-only lane must be rejected RTs'
);
assert(httpLane.map((a) => a.email).join(',') === 'b@test.com,c@test.com', 'HTTP order');
assert(camoufoxOnly.map((a) => a.email).join(',') === 'a@test.com,d@test.com', 'Camoufox order');
assert(ACCOUNTS_PER_IP === 10, `ACCOUNTS_PER_IP should be 10, got ${ACCOUNTS_PER_IP}`);

console.log('OK lane split + rotate-every-10 defaults');
console.log(JSON.stringify({ httpLane: httpLane.map((a) => a.email), camoufoxOnly: camoufoxOnly.map((a) => a.email), ACCOUNTS_PER_IP }, null, 2));
