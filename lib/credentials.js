import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

const ALGO = 'aes-256-gcm';
const KEY_FILE = path.join(DATA_DIR, '.credentials-key');

function keyFromEnv() {
  const fromEnv = process.env.CREDENTIALS_KEY?.trim();
  if (!fromEnv) return null;
  return crypto.createHash('sha256').update(fromEnv).digest();
}

function keyFromFile() {
  if (!fs.existsSync(KEY_FILE)) return null;
  try {
    return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
  } catch {
    return null;
  }
}

function keysEqual(a, b) {
  return a && b && a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** All keys that may have encrypted existing rows (env hash + imported .credentials-key file). */
function getDecryptKeys() {
  const keys = [];
  const envKey = keyFromEnv();
  const fileKey = keyFromFile();
  if (envKey) keys.push(envKey);
  if (fileKey && !keys.some((k) => keysEqual(k, fileKey))) keys.push(fileKey);
  if (!keys.length) {
    const generated = crypto.randomBytes(32);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KEY_FILE, generated.toString('hex'), { mode: 0o600 });
    console.warn(`[credentials] Generated encryption key at ${KEY_FILE} — set CREDENTIALS_KEY in production.`);
    keys.push(generated);
  }
  return keys;
}

/** Primary key for new encryptions: env if set, else file, else generated. */
function getEncryptKey() {
  return getDecryptKeys()[0];
}

export function encryptPassword(plain) {
  const KEY = getEncryptKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptWithKey(payload, KEY) {
  const [ivHex, tagHex, dataHex] = payload.split(':');
  if (!ivHex || !tagHex || !dataHex) return null;
  const decipher = crypto.createDecipheriv(ALGO, KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return dec.toString('utf8');
}

export function decryptPassword(payload) {
  if (!payload) return null;
  for (const key of getDecryptKeys()) {
    try {
      const plain = decryptWithKey(payload, key);
      if (plain) return plain;
    } catch {
      // try next key
    }
  }
  return null;
}

export function canDecryptCredentials() {
  return getDecryptKeys().length > 0;
}
