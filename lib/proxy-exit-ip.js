/**
 * Resolve the public exit IP through the active proxy.
 * Supports IPv4 + IPv6 (residential rotating exits are often IPv6-only).
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
  // Strip zone id / brackets
  const bare = ip.replace(/^\[/, '').replace(/\]$/, '').split('%')[0];
  if (bare.includes(':') && IPV6_RE.test(bare) && bare.length >= 3) return bare;
  return null;
}

function upstreamProxyArg() {
  const parsed = parseProxyUrl(getProxyUrl());
  const user = encodeURIComponent(parsed.username);
  const pass = encodeURIComponent(parsed.password);
  if (parsed.protocol === 'http' || parsed.protocol === 'https') {
    return `http://${user}:${pass}@${parsed.host}:${parsed.port}`;
  }
  return `socks5h://${user}:${pass}@${parsed.host}:${parsed.port}`;
}

async function curlThroughProxy(url, timeoutSec = 15) {
  const { stdout } = await execFileAsync(
    curlBin(),
    ['-sS', '-x', upstreamProxyArg(), '-m', String(timeoutSec), url],
    { timeout: (timeoutSec + 5) * 1000 }
  );
  return normalizeIp(stdout);
}

/** @returns {Promise<string|null>} IPv4 or IPv6 exit address */
export async function probeExitIp() {
  try {
    parseProxyUrl(getProxyUrl());
  } catch {
    return null;
  }

  for (const url of IP_URLS) {
    try {
      const ip = await curlThroughProxy(url);
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
  const s = String(ip || '');
  return s.includes(':') && !!normalizeIp(s);
}
