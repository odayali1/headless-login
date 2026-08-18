/**
 * Local HTTP CONNECT proxy that MITMs TLS and forwards each request through
 * a FireProx API Gateway for that origin (rotating AWS IP per request).
 *
 * Playwright/Camoufox talk to http://127.0.0.1:port (no auth).
 * ignoreHTTPSErrors / curl -k is required because the MITM cert is local-only.
 */
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFireproxUrlForOrigin, hasFireproxForOrigin, rewriteThroughFireprox } from './fireprox.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'expect',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
]);

let server = null;
let listenUrl = null;
let pins = 0;
let mitm = null;
const certCache = new Map();
const passthroughLogged = new Set();

function logPassthrough(host) {
  const key = String(host || '').toLowerCase();
  if (!key || passthroughLogged.has(key)) return;
  passthroughLogged.add(key);
  console.log(`[fireprox] Passthrough ${host} (no FireProx API — direct TCP, login form CDNs)`);
}

function tunnelConnect(clientSocket, head, host, port) {
  const remote = net.connect({ host, port, timeout: 20_000 }, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) remote.write(head);
    clientSocket.pipe(remote);
    remote.pipe(clientSocket);
  });
  remote.on('error', () => clientSocket.destroy());
  remote.on('timeout', () => {
    remote.destroy();
    clientSocket.destroy();
  });
  clientSocket.on('error', () => remote.destroy());
}

function mitmDir() {
  return path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'fireprox-mitm');
}

async function generateMitmCa() {
  const dir = mitmDir();
  fs.mkdirSync(dir, { recursive: true });
  const keyPath = path.join(dir, 'ca.key');
  const certPath = path.join(dir, 'ca.crt');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }

  const bins = [
    process.env.OPENSSL_PATH,
    'openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  ].filter(Boolean);

  let lastErr = null;
  for (const bin of bins) {
    try {
      await execFileAsync(
        bin,
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-keyout',
          keyPath,
          '-out',
          certPath,
          '-days',
          '3650',
          '-nodes',
          '-subj',
          '/CN=Headless Login FireProx MITM',
        ],
        { windowsHide: true }
      );
      return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    } catch (err) {
      lastErr = err;
    }
  }

  try {
    const selfsigned = (await import('selfsigned')).default;
    const pems = selfsigned.generate([{ name: 'commonName', value: 'Headless Login FireProx MITM' }], {
      keySize: 2048,
      days: 3650,
      algorithm: 'sha256',
    });
    fs.writeFileSync(keyPath, pems.private);
    fs.writeFileSync(certPath, pems.cert);
    return { key: pems.private, cert: pems.cert };
  } catch (err) {
    throw new Error(
      `FireProx local MITM cert failed (openssl: ${lastErr?.message || lastErr}; selfsigned: ${err.message}). Install Git for Windows (openssl) or npm i selfsigned.`
    );
  }
}

async function certForHost(host) {
  const hit = certCache.get(host);
  if (hit) return hit;
  if (!mitm) mitm = await generateMitmCa();
  // One shared self-signed cert; Camoufox/Playwright use ignoreHTTPSErrors.
  const pair = { key: mitm.key, cert: mitm.cert };
  certCache.set(host, pair);
  return pair;
}

function filterRequestHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (v == null) continue;
    const lk = k.toLowerCase();
    if (HOP.has(lk)) continue;
    out[k] = v;
  }
  const spoof = String(process.env.FIREPROX_X_FORWARDED_FOR || '').trim();
  if (spoof) out['X-My-X-Forwarded-For'] = spoof;
  return out;
}

function filterResponseHeaders(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) {
    const lk = k.toLowerCase();
    if (HOP.has(lk)) continue;
    if (lk.startsWith('x-amzn-') || lk.startsWith('x-amz-') || lk === 'content-encoding') continue;
    out[k] = v;
  }
  return out;
}

async function fireproxFetch(origin, urlPath, method, headers, body) {
  const base = await getFireproxUrlForOrigin(origin);
  const abs = new URL(urlPath, origin).href;
  const proxied = rewriteThroughFireprox(base, abs);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Number(process.env.FIREPROX_TIMEOUT_MS || 45_000));
  try {
    const res = await fetch(proxied, {
      method,
      headers: filterRequestHeaders(headers),
      body: body && body.length ? body : undefined,
      redirect: 'manual',
      signal: ctrl.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const outHeaders = filterResponseHeaders(res.headers);
    outHeaders['content-length'] = String(buf.length);
    return { status: res.status, statusText: res.statusText, headers: outHeaders, body: buf };
  } finally {
    clearTimeout(t);
  }
}

function parseHeaderBlock(buf) {
  const idx = buf.indexOf('\r\n\r\n');
  if (idx === -1) return null;
  const header = buf.subarray(0, idx).toString('latin1');
  const lines = header.split('\r\n');
  const [method, urlPath] = lines[0].split(' ');
  const headers = {};
  for (const line of lines.slice(1)) {
    const c = line.indexOf(':');
    if (c === -1) continue;
    headers[line.slice(0, c).trim()] = line.slice(c + 1).trim();
  }
  return { method, urlPath, headers, headerEnd: idx + 4 };
}

async function readHttpMessage(socket) {
  let buf = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const parsed = parseHeaderBlock(buf);
      if (!parsed) return;
      const len = Number(parsed.headers['content-length'] || 0);
      if (buf.length < parsed.headerEnd + len) return;
      socket.off('data', onData);
      socket.off('error', onErr);
      socket.off('end', onEnd);
      const body = buf.subarray(parsed.headerEnd, parsed.headerEnd + len);
      resolve({ ...parsed, body });
    };
    const onErr = (err) => reject(err);
    const onEnd = () => {
      if (!buf.length) return reject(Object.assign(new Error('socket ended'), { code: 'EPIPE' }));
      const parsed = parseHeaderBlock(buf);
      if (!parsed) return reject(new Error('incomplete HTTP request'));
      resolve({ ...parsed, body: buf.subarray(parsed.headerEnd) });
    };
    socket.on('data', onData);
    socket.on('error', onErr);
    socket.on('end', onEnd);
  });
}

function writeHttpResponse(socket, { status, statusText, headers, body }) {
  const lines = [`HTTP/1.1 ${status} ${statusText || ''}`.trim()];
  for (const [k, v] of Object.entries(headers || {})) {
    if (v == null) continue;
    lines.push(`${k}: ${v}`);
  }
  lines.push('', '');
  socket.write(lines.join('\r\n'));
  if (body?.length) socket.write(body);
}

async function handleDecrypted(tlsSock, origin) {
  while (!tlsSock.destroyed) {
    let req;
    try {
      req = await readHttpMessage(tlsSock);
    } catch {
      break;
    }
    try {
      const result = await fireproxFetch(origin, req.urlPath, req.method, req.headers, req.body);
      writeHttpResponse(tlsSock, result);
    } catch (err) {
      const msg = Buffer.from(String(err.message || err));
      writeHttpResponse(tlsSock, {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'content-type': 'text/plain', 'content-length': String(msg.length) },
        body: msg,
      });
      break;
    }
    if (/close/i.test(req.headers.connection || '')) break;
  }
}

async function handlePlainHttp(req, res) {
  try {
    const abs = req.url.startsWith('http') ? req.url : `http://${req.headers.host}${req.url}`;
    const u = new URL(abs);
    const origin = `${u.protocol}//${u.host}`;
    if (!hasFireproxForOrigin(origin)) {
      logPassthrough(u.hostname);
      const direct = await fetch(abs, {
        method: req.method,
        headers: filterRequestHeaders(req.headers),
        redirect: 'manual',
      });
      const buf = Buffer.from(await direct.arrayBuffer());
      const headers = filterResponseHeaders(direct.headers);
      headers['content-length'] = String(buf.length);
      res.writeHead(direct.status, headers);
      res.end(buf);
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const result = await fireproxFetch(origin, `${u.pathname}${u.search}`, req.method, req.headers, body);
    res.writeHead(result.status, result.headers);
    res.end(result.body);
  } catch (err) {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(String(err.message || err));
  }
}

export async function startFireproxLocalProxy() {
  if (server && listenUrl) return listenUrl;
  mitm = await generateMitmCa();

  server = http.createServer(handlePlainHttp);
  server.on('connect', async (req, clientSocket, head) => {
    const [host, portStr] = String(req.url || '').split(':');
    const port = Number(portStr || 443);
    const origin = port === 80 ? `http://${host}` : port === 443 ? `https://${host}` : `https://${host}:${port}`;
    if (!hasFireproxForOrigin(origin)) {
      logPassthrough(host);
      tunnelConnect(clientSocket, head, host, port);
      return;
    }
    try {
      const pair = await certForHost(host);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) clientSocket.unshift(head);
      const tlsSock = new tls.TLSSocket(clientSocket, {
        isServer: true,
        key: pair.key,
        cert: pair.cert,
        ALPNProtocols: ['http/1.1'],
      });
      tlsSock.on('error', () => clientSocket.destroy());
      await handleDecrypted(tlsSock, origin);
      tlsSock.end();
    } catch (err) {
      try {
        clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\n');
        clientSocket.end(String(err.message || err));
      } catch {
        clientSocket.destroy();
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      listenUrl = `http://127.0.0.1:${addr.port}`;
      console.log(`[fireprox] Local CONNECT proxy ${listenUrl} (AWS API Gateway per host)`);
      resolve();
    });
  });
  return listenUrl;
}

export function pinFireproxLocalProxy() {
  pins += 1;
}

export function unpinFireproxLocalProxy() {
  pins = Math.max(0, pins - 1);
}

export async function stopFireproxLocalProxy({ force = false } = {}) {
  if (!force && pins > 0) {
    console.warn(`[fireprox] Skipping local proxy teardown — ${pins} session(s) still using it`);
    return;
  }
  pins = 0;
  const s = server;
  server = null;
  listenUrl = null;
  if (!s) return;
  await new Promise((resolve) => s.close(() => resolve()));
}

export function getFireproxLocalProxyUrl() {
  return listenUrl;
}

export async function getFireproxPlaywrightProxy() {
  const serverUrl = await startFireproxLocalProxy();
  return {
    mode: 'aws-api',
    server: serverUrl,
    label: 'AWS API Gateway (FireProx)',
    ignoreHTTPSErrors: true,
  };
}
