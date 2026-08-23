import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SEARCH_ORIGIN } from './config.js';
import { getAccount, upsertAccount } from './store.js';

const execFileAsync = promisify(execFile);

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeMaybe(s) {
  const raw = String(s || '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function tcUserCookiePair(row) {
  const stored = decodeMaybe(row.tc_user_cookie || '');
  const jwt = row.tc_jwt || '';
  let token = jwt;
  if (stored.startsWith('{')) {
    try {
      const obj = JSON.parse(stored);
      token = obj.token || obj.accessToken || jwt || stored;
    } catch {
      token = jwt || stored;
    }
  } else if (stored.includes('.')) {
    token = stored;
  }
  if (!token) return '';
  const value = token.startsWith('{') ? token : JSON.stringify({ token });
  return `tc_user=${encodeURIComponent(value)}`;
}

function cookieHeader(row) {
  const parts = [];
  const tcUser = tcUserCookiePair(row);
  if (tcUser) parts.push(tcUser);
  try {
    const extra = JSON.parse(row.cookies_json || '[]');
    for (const c of extra) {
      if (!c?.name || c.name === 'tc_user') continue;
      if (/^tc:?searches$/i.test(c.name)) continue;
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

function stripCmsProps(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/\sprops="[^"]*"/gi, '')
    .replace(/\sopts="[^"]*"/gi, '');
}

function parseVcard(html) {
  const href = String(html || '').match(/href="data:text\/vcard[^"]+"/i)?.[0];
  if (!href) return {};
  let raw = href.replace(/^href="/i, '').replace(/"$/, '');
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // keep
  }
  return {
    name: decodeEntities(raw.match(/^FN:(.+)$/im)?.[1] || ''),
    phone: decodeEntities(raw.match(/^TEL[^:]*:(.+)$/im)?.[1] || ''),
    email: decodeEntities(raw.match(/^EMAIL:(.+)$/im)?.[1] || ''),
  };
}

function parseEncodedFn(html) {
  const m = String(html || '').match(/FN%3A%20([^&"']+)/i);
  if (!m) return '';
  try {
    return decodeEntities(decodeURIComponent(m[1]));
  } catch {
    return decodeEntities(m[1].replace(/%20/g, ' '));
  }
}
function looksLikePersonName(name) {
  const n = String(name || '').trim();
  if (n.length < 2 || n.length > 80) return false;
  if (/@/.test(n)) return false;
  if (
    /truecaller|lookup|sign in|log out|advertisement|download|premium|community|android app|iphone/i.test(
      n
    )
  ) {
    return false;
  }
  return true;
}

export function parseSearchHtml(html) {
  const text = String(html || '');
  const visible = stripCmsProps(text);
  const vcard = parseVcard(text);
  const cardBlock = visible.match(/class="[^"]*font-bold[^"]*break-all[^"]*"[^>]*>([\s\S]{1,120}?)<\/div>/i)?.[1] || '';
  const cardName = decodeEntities(cardBlock.replace(/<[^>]+>/g, ' '));
  const encodedName = parseEncodedFn(text);
  const name = looksLikePersonName(vcard.name)
    ? vcard.name
    : looksLikePersonName(encodedName)
      ? encodedName
      : looksLikePersonName(cardName)
        ? cardName
        : null;
  const email =
    vcard.email ||
    decodeEntities(visible.match(/mailto:\/\/([^"'<\s]+)/i)?.[1] || '') ||
    null;
  const phone =
    vcard.phone ||
    decodeEntities(visible.match(/tel:\/\/(\+?[\d]+)/i)?.[1] || '') ||
    null;
  const carrier =
    decodeEntities(
      visible.match(
        /<div class="mb-1 text-xs">([^<]{1,40})<\/div>\s*<div class="flex gap-2 text-sm font-semibold">/i
      )?.[1] || ''
    ) || null;
  const address =
    decodeEntities(
      visible.match(
        />Address<\/div>\s*<div class="flex gap-2 text-sm font-semibold">([^<]+)</i
      )?.[1] || ''
    ) || null;
  const visibleText = visible.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const notAvailable = /name is not yet available/i.test(visibleText);
  const limitExceeded = /oops!\s*search limit exceeded|search limit exceeded\./i.test(visibleText);
  const signedIn = /log out/i.test(text) && /tc_user|userState|account &amp; privacy|account & privacy/i.test(text);
  const article = visible.match(/<article\b[\s\S]{0,8000}/i)?.[0] || '';
  const articlePreview = article
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
  return {
    name,
    found: !!name,
    email: email || null,
    phone: phone || null,
    carrier,
    address: address || null,
    notAvailable,
    limitExceeded,
    signedIn,
    title:
      text.match(/property="og:title" content="([^"]+)"/)?.[1] ||
      text.match(/<title>([^<]+)<\/title>/)?.[1] ||
      null,
    preview: articlePreview || null,
    htmlBytes: text.length,
    hasArticle: /<article\b/i.test(text),
    hasVcard: /text\/vcard/i.test(text),
    hasSaveContact: /save contact/i.test(visibleText),
    snippet: (articlePreview || visibleText.replace(/Afghanistan[\s\S]*Zimbabwe/i, ' ')).slice(0, 280) || null,
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

  const { cc, num } = normalizePhone(country || row.country_code, number);
  const url = `${SEARCH_ORIGIN}/search/${cc}/${num}`;

  const headers = [
    'accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'accept-language: en-US,en;q=0.9,ar;q=0.8',
    `referer: ${SEARCH_ORIGIN}/search/${cc}/${num}`,
    'upgrade-insecure-requests: 1',
    'sec-fetch-dest: document',
    'sec-fetch-mode: navigate',
    'sec-fetch-site: same-origin',
    'sec-fetch-user: ?1',
    'user-agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
  ];
  const headerArgs = headers.flatMap((h) => ['-H', h]);
  const cookie = cookieHeader(row);
  const curlArgs = [
    '-sS',
    '-L',
    '--compressed',
    '--max-redirs',
    '5',
    '-m',
    '35',
    '-w',
    '\n__HTTP__:%{http_code}',
    '-b',
    cookie,
    ...headerArgs,
    url,
  ];
  const { stdout, stderr } = await execFileAsync('curl', curlArgs, {
    timeout: 40_000,
    maxBuffer: 8_000_000,
  });
  const raw = String(stdout || '');
  const httpLine = raw.match(/__HTTP__:(\d+)/)?.[1] || '';
  const html = raw.replace(/\n__HTTP__:\d+\s*$/, '');
  if (stderr && !html) throw new Error(String(stderr).slice(0, 240));

  const parsed = parseSearchHtml(html);
  upsertAccount(email, { status: row.status, last_search_at: new Date().toISOString() });

  return {
    http: httpLine || null,
    url,
    country: cc,
    number: num,
    signedIn: parsed.signedIn,
    found: parsed.found,
    via: 'html-direct',
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
