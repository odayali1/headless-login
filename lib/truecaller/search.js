import { Impit } from 'impit';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { parseProxyUrl } from '../settings.js';
import { SEARCH_ORIGIN } from './config.js';
import { getAccount, getProxyUrl, upsertAccount } from './store.js';
import { launchTruecallerBrowser } from './browser.js';

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

export function playwrightTcCookies(row) {
  const cookies = [];
  const jwt = String(row.tc_jwt || '');
  let raw = decodeMaybe(row.tc_user_cookie || '');
  let value = '';
  if (raw.startsWith('{')) value = raw;
  else if (jwt.includes('.')) value = JSON.stringify({ token: jwt });
  else if (raw.includes('.')) value = JSON.stringify({ token: raw });
  if (value) {
    cookies.push({
      name: 'tc_user',
      value,
      url: 'https://www.truecaller.com/',
      secure: true,
      sameSite: 'Lax',
    });
  }
  try {
    const extra = JSON.parse(row.cookies_json || '[]');
    for (const c of extra) {
      if (!c?.name || c.name === 'tc_user' || c.value == null) continue;
      const cookie = {
        name: c.name,
        value: String(c.value),
        secure: c.secure !== false,
        sameSite: c.sameSite === 'None' ? 'None' : 'Lax',
      };
      if (c.domain) {
        cookie.domain = c.domain;
        cookie.path = c.path || '/';
      } else {
        cookie.url = c.url || 'https://www.truecaller.com/';
      }
      cookies.push(cookie);
    }
  } catch {
    // ignore
  }
  return cookies;
}

function personFromApi(data) {
  const list = Array.isArray(data?.data) ? data.data : data?.data ? [data.data] : [];
  const person = list[0];
  if (!person || typeof person !== 'object') return null;
  if (!person.name && !person.altName) return null;
  return person;
}

async function searchJsonApi(row, cc, num, relayUrl, log) {
  const bearer = row.tc_token || decodeJwt(row.tc_jwt)?.token || '';
  if (!bearer) return null;
  const apiUrl = new URL('https://search5-noneu.truecaller.com/v2/search');
  apiUrl.searchParams.set('q', num);
  apiUrl.searchParams.set('countryCode', cc.toUpperCase());
  apiUrl.searchParams.set('type', '4');
  apiUrl.searchParams.set('encoding', 'json');
  log('api', `GET search5-noneu q=${num} ${cc.toUpperCase()}`);
  const impit = new Impit({
    browser: 'okhttp5',
    proxyUrl: relayUrl,
    timeout: 25_000,
    followRedirects: true,
  });
  const res = await impit.fetch(apiUrl.toString(), {
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: 'application/json',
      'content-type': 'application/json; charset=UTF-8',
      'user-agent': 'Truecaller/12.34.6 (Android;13)',
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    log('api', `search5 non-json http ${res.status} (${text.slice(0, 80)})`);
    return { http: res.status, json: null, person: null };
  }
  const person = personFromApi(json);
  log('api', `search5 http ${res.status} name=${person?.name || 'none'}`);
  return { http: res.status, json, person };
}

async function searchInCamoufox(email, row, url, proxyUrl, log) {
  const session = await launchTruecallerBrowser({
    email,
    cookies: [],
    fingerprint: null,
    proxyUrl,
    log,
  });
  try {
    const jar = playwrightTcCookies(row);
    await session.context.addCookies(jar);
    log('nav', url);
    await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await session.page.waitForSelector('text=Log out', { timeout: 20_000 }).catch(() => {});
    await session.page
      .waitForSelector('[class*="break-all"], a[href*="text/vcard"], text=Save contact', { timeout: 20_000 })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));
    const html = await session.page.content();
    const parsed = parseSearchHtml(html);
    const live = await session.page.evaluate(() => {
      const nameEl = document.querySelector('[class*="font-bold"][class*="break-all"]');
      const mail = document.querySelector('a[href^="mailto"]');
      const tel = document.querySelector('a[href^="tel"]');
      const visible = (document.body?.innerText || '').replace(/\s+/g, ' ');
      return {
        name: (nameEl?.textContent || '').trim() || null,
        email: (mail?.getAttribute('href') || '').replace(/^mailto:\/?\/?/, '') || null,
        phone: (tel?.getAttribute('href') || '').replace(/^tel:\/?\/?/, '') || null,
        hasArticle: !!document.querySelector('article'),
        hasVcard: !!document.querySelector('a[href*="text/vcard"]'),
        hasSaveContact: /save contact/i.test(visible),
        limitExceeded: /oops!\s*search limit exceeded/i.test(visible),
        signedIn: /log out/i.test(visible),
        visibleSlice: visible.slice(0, 400),
      };
    });
    const name = looksLikePersonName(live.name) ? live.name : parsed.name;
    return {
      ...parsed,
      name,
      found: !!name,
      email: live.email || parsed.email,
      phone: live.phone || parsed.phone,
      limitExceeded: !!live.limitExceeded,
      signedIn: !!(live.signedIn || parsed.signedIn),
      hasArticle: live.hasArticle,
      hasVcard: live.hasVcard,
      hasSaveContact: live.hasSaveContact,
      snippet: live.visibleSlice || parsed.snippet,
    };
  } finally {
    await session.close().catch(() => {});
    log('browser', 'Isolated search browser closed — Outlook profile was not written.');
  }
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
    throw new Error('Set the Truecaller proxy first. Search does not use Outlook or the Coolify IP.');
  }

  const { cc, num } = normalizePhone(country || row.country_code, number);
  const url = `${SEARCH_ORIGIN}/search/${cc}/${num}`;
  const log = (step, message) => console.log(`[truecaller-search:${email}] ${step}: ${message}`);

  const relayUrl = await anonymizeProxy(proxyRelayUrl(proxyUrl));
  try {
    log('start', `JSON search ${cc}/${num} with saved Truecaller token (Outlook not used).`);
    let api = null;
    try {
      api = await searchJsonApi(row, cc, num, relayUrl, log);
    } catch (err) {
      log('api', `search5 failed (${err.message})`);
    }
    if (api?.person?.name || api?.person?.altName) {
      const p = api.person;
      const emails = (p.internetAddresses || []).map((a) => a.id).filter(Boolean);
      const phones = p.phones || [];
      const addr = (p.addresses || [])[0] || {};
      const result = {
        name: p.name || p.altName,
        found: true,
        email: emails[0] || null,
        phone: phones[0]?.e164Format || phones[0]?.number || null,
        carrier: phones[0]?.carrier || null,
        address: [addr.city, addr.countryCode].filter(Boolean).join(', ') || null,
        notAvailable: false,
        limitExceeded: false,
        signedIn: true,
        title: null,
        preview: null,
        htmlBytes: 0,
        hasArticle: true,
        hasVcard: false,
        hasSaveContact: false,
        snippet: null,
      };
      upsertAccount(email, { status: row.status, last_search_at: new Date().toISOString() });
      log('done', `Found ${result.name}`);
      return {
        http: String(api.http),
        url,
        country: cc,
        number: num,
        signedIn: true,
        found: true,
        via: 'search5-json',
        result,
      };
    }
    if (api?.http === 429 || api?.http === 403) {
      throw new Error(`Truecaller search API http ${api.http} — account/IP limited. Outlook was not touched.`);
    }
  } finally {
    await closeAnonymizedProxy(relayUrl, true).catch(() => {});
  }

  log('start', 'JSON had no name — opening isolated Camoufox (same Firefox as signup).');
  const parsed = await searchInCamoufox(email, row, url, proxyUrl, log);
  upsertAccount(email, { status: row.status, last_search_at: new Date().toISOString() });
  log('done', parsed.found ? `Found ${parsed.name}` : 'No profile card in Camoufox either (Outlook untouched).');
  return {
    http: '200',
    url,
    country: cc,
    number: num,
    signedIn: parsed.signedIn,
    found: parsed.found,
    via: 'camoufox-proxy',
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
