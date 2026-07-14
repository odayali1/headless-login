import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';
import { request } from 'playwright';
import { initSettings, bindSettingsStore } from '../lib/settings.js';
import { getPlaywrightProxyConfig, closeLocalProxy } from '../lib/proxy-local.js';
import { TEAMS_LIVEPROFILE, LIVEPROFILE } from '../lib/token-extract.js';

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

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

const email = process.argv[2] || 'LateshaaaKoetters@hotmail.com';
const saved = JSON.parse(
  fs.readFileSync(path.join(process.env.DATA_DIR || './data', 'profiles', `${email}-outlook.json`), 'utf8')
);
const db = new Database(path.join(process.env.DATA_DIR || './data', 'app.db'));
bindSettingsStore(initSettings(db));
const cfg = await getPlaywrightProxyConfig({ forceNew: true });
const proxy =
  cfg.mode === 'http-direct'
    ? { server: cfg.server, username: cfg.username, password: cfg.password }
    : { server: cfg.server };
console.log('proxy', cfg.mode, 'email', email);

async function tryProfile(profile) {
  const { verifier, challenge } = pkce();
  const authUrl = new URL('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
  authUrl.searchParams.set('client_id', profile.clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', profile.redirectUri);
  authUrl.searchParams.set('scope', profile.scope);
  authUrl.searchParams.set('response_mode', 'query');
  authUrl.searchParams.set('prompt', 'none');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const ctx = await request.newContext({
    proxy,
    storageState: { cookies: saved.cookies || [], origins: [] },
    timeout: 45_000,
  });
  try {
    const t0 = Date.now();
    let url = authUrl.toString();
    let code = null;
    for (let hop = 0; hop < 12; hop++) {
      const res = await ctx.get(url, { maxRedirects: 0, timeout: 45_000 });
      const loc = res.headers().location || '';
      if (!loc) {
        console.log(profile.label, 'no loc', res.status(), 'ms', Date.now() - t0);
        break;
      }
      const abs = new URL(loc, url).toString();
      const m = /[?&#]code=([^&]+)/.exec(abs);
      if (m) {
        code = decodeURIComponent(m[1]);
        console.log(profile.label, 'CODE in', Date.now() - t0, 'ms');
        break;
      }
      if (/error=/.test(abs)) {
        console.log(profile.label, 'ERR', decodeURIComponent(abs).slice(0, 260));
        return;
      }
      url = abs;
    }
    if (!code) return;

    const body = new URLSearchParams({
      client_id: profile.clientId,
      redirect_uri: profile.redirectUri,
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      scope: profile.scope,
    }).toString();
    const tok = await ctx.post(profile.tokenUrl, {
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
        Origin: profile.origin,
        Referer: profile.referer,
      },
      data: body,
    });
    const json = await tok.json();
    console.log(
      profile.label,
      json.access_token
        ? {
            ok: true,
            expires_in: json.expires_in,
            hasRT: !!json.refresh_token,
            scope: (json.scope || '').slice(0, 80),
            ms: Date.now() - t0,
          }
        : { err: json.error, desc: (json.error_description || '').slice(0, 140) }
    );
  } finally {
    await ctx.dispose();
  }
}

await tryProfile(TEAMS_LIVEPROFILE);
await tryProfile(LIVEPROFILE);
await closeLocalProxy().catch(() => {});
db.close();
