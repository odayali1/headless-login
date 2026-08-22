import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseProxyUrl } from '../settings.js';
import { SEARCH_ORIGIN } from './config.js';
import { getAccount, getProxyUrl, upsertAccount } from './store.js';

const execFileAsync = promisify(execFile);

function proxyFlag(url) {
  const p = parseProxyUrl(url);
  const user = encodeURIComponent(p.username);
  const pass = encodeURIComponent(p.password);
  return `${p.protocol === 'socks5' ? 'socks5h' : 'http'}://${user}:${pass}@${p.host}:${p.port}`;
}

function encodeCookieValue(raw) {
  const s = String(raw || '');
  if (!s) return '';
  if (s.includes('%7B') || s.includes('%22') || /^[A-Za-z0-9._%-]+$/.test(s)) return s;
  return encodeURIComponent(s);
}

function cookieHeader(row) {
  const parts = [];
  if (row.tc_user_cookie) {
    parts.push(`tc_user=${encodeCookieValue(row.tc_user_cookie)}`);
  }
  try {
    const extra = JSON.parse(row.cookies_json || '[]');
    for (const c of extra) {
      if (!c?.name || c.name === 'tc_user') continue;
      parts.push(`${c.name}=${c.value}`);
    }
  } catch {
    // ignore
  }
  return parts.join('; ');
}

function decodeJwt(jwt) {
  try {
    const part = String(jwt).split('.')[1];
    const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (part.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function parseSearchHtml(html) {
  const text = String(html || '');
  const title =
    text.match(/property="og:title" content="([^"]+)"/)?.[1] ||
    text.match(/<title>([^<]+)<\/title>/)?.[1] ||
    null;
  const jsonLd = [...text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => {
      try {
        return JSON.parse(m[1]);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const nameGuess =
    jsonLd.find((j) => j?.name)?.name ||
    text.match(/"name"\s*:\s*"([^"\\]{2,80})"/)?.[1] ||
    null;
  return {
    title,
    name: nameGuess,
    jsonLd,
    bodyPreview: text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 800),
  };
}

function normalizePhone(country, number) {
  const cc = String(country || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .slice(0, 4);
  const num = String(number || '').replace(/[^\d]/g, '');
  if (!cc || cc.length !== 2) throw new Error('Country must be a 2-letter ISO code (e.g. jo, us, in).');
  if (!num || num.length < 6) throw new Error('Phone number looks too short.');
  return { cc, num };
}

export async function searchWithAccount(email, country, number) {
  const row = getAccount(email);
  if (!row?.tc_jwt && !row?.tc_user_cookie) {
    throw new Error('This email has no Truecaller token yet. Sign up first.');
  }
  const exp = Number(row.expires_at) || 0;
  const expMs = exp > 1e12 ? exp : exp * 1000;
  if (expMs && Date.now() > expMs) {
    throw new Error('Truecaller token expired. Run Sign up again (still will not touch Outlook).');
  }

  const proxyUrl = getProxyUrl();
  if (!proxyUrl) throw new Error('Truecaller proxy is not set.');
  const { cc, num } = normalizePhone(country || row.country_code, number);
  const url = `${SEARCH_ORIGIN}/search/${cc}/${num}`;
  const jwtPayload = decodeJwt(row.tc_jwt);
  const inner = row.tc_token || jwtPayload?.token || '';

  const headers = [
    'accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language: en-US,en;q=0.9',
    `referer: ${SEARCH_ORIGIN}/search/${cc}/${num}`,
    'upgrade-insecure-requests: 1',
    'user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  ];
  const headerArgs = headers.flatMap((h) => ['-H', h]);
  const cookie = cookieHeader(row);
  const { stdout, stderr } = await execFileAsync(
    'curl',
    [
      '-sS',
      '-L',
      '--max-redirs',
      '5',
      '-x',
      proxyFlag(proxyUrl),
      '-m',
      '35',
      '-w',
      '\n__HTTP__:%{http_code}',
      '-b',
      cookie,
      ...headerArgs,
      url,
    ],
    { timeout: 40_000, maxBuffer: 4_000_000 }
  );
  const raw = String(stdout || '');
  const httpLine = raw.match(/__HTTP__:(\d+)/)?.[1] || '';
  const html = raw.replace(/\n__HTTP__:\d+\s*$/, '');
  if (stderr && !html) throw new Error(String(stderr).slice(0, 240));

  const parsed = parseSearchHtml(html);
  upsertAccount(email, { status: row.status, last_search_at: new Date().toISOString() });

  return {
    ok: httpLine === '200' || httpLine === '',
    http: httpLine || null,
    url,
    country: cc,
    number: num,
    usedInnerToken: !!inner,
    result: parsed,
  };
}

export function getTokenPayload(email) {
  const row = getAccount(email);
  if (!row?.tc_jwt) return null;
  return {
    email: row.email,
    jwt: row.tc_jwt,
    innerToken: row.tc_token,
    tcUserCookie: row.tc_user_cookie,
    payload: decodeJwt(row.tc_jwt),
  };
}
