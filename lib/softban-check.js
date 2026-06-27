import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { profilePath } from './profile.js';
import { isLiveProfileCardToken, isTokenValid } from './token-extract.js';

const LOKI_BASE = 'https://nam.loki.delve.office.com/api/v2/linkedin/profiles';

export function softbanStatusLabel(check) {
  if (!check?.status || check.status === 'unchecked') return 'Not checked';
  if (check.status === 'softban') return 'Softban';
  if (check.status === 'clean') return 'OK';
  if (check.status === 'no_token') return 'No token';
  return 'Check failed';
}

function parseSoftbanResponse(json, httpStatus) {
  const blob = JSON.stringify(json || {});
  const innerMsg = json?.Error?.Message?.Message || json?.Error?.Message || '';

  if (
    /user is restricted|request denied/i.test(blob) ||
    /user is restricted|request denied/i.test(String(innerMsg)) ||
    json?.Error?.Code === 'UnknownForbiddenResponseFromMsGraphException'
  ) {
    return {
      status: 'softban',
      message: 'User is restricted (MS Graph 403)',
      rawCode: json?.Error?.Code || 'restricted',
    };
  }

  if (httpStatus >= 200 && httpStatus < 300 && !json?.Error) {
    return { status: 'clean', message: 'LivePersonaCard API OK — not softbanned', rawCode: null };
  }

  return {
    status: 'error',
    message: json?.Error?.Code || `HTTP ${httpStatus}`,
    rawCode: json?.Error?.Code || null,
  };
}

/** LivePersonaCard probe — same API Outlook uses for profile cards. */
export async function probeLivePersonaCard(email, accessToken) {
  const correlationId = crypto.randomUUID();
  const clientCorrelationId = crypto.randomUUID();
  const encEmail = encodeURIComponent(email);

  const url =
    `${LOKI_BASE}?smtp=${encEmail}&personaType=User&displayName=${encEmail}` +
    `&RootCorrelationId=${correlationId}&CorrelationId=${correlationId}` +
    `&ClientCorrelationId=${clientCorrelationId}&ConvertGetPost=true`;

  const payload = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-ClientType': 'OneOutlook',
    'X-ClientFeature': 'LivePersonaCard',
    'X-ClientArchitectureVersion': 'v2',
    'X-ClientScenario': 'LinkedInProfileSearchResult',
    'X-HostAppApp': 'Mail',
    'X-HostAppPlatform': 'Web',
    'X-LPCVersion': '1.20260607.9.0',
    authorization: `Bearer ${accessToken}`,
    'X-HostAppRing': 'WW',
    'X-HostAppVersion': '20260612016.13',
    'X-HostAppCapabilities': JSON.stringify({
      isLokiContactDataDisabled: false,
      isOnePersonViewEnabled: true,
      isOnePersonContextualViewEnabled: false,
      isMsalAuthEnabled: true,
      isPeopleLookupDataDisabled: false,
    }),
    'X-AccountLinkedIn3S': 'false',
    'X-Client-Language': 'en-US',
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      accept: '*/*',
      'content-type': 'text/plain;charset=UTF-8',
      origin: 'https://outlook.live.com',
      referer: 'https://outlook.live.com/',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }

  return parseSoftbanResponse(json, res.status);
}

export async function saveSoftbanCheck(email, target, result) {
  const file = profilePath(email, target);
  let data = {};
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw new Error('No profile for this account.');
  }

  data.softbanCheck = {
    ...result,
    checkedAt: new Date().toISOString(),
  };
  await fs.writeFile(file, JSON.stringify(data, null, 2));
  return data.softbanCheck;
}

export async function checkAccountSoftban(email, target, tokens) {
  if (!isLiveProfileCardToken(tokens) || !tokens.access_token) {
    const result = { status: 'no_token', message: 'No LiveProfileCard access token — log in first.', rawCode: null };
    await saveSoftbanCheck(email, target, result).catch(() => {});
    return result;
  }

  if (!isTokenValid(tokens)) {
    const result = { status: 'no_token', message: 'Token expired — refresh token first.', rawCode: null };
    await saveSoftbanCheck(email, target, result).catch(() => {});
    return result;
  }

  const result = await probeLivePersonaCard(email, tokens.access_token);
  await saveSoftbanCheck(email, target, result);
  return result;
}
