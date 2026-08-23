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

function buildTruecallerCookies(row) {
  const out = [];
  const jwt = String(row.tc_jwt || '');
  let raw = decodeMaybe(row.tc_user_cookie || '');
  let value = '';
  if (raw.startsWith('{')) value = raw;
  else if (jwt.includes('.')) value = JSON.stringify({ token: jwt });
  else if (raw.includes('.')) value = JSON.stringify({ token: raw });
  if (value) {
    out.push({
      name: 'tc_user',
      value,
      url: 'https://www.truecaller.com/',
      path: '/',
      secure: true,
      sameSite: 'Lax',
    });
  }
  try {
    const extra = JSON.parse(row.cookies_json || '[]');
    for (const c of extra) {
      if (!c?.name || c.name === 'tc_user') continue;
      const host = String(c.domain || c.url || 'truecaller.com');
      if (!/truecaller\.com/i.test(host)) continue;
      const cookie = {
        name: c.name,
        value: String(c.value),
        path: c.path || '/',
        secure: c.secure !== false,
        sameSite: c.sameSite === 'None' ? 'None' : 'Lax',
      };
      if (c.domain) cookie.domain = c.domain;
      else cookie.url = 'https://www.truecaller.com/';
      out.push(cookie);
    }
  } catch {
    // ignore
  }
  return out;
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
    throw new Error('Set the Truecaller proxy first. Search uses the isolated Camoufox + that proxy, not the server IP and not Outlook.');
  }

  const { cc, num } = normalizePhone(country || row.country_code, number);
  const url = `${SEARCH_ORIGIN}/search/${cc}/${num}`;
  const log = (step, message) => console.log(`[truecaller-search:${email}] ${step}: ${message}`);

  log('start', `Isolated Camoufox search ${url} — Outlook will not be opened.`);
  const session = await launchTruecallerBrowser({
    email,
    cookies: [],
    fingerprint: null,
    proxyUrl,
    log,
  });

  try {
    await session.context.addCookies(buildTruecallerCookies(row));
    log('nav', url);
    await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await session.page.waitForSelector('text=Log out', { timeout: 20_000 }).catch(() => {});
    await session.page
      .waitForSelector('[class*="break-all"], a[href*="text/vcard"], text=Save contact', { timeout: 15_000 })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));

    const html = await session.page.content();
    const parsed = parseSearchHtml(html);
    const live = await session.page.evaluate(() => {
      const nameEl = document.querySelector('[class*="font-bold"][class*="break-all"]');
      const vcard = document.querySelector('a[href*="text/vcard"]');
      const mail = document.querySelector('a[href^="mailto"]');
      const tel = document.querySelector('a[href^="tel"]');
      const visible = (document.body?.innerText || '').replace(/\s+/g, ' ');
      return {
        name: (nameEl?.textContent || '').trim() || null,
        email: (mail?.getAttribute('href') || '').replace(/^mailto:\/?\/?/, '') || null,
        phone: (tel?.getAttribute('href') || '').replace(/^tel:\/?\/?/, '') || null,
        hasArticle: !!document.querySelector('article'),
        hasVcard: !!vcard,
        hasSaveContact: /save contact/i.test(visible),
        limitExceeded: /oops!\s*search limit exceeded/i.test(visible),
        signedIn: /log out/i.test(visible),
        visibleSlice: visible.slice(0, 400),
      };
    });

    const name = looksLikePersonName(live.name) ? live.name : parsed.name;
    const found = !!name;
    upsertAccount(email, { status: row.status, last_search_at: new Date().toISOString() });
    log('done', found ? `Found ${name}` : 'No profile card in the isolated browser (Outlook untouched).');

    return {
      http: '200',
      url,
      country: cc,
      number: num,
      signedIn: !!(live.signedIn || parsed.signedIn),
      found,
      via: 'camoufox-proxy',
      result: {
        ...parsed,
        name,
        found,
        email: live.email || parsed.email,
        phone: live.phone || parsed.phone,
        limitExceeded: !!live.limitExceeded,
        signedIn: !!(live.signedIn || parsed.signedIn),
        hasArticle: live.hasArticle,
        hasVcard: live.hasVcard,
        hasSaveContact: live.hasSaveContact,
        snippet: live.visibleSlice || parsed.snippet,
      },
    };
  } finally {
    await session.close().catch(() => {});
    log('browser', 'Isolated search browser closed — Outlook profile was not written.');
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
