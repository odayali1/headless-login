/**
 * Minimal AWS Signature V4 client for API Gateway REST (FireProx).
 * Avoids pulling the full AWS SDK into the login app.
 */
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function parseIni(text) {
  const out = {};
  let section = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      section = sec[1].trim();
      out[section] = out[section] || {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1 || !section) continue;
    out[section][line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export function loadFireproxAwsCredentials() {
  const accessKeyId = String(
    process.env.FIREPROX_AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || ''
  ).trim();
  const secretAccessKey = String(
    process.env.FIREPROX_AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || ''
  ).trim();
  const sessionToken = String(
    process.env.FIREPROX_AWS_SESSION_TOKEN || process.env.AWS_SESSION_TOKEN || ''
  ).trim();
  const region = String(
    process.env.FIREPROX_AWS_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
  ).trim() || 'us-east-1';

  if (accessKeyId && secretAccessKey) {
    return { accessKeyId, secretAccessKey, sessionToken: sessionToken || undefined, region };
  }

  const jsonPath = path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'fireprox-aws.json');
  try {
    const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (j?.accessKeyId && j?.secretAccessKey) {
      return {
        accessKeyId: String(j.accessKeyId).trim(),
        secretAccessKey: String(j.secretAccessKey).trim(),
        sessionToken: j.sessionToken ? String(j.sessionToken).trim() : undefined,
        region: String(j.region || region).trim() || 'us-east-1',
      };
    }
  } catch {
    // optional local file
  }

  const profile = String(process.env.AWS_PROFILE || process.env.FIREPROX_AWS_PROFILE || 'default').trim();
  try {
    const creds = parseIni(fs.readFileSync(path.join(os.homedir(), '.aws', 'credentials'), 'utf8'));
    const cfg = parseIni(fs.readFileSync(path.join(os.homedir(), '.aws', 'config'), 'utf8'));
    const c = creds[profile] || {};
    const conf = cfg[profile === 'default' ? 'default' : `profile ${profile}`] || {};
    if (c.aws_access_key_id && c.aws_secret_access_key) {
      return {
        accessKeyId: c.aws_access_key_id,
        secretAccessKey: c.aws_secret_access_key,
        sessionToken: c.aws_session_token || undefined,
        region: conf.region || region,
      };
    }
  } catch {
    // no aws cli files
  }

  return null;
}

export async function awsJson({
  method,
  region,
  path: urlPath,
  query,
  body,
  accessKeyId,
  secretAccessKey,
  sessionToken,
}) {
  const service = 'apigateway';
  const host = `apigateway.${region}.amazonaws.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payload = body == null ? '' : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const payloadHash = sha256Hex(payload);

  const qs = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v == null || v === '') continue;
      qs.set(k, String(v));
    }
  }
  const canonicalQuery = [...qs.entries()]
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/!/g, '%21')}`)
    .join('&');

  const headers = {
    host,
    'content-type': 'application/json',
    'x-amz-date': amzDate,
  };
  if (sessionToken) headers['x-amz-security-token'] = sessionToken;

  const signedHeaderNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = signedHeaderNames.map((n) => `${n}:${String(headers[n]).trim()}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    method.toUpperCase(),
    urlPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const auth = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = `https://${host}${urlPath}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
  const res = await fetch(url, {
    method: method.toUpperCase(),
    headers: { ...headers, Authorization: auth },
    body: payload === '' ? undefined : payload,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`AWS API Gateway ${method} ${urlPath} → ${res.status}: ${text.slice(0, 800)}`);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
