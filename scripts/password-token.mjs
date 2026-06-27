#!/usr/bin/env node
/**
 * Experiment: obtain LiveProfileCard.Access token using only email + password
 * (no browser / saved profile). Tries several Microsoft token grants.
 *
 * Usage:
 *   node scripts/password-token.mjs email@outlook.com password
 */
import { LIVEPROFILE, isLiveProfileCardToken } from '../lib/token-extract.js';

const [email, password] = process.argv.slice(2);

if (!email || !password) {
  console.error('Usage: node scripts/password-token.mjs <email> <password>');
  process.exit(1);
}

const ATTEMPTS = [
  {
    name: 'ROPC — consumers tenant (same client as Outlook)',
    url: LIVEPROFILE.tokenUrl,
    body: {
      client_id: LIVEPROFILE.clientId,
      scope: LIVEPROFILE.scope,
      grant_type: 'password',
      username: email,
      password,
    },
  },
  {
    name: 'ROPC — common tenant',
    url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    body: {
      client_id: LIVEPROFILE.clientId,
      scope: LIVEPROFILE.scope,
      grant_type: 'password',
      username: email,
      password,
    },
  },
  {
    name: 'Legacy Live OAuth — oauth20_token.srf',
    url: 'https://login.live.com/oauth20_token.srf',
    body: {
      client_id: LIVEPROFILE.clientId,
      scope: LIVEPROFILE.scope,
      grant_type: 'password',
      username: email,
      password,
    },
  },
  {
    name: 'ROPC — with redirect_uri + client_info (MSAL-style)',
    url: LIVEPROFILE.tokenUrl,
    body: {
      client_id: LIVEPROFILE.clientId,
      redirect_uri: LIVEPROFILE.redirectUri,
      scope: LIVEPROFILE.scope,
      grant_type: 'password',
      client_info: '1',
      username: email,
      password,
    },
  },
];

async function tryTokenGrant({ name, url, body }) {
  console.log(`\n--- ${name} ---`);
  console.log(`POST ${url}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(body).toString(),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.log(`Status: ${res.status}`);
    console.log('Non-JSON response:', text.slice(0, 500));
    return null;
  }

  console.log(`Status: ${res.status}`);
  if (json.access_token) {
    const preview = `${json.access_token.slice(0, 40)}…`;
    console.log('access_token:', preview);
    console.log('scope:', json.scope);
    console.log('expires_in:', json.expires_in);
    console.log('has refresh_token:', !!json.refresh_token);
    console.log('LiveProfileCard token:', isLiveProfileCardToken(json));
    return json;
  }

  console.log('error:', json.error);
  console.log('error_description:', json.error_description || json.error_codes);
  return null;
}

console.log('Testing password-only token grants for:', email);
console.log('Target scope:', LIVEPROFILE.scope);
console.log('Client ID:', LIVEPROFILE.clientId);

let winner = null;
for (const attempt of ATTEMPTS) {
  const result = await tryTokenGrant(attempt);
  if (isLiveProfileCardToken(result)) {
    winner = result;
    break;
  }
}

if (winner) {
  console.log('\n✓ Success — LiveProfileCard.Access token obtained without browser login.');
  process.exit(0);
}

console.log('\n✗ None of the password-only grants returned a LiveProfileCard token.');
console.log('Microsoft consumer accounts typically block ROPC for public clients.');
console.log('The existing browser login flow is required to establish MSAL session + refresh_token.');
process.exit(1);
