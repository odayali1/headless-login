/**
 * Local FireProx / AWS API Gateway probe.
 *
 *   node scripts/test-aws-api-proxy.mjs
 */
import { BUILT_IN_FIREPROX_APIS, getFireproxUrlForOrigin, rewriteThroughFireprox } from '../lib/fireprox.js';
import { startFireproxLocalProxy, stopFireproxLocalProxy } from '../lib/fireprox-local-proxy.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const curlBin = process.platform === 'win32' ? 'curl.exe' : 'curl';

async function curl(args, timeoutSec = 25) {
  const { stdout } = await execFileAsync(curlBin, args, {
    timeout: (timeoutSec + 5) * 1000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return String(stdout || '');
}

function snippet(text, n = 220) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
}

console.log('=== Built-in FireProx APIs ===');
for (const row of BUILT_IN_FIREPROX_APIS) {
  console.log(`  ${row.origin} → ${row.proxyUrl}`);
}

const ipify = BUILT_IN_FIREPROX_APIS.find((r) => r.origin.includes('ipify'));
console.log('\n=== ipify IP rotation (direct FireProx) ===');
const ips = [];
for (let i = 0; i < 5; i++) {
  const ip = (
    await curl(['-sS', '-m', '20', rewriteThroughFireprox(ipify.proxyUrl, 'https://api.ipify.org/')])
  ).trim();
  ips.push(ip);
  console.log(`  ${i + 1}: ${ip}`);
}
console.log(`Unique IPs: ${new Set(ips).size}/${ips.length}`);

console.log('\n=== login.live.com (direct FireProx) ===');
const live = await curl(['-sS', '-m', '25', '-w', '\nHTTP %{http_code}', 'https://m6m8tzyruf.execute-api.us-east-1.amazonaws.com/fireprox/']);
console.log(snippet(live, 280));

console.log('\n=== Local CONNECT proxy ===');
try {
  const local = await startFireproxLocalProxy();
  console.log('Local:', local);

  const viaProxyIps = [];
  for (let i = 0; i < 3; i++) {
    const ip = (await curl(['-sS', '-k', '-m', '25', '-x', local, 'https://api.ipify.org/'])).trim();
    viaProxyIps.push(ip);
    console.log(`  ipify via local: ${ip}`);
  }

  const liveLocal = await curl([
    '-sS',
    '-k',
    '-m',
    '30',
    '-x',
    local,
    '-o',
    'NUL',
    '-w',
    'HTTP %{http_code} size=%{size_download}',
    'https://login.live.com/',
  ]);
  console.log(`  login.live.com via local: ${liveLocal}`);
} finally {
  await stopFireproxLocalProxy({ force: true });
}

const mapped = await getFireproxUrlForOrigin('https://login.live.com');
console.log('\nMapped login.live.com →', mapped);
console.log('Done.');
