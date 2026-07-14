/**
 * Test: ESTSAUTH/session cookies → OAuth authorize (prompt=none) → code → tokens.
 * Faster than Outlook→Teams SPA if cookies still SSO.
 *
 * Usage: node scripts/test-cookie-authcode.mjs [email]
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { request } from 'playwright';
import { initSettings, bindSettingsStore } from '../lib/settings.js';
import { LIVEPROFILE, TEAMS_LIVEPROFILE } from '../lib/token-extract.js';
import { getPlaywrightProxyConfig, closeLocalProxy } from '../lib/proxy-local.js';

function loadEnvFile() {
  try {
    const raw = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || process.env[m[1]]) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  } catch {
    // optional
  }
}
loadEnvFile();

const email = process.argv[2] || 'LateshaaaKoetters@hotmail.com';
const profilePath = path.join(process.env.DATA_DIR || './data', 'profiles', `${email}-outlook.json`);
const saved = JSON.parse(fs.readFileSync(profilePath, 'utf8'));

const db = new Database(path.join(process.env.DATA_DIR || './data', 'app.db'));
bindSettingsStore(initSettings(db));

const cfg = await getPlaywrightProxyConfig({ forceNew: true });
const proxy =
  cfg?.mode === 'http-direct'
    ? { server: cfg.server, username: cfg.username, password: cfg.password }
    : { server: cfg.server };
console.log('Proxy', cfg?.mode, cfg?.server || cfg?.label);
console.log('Cookies', (saved.cookies || []).length, 'names sample', (saved.cookies || []).slice(0, 8).map((c) => c.name).join(','));

async function tryProfile(profile) {
  const authUrl = new URL('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
  authUrl.searchParams.set('client_id', profile.clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', profile.redirectUri);
  authUrl.searchParams.set('scope', profile.scope);
  authUrl.searchParams.set('response_mode', 'query');
  authUrl.searchParams.set('prompt', 'none');

  const ctx = await request.newContext({
    proxy,
    storageState: { cookies: saved.cookies || [], origins: [] },
    timeout: 45_000,
  });

  try {
    const t0 = Date.now();
    // Follow redirects manually to catch code on redirect_uri
    let url = authUrl.toString();
    let code = null;
    let lastStatus = 0;
    for (let hop = 0; hop < 12; hop++) {
      const res = await ctx.get(url, { maxRedirects: 0, timeout: 45_000 });
      lastStatus = res.status();
      const loc = res.headers().location || res.headers().Location || '';
      if (!loc) {
        console.log(profile.label, 'no redirect status', lastStatus, 'ms', Date.now() - t0);
        break;
      }
      const abs = new URL(loc, url).toString();
      const m = /[?&#]code=([^&]+)/.exec(abs);
      if (m) {
        code = decodeURIComponent(m[1]);
        console.log(profile.label, 'GOT CODE in', Date.now() - t0, 'ms hop', hop + 1);
        break;
      }
      if (/error=/.test(abs)) {
        console.log(profile.label, 'auth error', abs.slice(0, 220), 'ms', Date.now() - t0);
        break;
      }
      url = abs;
    }

    if (!code) return { ok: false, reason: 'no_code', status: lastStatus };

    const body = new URLSearchParams({
      client_id: profile.clientId,
      redirect_uri: profile.redirectUri,
      grant_type: 'authorization_code',
      code,
      scope: profile.scope,
    }).toString();

    const tok = await ctx.post(profile.tokenUrl, {
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
      data: body,
    });
    const json = await tok.json();
    if (json.access_token) {
      console.log(profile.label, 'TOKEN OK', {
        expires_in: json.expires_in,
        hasRT: !!json.refresh_token,
        scope: json.scope,
        ms: Date.now() - t0,
      });
      return { ok: true, json, ms: Date.now() - t0 };
    }
    console.log(profile.label, 'token fail', json.error, (json.error_description || '').slice(0, 120));
    return { ok: false, reason: json.error };
  } finally {
    await ctx.dispose();
  }
}

for (const profile of [TEAMS_LIVEPROFILE, LIVEPROFILE]) {
  await tryProfile(profile);
}

await closeLocalProxy().catch(() => {});
db.close();
