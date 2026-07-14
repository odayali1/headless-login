/**
 * Probe refresh paths on local profiles (no Camoufox):
 *   1) Loki redeem (Teams client)
 *   2) Loki redeem (Outlook client)
 *   3) LiveProfileCard Outlook MSAL
 *   4) LiveProfileCard Teams MSAL
 *
 * Usage: node scripts/test-token-paths.mjs [count=5]
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { initSettings, bindSettingsStore, isProxyEnabled } from '../lib/settings.js';
import { tryLokiScopeRedeem, LIVEPROFILE, TEAMS_LIVEPROFILE, isTokenValid } from '../lib/token-extract.js';
import { getPlaywrightProxyConfig, closeLocalProxy } from '../lib/proxy-local.js';

function loadEnvFile() {
  try {
    const raw = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || process.env[m[1]]) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  } catch {
    // optional
  }
}
loadEnvFile();

const COUNT = Math.max(1, Number(process.argv[2] || 5));
const PROFILES_DIR = path.join(process.env.DATA_DIR || './data', 'profiles');

function log(step, msg) {
  console.log(`[${step}] ${msg}`);
}

async function exchangeMsal(refreshToken, profile, proxy) {
  const body = new URLSearchParams({
    client_id: profile.clientId,
    redirect_uri: profile.redirectUri,
    scope: profile.scope,
    grant_type: 'refresh_token',
    client_info: '1',
    refresh_token: refreshToken,
  }).toString();

  const { request } = await import('playwright');
  const ctx = await request.newContext({
    proxy: proxy?.mode === 'http-direct'
      ? { server: proxy.server, username: proxy.username, password: proxy.password }
      : proxy?.server
        ? { server: proxy.server }
        : undefined,
    timeout: 45_000,
  });
  try {
    const res = await ctx.post(profile.tokenUrl || 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token', {
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
        Origin: profile.origin,
        Referer: profile.referer,
      },
      data: body,
    });
    const json = await res.json().catch(() => ({}));
    return json;
  } finally {
    await ctx.dispose();
  }
}

async function main() {
  const dbPath = path.join(process.env.DATA_DIR || './data', 'app.db');
  const db = new Database(dbPath);
  bindSettingsStore(initSettings(db));

  console.log('Proxy enabled:', isProxyEnabled());
  const proxyCfg = isProxyEnabled() ? await getPlaywrightProxyConfig({ forceNew: true }) : null;
  console.log('Proxy mode:', proxyCfg?.mode || 'off', proxyCfg?.server || '');

  const files = fs
    .readdirSync(PROFILES_DIR)
    .filter((f) => f.endsWith('.json'))
    .slice(0, 80);

  const candidates = [];
  for (const f of files) {
    const p = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8'));
    const rt = p?.tokens?.refresh_token;
    if (!rt) continue;
    candidates.push({ email: p.email || f, rt, expires_at: p.tokens?.expires_at });
    if (candidates.length >= COUNT) break;
  }

  if (!candidates.length) {
    console.error('No local profiles with refresh_token in', PROFILES_DIR);
    process.exit(1);
  }

  const summary = [];

  for (const acc of candidates) {
    console.log('\n===', acc.email, 'expires_at=', acc.expires_at || 'n/a', '===');
    const row = { email: acc.email, lokiTeams: null, lokiOutlook: null, msalOutlook: null, msalTeams: null };

    try {
      const lokiTeams = await tryLokiScopeRedeem(acc.rt, log, { clientId: '4b3e8f46-56d3-427f-b1e2-d239b2ea6bca' });
      row.lokiTeams = lokiTeams?.access_token
        ? `OK expires_in=${lokiTeams.expires_in}`
        : 'fail';
      if (lokiTeams?.access_token && isTokenValid(lokiTeams)) {
        summary.push(row);
        console.log('BEST: Loki Teams — skip other paths');
        continue;
      }
    } catch (e) {
      row.lokiTeams = `err ${e.message}`;
    }

    try {
      const lokiOut = await tryLokiScopeRedeem(acc.rt, log, { clientId: LIVEPROFILE.clientId });
      row.lokiOutlook = lokiOut?.access_token
        ? `OK expires_in=${lokiOut.expires_in}`
        : 'fail';
      if (lokiOut?.access_token && isTokenValid(lokiOut)) {
        summary.push(row);
        console.log('BEST: Loki Outlook — skip MSAL');
        continue;
      }
    } catch (e) {
      row.lokiOutlook = `err ${e.message}`;
    }

    try {
      const m1 = await exchangeMsal(acc.rt, LIVEPROFILE, proxyCfg);
      row.msalOutlook = m1?.access_token
        ? `OK expires_in=${m1.expires_in}`
        : `${m1?.error || 'fail'}: ${(m1?.error_description || '').slice(0, 80)}`;
    } catch (e) {
      row.msalOutlook = `err ${e.message}`;
    }

    try {
      const m2 = await exchangeMsal(acc.rt, TEAMS_LIVEPROFILE, proxyCfg);
      row.msalTeams = m2?.access_token
        ? `OK expires_in=${m2.expires_in}`
        : `${m2?.error || 'fail'}: ${(m2?.error_description || '').slice(0, 80)}`;
    } catch (e) {
      row.msalTeams = `err ${e.message}`;
    }

    summary.push(row);
  }

  console.log('\n======== SUMMARY ========');
  console.log(JSON.stringify(summary, null, 2));

  await closeLocalProxy().catch(() => {});
  db.close();
}

main().catch(async (err) => {
  console.error(err);
  await closeLocalProxy().catch(() => {});
  process.exit(1);
});
