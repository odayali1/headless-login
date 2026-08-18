/**
 * FireProx-compatible AWS API Gateway HTTP pass-through.
 *
 * FireProx is NOT a SOCKS/CONNECT proxy. Each REST API is bound to one origin.
 * Incoming:  https://{apiId}.execute-api.{region}.amazonaws.com/fireprox/{path}
 * Outgoing:  {origin}/{path}  (source IP = rotating AWS edge)
 *
 * @see https://github.com/ustayready/fireprox
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { awsJson, loadFireproxAwsCredentials } from './fireprox-aws.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Built-in FireProx APIs created on the AWS account (one gateway per origin). */
export const BUILT_IN_FIREPROX_APIS = Object.freeze([
  Object.freeze({
    origin: 'https://api.ipify.org',
    apiId: 'cned1f8xhe',
    proxyUrl: 'https://cned1f8xhe.execute-api.us-east-1.amazonaws.com/fireprox/',
  }),
  Object.freeze({
    origin: 'https://login.live.com',
    apiId: 'm6m8tzyruf',
    proxyUrl: 'https://m6m8tzyruf.execute-api.us-east-1.amazonaws.com/fireprox/',
  }),
  Object.freeze({
    origin: 'https://login.microsoftonline.com',
    apiId: '0h2nexjb0c',
    proxyUrl: 'https://0h2nexjb0c.execute-api.us-east-1.amazonaws.com/fireprox/',
  }),
]);

export const DEFAULT_FIREPROX_URL = String(
  process.env.FIREPROX_URL || BUILT_IN_FIREPROX_APIS[1].proxyUrl
).replace(/\/?$/, '/');
export const DEFAULT_FIREPROX_API_ID = String(process.env.FIREPROX_API_ID || 'm6m8tzyruf').trim();

const cache = new Map(); // origin -> { apiId, proxyUrl }
const creating = new Map();
let hydrated = false;

function cacheFile() {
  return path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'fireprox-apis.json');
}

function credsOrThrow() {
  const c = loadFireproxAwsCredentials();
  if (!c) {
    throw new Error(
      'AWS API (FireProx) needs AWS keys to create per-host gateways. Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (or data/fireprox-aws.json).'
    );
  }
  return c;
}

export function normalizeOrigin(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('FireProx origin is empty');
  if (/^https?:\/\//i.test(raw)) {
    const u = new URL(raw);
    const https = u.protocol === 'https:';
    const def = https ? 443 : 80;
    const port = u.port ? Number(u.port) : def;
    if (port === def) return `${u.protocol}//${u.hostname}`;
    return `${u.protocol}//${u.hostname}:${port}`;
  }
  const [host, portStr] = raw.split(':');
  const port = portStr ? Number(portStr) : 443;
  if (port === 80) return `http://${host}`;
  if (port === 443) return `https://${host}`;
  return `https://${host}:${port}`;
}

function apiTitle(origin) {
  const host = new URL(origin).hostname.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40);
  return `fireprox_${host}`.slice(0, 50);
}

/** Same Swagger HTTP_PROXY template as ustayready/fireprox fire.py */
function swaggerTemplate(origin) {
  const url = origin.replace(/\/$/, '');
  const title = apiTitle(origin);
  const versionDate = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const template = {
    swagger: '2.0',
    info: { version: versionDate, title },
    basePath: '/',
    schemes: ['https'],
    paths: {
      '/': {
        get: {
          parameters: [
            { name: 'proxy', in: 'path', required: true, type: 'string' },
            { name: 'X-My-X-Forwarded-For', in: 'header', required: false, type: 'string' },
          ],
          responses: {},
          'x-amazon-apigateway-integration': {
            uri: `${url}/`,
            responses: { default: { statusCode: '200' } },
            requestParameters: {
              'integration.request.path.proxy': 'method.request.path.proxy',
              'integration.request.header.X-Forwarded-For': 'method.request.header.X-My-X-Forwarded-For',
            },
            passthroughBehavior: 'when_no_match',
            httpMethod: 'ANY',
            cacheNamespace: 'irx7tm',
            cacheKeyParameters: ['method.request.path.proxy'],
            type: 'http_proxy',
          },
        },
      },
      '/{proxy+}': {
        'x-amazon-apigateway-any-method': {
          produces: ['application/json'],
          parameters: [
            { name: 'proxy', in: 'path', required: true, type: 'string' },
            { name: 'X-My-X-Forwarded-For', in: 'header', required: false, type: 'string' },
          ],
          responses: {},
          'x-amazon-apigateway-integration': {
            uri: `${url}/{proxy}`,
            responses: { default: { statusCode: '200' } },
            requestParameters: {
              'integration.request.path.proxy': 'method.request.path.proxy',
              'integration.request.header.X-Forwarded-For': 'method.request.header.X-My-X-Forwarded-For',
            },
            passthroughBehavior: 'when_no_match',
            httpMethod: 'ANY',
            cacheNamespace: 'irx7tm',
            cacheKeyParameters: ['method.request.path.proxy'],
            type: 'http_proxy',
          },
        },
      },
    },
  };
  return JSON.stringify(template);
}

function loadDiskCache() {
  try {
    const j = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    if (j && typeof j === 'object') {
      for (const [origin, row] of Object.entries(j)) {
        if (row?.proxyUrl && row?.apiId) cache.set(origin, row);
      }
    }
  } catch {
    // first run
  }
}

function saveDiskCache() {
  try {
    const dir = path.dirname(cacheFile());
    fs.mkdirSync(dir, { recursive: true });
    const obj = Object.fromEntries(cache.entries());
    fs.writeFileSync(cacheFile(), JSON.stringify(obj, null, 2));
  } catch (err) {
    console.warn(`[fireprox] Could not save API cache: ${err.message}`);
  }
}

function remember(origin, apiId, region) {
  const proxyUrl = `https://${apiId}.execute-api.${region}.amazonaws.com/fireprox/`;
  const row = { apiId, proxyUrl, region, origin };
  cache.set(origin, row);
  saveDiskCache();
  return row;
}

async function getProxyPlusResourceId(c, apiId) {
  const res = await awsJson({
    ...c,
    method: 'GET',
    path: `/restapis/${apiId}/resources`,
    query: { limit: '500' },
  });
  const items = res.items || [];
  const hit = items.find((it) => it.path === '/{proxy+}');
  return hit?.id || null;
}

async function getIntegrationUri(c, apiId) {
  const resourceId = await getProxyPlusResourceId(c, apiId);
  if (!resourceId) return null;
  const res = await awsJson({
    ...c,
    method: 'GET',
    path: `/restapis/${apiId}/resources/${resourceId}/methods/ANY/integration`,
  });
  return String(res.uri || '');
}

async function hydrateFromAws() {
  if (hydrated) return;
  hydrated = true;
  loadDiskCache();
  const c = loadFireproxAwsCredentials();
  if (!c) return;
  let position;
  for (let page = 0; page < 20; page++) {
    const res = await awsJson({
      ...c,
      method: 'GET',
      path: '/restapis',
      query: { limit: '500', ...(position ? { position } : {}) },
    });
    for (const item of res.items || []) {
      if (!/^fireprox_/i.test(item.name || '')) continue;
      try {
        const uri = await getIntegrationUri(c, item.id);
        const origin = String(uri || '')
          .replace(/\/\{proxy\}$/, '')
          .replace(/\/$/, '');
        if (/^https?:\/\//i.test(origin)) {
          remember(origin, item.id, c.region);
        }
      } catch {
        // skip broken APIs
      }
    }
    position = res.position;
    if (!position) break;
  }
}

export async function verifyFireproxAws() {
  const c = credsOrThrow();
  await awsJson({ ...c, method: 'GET', path: '/account' });
  return { ok: true, region: c.region, accessKeyId: `${c.accessKeyId.slice(0, 4)}…` };
}

export async function listFireproxApis() {
  await hydrateFromAws();
  return [...cache.entries()].map(([origin, row]) => ({ origin, ...row }));
}

async function createApi(origin) {
  const c = credsOrThrow();
  const body = swaggerTemplate(origin);
  const imported = await awsJson({
    ...c,
    method: 'POST',
    path: '/restapis',
    query: {
      mode: 'import',
      'parameters.endpointConfigurationTypes': 'REGIONAL',
    },
    body,
  });
  const apiId = imported.id;
  if (!apiId) throw new Error('FireProx import_rest_api returned no id');
  await awsJson({
    ...c,
    method: 'POST',
    path: `/restapis/${apiId}/deployments`,
    body: {
      stageName: 'fireprox',
      stageDescription: 'FireProx Prod',
      description: 'FireProx Production Deployment',
    },
  });
  const row = remember(origin, apiId, c.region);
  console.log(`[fireprox] Created ${row.proxyUrl} → ${origin}`);
  return row;
}

/**
 * Return the FireProx gateway URL (trailing slash) for a destination origin.
 * Creates and deploys an API Gateway REST API on first use, then caches it.
 */
export async function getFireproxUrlForOrigin(originLike) {
  const origin = normalizeOrigin(originLike);
  await hydrateFromAws();
  const hit = cache.get(origin);
  if (hit?.proxyUrl) return hit.proxyUrl;

  if (creating.has(origin)) return (await creating.get(origin)).proxyUrl;

  const job = createApi(origin).finally(() => creating.delete(origin));
  creating.set(origin, job);
  return (await job).proxyUrl;
}

/** Rewrite https://login.live.com/foo?x=1 → https://{gw}/fireprox/foo?x=1 */
export function rewriteThroughFireprox(fireproxBase, absoluteUrl) {
  const base = String(fireproxBase || '').replace(/\/?$/, '/');
  const u = new URL(absoluteUrl);
  const pathAndQuery = `${u.pathname.replace(/^\//, '')}${u.search}${u.hash}`;
  return base + pathAndQuery;
}

export function getKnownFireproxUrl(originLike) {
  try {
    return cache.get(normalizeOrigin(originLike))?.proxyUrl || null;
  } catch {
    return null;
  }
}

function seedDefaultGateway() {
  for (const row of BUILT_IN_FIREPROX_APIS) {
    const origin = normalizeOrigin(row.origin);
    if (cache.has(origin)) continue;
    cache.set(origin, {
      apiId: row.apiId,
      proxyUrl: row.proxyUrl.replace(/\/?$/, '/'),
      region: 'us-east-1',
      origin,
      seeded: true,
    });
  }
}

/** FIREPROX_MAP=api.ipify.org=https://abc.execute-api.us-east-1.amazonaws.com/fireprox/;login.live.com=https://def... */
function seedEnvMap() {
  const raw = String(process.env.FIREPROX_MAP || '').trim();
  if (!raw) return;
  for (const part of raw.split(/[;,]/)) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const host = part.slice(0, eq).trim();
    const url = part.slice(eq + 1).trim();
    if (!host || !url) continue;
    const origin = normalizeOrigin(/^https?:\/\//i.test(host) ? host : `https://${host}`);
    const apiId = url.match(/https:\/\/([^.]+)\.execute-api/i)?.[1] || '';
    cache.set(origin, {
      apiId,
      proxyUrl: url.replace(/\/?$/, '/'),
      region: 'us-east-1',
      origin,
    });
  }
}

loadDiskCache();
seedDefaultGateway();
seedEnvMap();
