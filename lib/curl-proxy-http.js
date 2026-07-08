import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getProxyHttpUrl, getProxyUrl, isProxyEnabled, parseProxyUrl } from './settings.js';

const execFileAsync = promisify(execFile);

function httpProxyParsed() {
  const url = getProxyHttpUrl() || getProxyUrl();
  return parseProxyUrl(url);
}

function buildProxyFlag(parsed) {
  const user = encodeURIComponent(parsed.username);
  const pass = encodeURIComponent(parsed.password);
  return `http://${user}:${pass}@${parsed.host}:${parsed.port}`;
}

/**
 * POST form body through HTTP proxy via curl — works on iProxy Wi‑Fi Split when Playwright times out.
 */
export async function curlPostForm(url, body, headers = {}, timeoutMs = 25_000) {
  if (!isProxyEnabled()) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8', ...headers },
      body,
    });
    return res.json();
  }

  const parsed = httpProxyParsed();
  const proxy = buildProxyFlag(parsed);
  const sec = Math.max(5, Math.ceil(timeoutMs / 1000));
  const headerArgs = Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);
  const { stdout } = await execFileAsync(
    'curl',
    ['-sS', '-x', proxy, '-m', String(sec), '-X', 'POST', ...headerArgs, '--data-binary', body, url],
    { timeout: timeoutMs + 5_000, maxBuffer: 2 * 1024 * 1024 }
  );
  const text = stdout.trim();
  if (!text) return { error: 'curl_empty', error_description: 'Empty response from token endpoint' };
  try {
    return JSON.parse(text);
  } catch {
    return { error: 'curl_parse', error_description: text.slice(0, 200) };
  }
}
