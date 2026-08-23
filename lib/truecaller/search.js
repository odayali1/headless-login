import { Impit } from 'impit';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { parseProxyUrl } from '../settings.js';
import { SEARCH_ORIGIN } from './config.js';
import { getAccount, getProxyUrl, upsertAccount } from './store.js';

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
  const limitExceeded = !name && /oops!\s*search limit exceeded/i.test(visibleText);
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

function proxyRelayUrl(proxyUrl) {
  const p = parseProxyUrl(proxyUrl);
  const user = encodeURIComponent(p.username);
  const pass = encodeURIComponent(p.password);
  if (p.protocol === 'http' || p.protocol === 'https') {
    return `http://${user}:${pass}@${p.host}:${p.port}`;
  }
  return `socks5h://${user}:${pass}@${p.host}:${p.port}`;
}

/** Same cookie the browser sends: tc_user=%7B%22token%22%3A%22<jwt>%22%7D */
export function buildSearchCookieHeader(row) {
  const parts = [];
  const jwt = String(row.tc_jwt || '');
  let raw = decodeMaybe(row.tc_user_cookie || '');
  let tokenJson = '';
  if (raw.startsWith('{')) tokenJson = raw;
  else if (jwt.includes('.')) tokenJson = JSON.stringify({ token: jwt });
  else if (raw.includes('.')) tokenJson = JSON.stringify({ token: raw });
  if (tokenJson) parts.push(`tc_user=${encodeURIComponent(tokenJson)}`);
  try {
    const extra = JSON.parse(row.cookies_json || '[]');
    for (const c of extra) {
      if (!c?.name || c.name === 'tc_user' || c.value == null) continue;
      parts.push(`${c.name}=${c.value}`);
    }
  } catch {
    // ignore
  }
  return parts.join('; ');
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
  if (!proxyUrl) {
    throw new Error('Set the Truecaller proxy first. Search uses that proxy with a Chrome TLS request — not Outlook, not the server IP.');
  }

  const { cc, num } = normalizePhone(country || row.country_code, number);
  const url = `${SEARCH_ORIGIN}/search/${cc}/${num}`;
  const cookie = buildSearchCookieHeader(row);
  if (!cookie.includes('tc_user=')) {
    throw new Error('No tc_user cookie on this Truecaller account. Sign up again.');
  }

  const log = (step, message) => console.log(`[truecaller-search:${email}] ${step}: ${message}`);
  log('start', `Chrome-impersonated GET ${url} via Truecaller proxy (Outlook not used).`);

  const relayUrl = await anonymizeProxy(proxyRelayUrl(proxyUrl));
  try {
    const impit = new Impit({
      browser: 'chrome',
      proxyUrl: relayUrl,
      timeout: 35_000,
      followRedirects: true,
    });
    const res = await impit.fetch(url, {
      headers: {
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'accept-language': 'en-US,en;q=0.9,ar;q=0.8',
        cookie,
        referer: url,
        'upgrade-insecure-requests': '1',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-user': '?1',
      },
    });
    const html = await res.text();
    const parsed = parseSearchHtml(html);
    upsertAccount(email, { status: row.status, last_search_at: new Date().toISOString() });
    log('done', parsed.found ? `Found ${parsed.name}` : `No profile card (http ${res.status}, ${html.length} bytes, Outlook untouched).`);
    return {
      http: String(res.status),
      url,
      country: cc,
      number: num,
      signedIn: parsed.signedIn,
      found: parsed.found,
      via: 'impit-chrome',
      result: parsed,
    };
  } finally {
    await closeAnonymizedProxy(relayUrl, true).catch(() => {});
  }
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
