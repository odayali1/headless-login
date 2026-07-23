/**
 * Resolve the public exit IP through the active proxy.
 * Supports IPv4 + IPv6 (residential rotating exits are often IPv6-only).
 * Pass playwrightProxy to probe through a dedicated login relay (same path Camoufox uses).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getProxyUrl, parseProxyUrl } from './settings.js';

const execFileAsync = promisify(execFile);

const IPV4_RE = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

const IP_URLS = [
  'https://api64.ipify.org',
  'https://api.ipify.org',
  'https://icanhazip.com',
  'https://ifconfig.co/ip',
  'https://checkip.amazonaws.com',
  'https://ipecho.net/plain',
];

function curlBin() {
  return process.platform === 'win32' ? 'curl.exe' : 'curl';
}

function normalizeIp(raw) {
  const ip = String(raw || '')
    .trim()
    .replace(/^::ffff:/i, '');
  if (IPV4_RE.test(ip)) return ip;
  const bare = ip.replace(/^\[/, '').replace(/\]$/, '').split('%')[0];
  if (bare.includes(':') && IPV6_RE.test(bare) && bare.length >= 3) return bare;
  return null;
}

function upstreamProxyArg(url = getProxyUrl()) {
  const parsed = parseProxyUrl(url);
  const user = encodeURIComponent(parsed.username);
  const pass = encodeURIComponent(parsed.password);
  if (parsed.protocol === 'http' || parsed.protocol === 'https') {
    return `http://${user}:${pass}@${parsed.host}:${parsed.port}`;
  }
  return `socks5h://${user}:${pass}@${parsed.host}:${parsed.port}`;
}

/** Build curl -x target from Playwright proxy opts (dedicated local relay or HTTP auth). */
function playwrightProxyArg(playwrightProxy) {
  if (!playwrightProxy?.server) return upstreamProxyArg();
  const server = String(playwrightProxy.server);
  if (playwrightProxy.username != null && playwrightProxy.password != null) {
    const u = encodeURIComponent(playwrightProxy.username);
    const p = encodeURIComponent(playwrightProxy.password);
    const bare = server.replace(/^https?:\/\//i, '');
    return `http://${u}:${p}@${bare}`;
  }
  // Local anonymized relay is already an open HTTP proxy without auth.
  return server;
}

async function curlThroughProxyArg(proxyArg, url, timeoutSec = 15) {
  const { stdout } = await execFileAsync(
    curlBin(),
    ['-sS', '-x', proxyArg, '-m', String(timeoutSec), url],
    { timeout: (timeoutSec + 5) * 1000 }
  );
  return normalizeIp(stdout);
}

/**
 * @param {{ playwrightProxy?: { server: string, username?: string, password?: string } }} [opts]
 * @returns {Promise<string|null>}
 */
export async function probeExitIp(opts = {}) {
  const proxyArg = opts.playwrightProxy ? playwrightProxyArg(opts.playwrightProxy) : upstreamProxyArg();
  try {
    if (!opts.playwrightProxy) parseProxyUrl(getProxyUrl());
  } catch {
    return null;
  }

  for (const url of IP_URLS) {
    try {
      const ip = await curlThroughProxyArg(proxyArg, url);
      if (ip) return ip;
    } catch {
      // try next
    }
  }
  return null;
}

export function isIpv4(ip) {
  return IPV4_RE.test(String(ip || ''));
}

export function isIpv6(ip) {
  return String(ip || '').includes(':') && !IPV4_RE.test(String(ip || ''));
}
