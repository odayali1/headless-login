#!/usr/bin/env node
/**
 * Experiment: programmatic OAuth authorization-code flow (HTTP only, no browser).
 * Submits email/password to login.live.com, then exchanges code for tokens.
 * Uses PKCE (required by Outlook MSAL client).
 *
 * Usage:
 *   node scripts/password-token-authcode.mjs email@outlook.com password
 */
import crypto from 'node:crypto';
import { LIVEPROFILE, isLiveProfileCardToken } from '../lib/token-extract.js';

const [email, password] = process.argv.slice(2);

if (!email || !password) {
  console.error('Usage: node scripts/password-token-authcode.mjs <email> <password>');
  process.exit(1);
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function parseCookies(setCookieHeaders = []) {
  const jar = new Map();
  for (const raw of setCookieHeaders) {
    const part = raw.split(';')[0];
    const eq = part.indexOf('=');
    if (eq > 0) jar.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return jar;
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function mergeCookies(jar, res) {
  const headers = res.headers.getSetCookie?.() || [];
  const legacy = res.headers.get('set-cookie');
  const list = headers.length ? headers : legacy ? [legacy] : [];
  for (const [k, v] of parseCookies(list)) jar.set(k, v);
}

function extractHidden(html, name) {
  const re = new RegExp(`name="${name}"[^>]*value="([^"]*)"`, 'i');
  const m = html.match(re);
  if (m) return m[1];
  const re2 = new RegExp(`value="([^"]*)"[^>]*name="${name}"`, 'i');
  return html.match(re2)?.[1] || null;
}

function extractUrlPost(html) {
  const m = html.match(/urlPost['":\s]+['"]([^'"]+)['"]/i);
  if (m) return m[1];
  const sd = html.match(/var ServerData = (\{[\s\S]*?\});/);
  if (sd) {
    try {
      return JSON.parse(sd[1]).urlPost || null;
    } catch {
      // ignore
    }
  }
  return null;
}

function extractPpft(html) {
  const fromInput =
    extractHidden(html, 'PPFT') ||
    html.match(/sFTTag['":\s]+<input[^>]*value="([^"]+)"/i)?.[1] ||
    html.match(/"sFT":"([^"]+)"/)?.[1] ||
    null;
  if (fromInput) return fromInput;

  const tagMatch = html.match(/"sFTTag":"((?:\\.|[^"\\])*)"/);
  if (tagMatch) {
    const tag = tagMatch[1].replace(/\\"/g, '"');
    return tag.match(/value="([^"]+)"/i)?.[1] || null;
  }
  return null;
}

function makePkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function authorizeAndLogin() {
  const jar = new Map();
  const pkce = makePkce();
  const authUrl = new URL('https://login.live.com/oauth20_authorize.srf');
  authUrl.searchParams.set('client_id', LIVEPROFILE.clientId);
  authUrl.searchParams.set('scope', LIVEPROFILE.scope);
  authUrl.searchParams.set('redirect_uri', LIVEPROFILE.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('response_mode', 'fragment');
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('prompt', 'login');

  console.log('1) GET authorize URL…');
  let res = await fetch(authUrl, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    redirect: 'manual',
  });
  mergeCookies(jar, res);

  let html = '';
  let hops = 0;
  while (res.status >= 300 && res.status < 400 && hops < 8) {
    const loc = res.headers.get('location');
    if (!loc) break;
    const next = new URL(loc, authUrl).href;
    console.log(`   redirect ${res.status} -> ${next.slice(0, 100)}…`);
    res = await fetch(next, {
      headers: { 'user-agent': UA, accept: 'text/html', cookie: cookieHeader(jar) },
      redirect: 'manual',
    });
    mergeCookies(jar, res);
    hops++;
  }
  html = await res.text();

  const urlPost = extractUrlPost(html) || 'https://login.live.com/ppsecure/post.srf';
  const ppft = extractPpft(html);
  if (!ppft) {
    console.error('Could not find PPFT on login page.');
    console.log('Page snippet:', html.slice(0, 800));
    return null;
  }
  console.log('2) POST credentials to', urlPost.slice(0, 80), '…');

  const loginBody = new URLSearchParams({
    login: email,
    loginfmt: email,
    passwd: password,
    PPFT: ppft,
    type: '11',
    LoginOptions: '3',
    NewUser: '1',
    i13: '0',
    i19: '19164',
  });

  res = await fetch(urlPost, {
    method: 'POST',
    headers: {
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader(jar),
      referer: authUrl.href,
    },
    body: loginBody.toString(),
    redirect: 'manual',
  });
  mergeCookies(jar, res);

  hops = 0;
  let finalUrl = res.url;
  while (res.status >= 300 && res.status < 400 && hops < 12) {
    const loc = res.headers.get('location');
    if (!loc) break;
    finalUrl = new URL(loc, 'https://login.live.com').href;
    console.log(`   post-login redirect -> ${finalUrl.slice(0, 120)}…`);
    if (/oauthRedirect\.html.*code=/.test(finalUrl) || /[#?]code=/.test(finalUrl)) break;
    res = await fetch(finalUrl, {
      headers: { 'user-agent': UA, cookie: cookieHeader(jar) },
      redirect: 'manual',
    });
    mergeCookies(jar, res);
    hops++;
  }

  const body = await res.text().catch(() => '');
  const fromUrl = finalUrl || '';
  const codeMatch =
    fromUrl.match(/[?&#]code=([^&#]+)/) ||
    body.match(/[?&#]code=([^&#"'\s]+)/) ||
    body.match(/code=([A-Za-z0-9._\-]+)/);

  if (!codeMatch) {
    if (/incorrect password|account or password is incorrect/i.test(body)) {
      console.error('Login failed: wrong password.');
    } else if (/proof|mfa|two-step|help us protect/i.test(body)) {
      console.error('Login blocked: MFA / proof required.');
    } else {
      console.error('No authorization code in response.');
      console.log('Final URL:', fromUrl.slice(0, 200));
      console.log('Body snippet:', body.slice(0, 600));
    }
    return null;
  }

  const code = decodeURIComponent(codeMatch[1]);
  console.log('3) Got authorization code, exchanging for token…');

  const tokenRes = await fetch(LIVEPROFILE.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams({
      client_id: LIVEPROFILE.clientId,
      redirect_uri: LIVEPROFILE.redirectUri,
      scope: LIVEPROFILE.scope,
      grant_type: 'authorization_code',
      code,
      code_verifier: pkce.verifier,
      client_info: '1',
    }).toString(),
  });

  const json = await tokenRes.json();
  console.log('Token status:', tokenRes.status);
  if (json.error) {
    console.log('error:', json.error);
    console.log('error_description:', json.error_description);
    return null;
  }

  return json;
}

console.log('HTTP auth-code flow for:', email);
const tokens = await authorizeAndLogin();

if (isLiveProfileCardToken(tokens)) {
  console.log('\n✓ LiveProfileCard.Access token obtained.');
  console.log('scope:', tokens.scope);
  console.log('expires_in:', tokens.expires_in);
  console.log('access_token:', `${tokens.access_token.slice(0, 50)}…`);
  console.log('refresh_token:', tokens.refresh_token ? 'yes' : 'no');
  process.exit(0);
}

console.log('\n✗ Did not obtain LiveProfileCard token via HTTP auth-code flow.');
process.exit(1);
