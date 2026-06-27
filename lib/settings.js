import { encryptPassword, decryptPassword } from './credentials.js';
import { getLocalProxyForBrowser } from './proxy-local.js';

const DEFAULT_PROXY_URL =
  process.env.PROXY_URL ||
  'socks5://dlhnjqwtlv.cn.fxdx.in:17539:vibrantroot242733:Q1jObv2qgZlx';
const DEFAULT_ROTATE_URL =
  process.env.PROXY_ROTATE_URL ||
  'https://i.fxdx.in/actionlinks/do/changeip/x5YFizXpTi-QHOFZaiv1Kw';

const settings = new Map();

export const ACCOUNTS_PER_IP = 5;

export function randomRotateAfter() {
  return ACCOUNTS_PER_IP;
}

export function initSettings(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const get = db.prepare('SELECT value FROM settings WHERE key = ?');
  const set = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    settings.set(row.key, row.value);
  }

  if (!settings.has('proxy_enabled')) set.run('proxy_enabled', 'true');
  if (!settings.has('proxy_url_enc')) set.run('proxy_url_enc', encryptPassword(DEFAULT_PROXY_URL));
  if (!settings.has('proxy_rotate_url')) set.run('proxy_rotate_url', DEFAULT_ROTATE_URL);
  if (!settings.has('accounts_on_ip')) set.run('accounts_on_ip', '0');
  if (!settings.has('rotate_after')) set.run('rotate_after', String(ACCOUNTS_PER_IP));
  set.run('rotate_after', String(ACCOUNTS_PER_IP));
  if (!settings.has('smart_refresh_enabled')) set.run('smart_refresh_enabled', 'true');

  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    settings.set(row.key, row.value);
  }

  return {
    get(key) {
      return settings.get(key);
    },
    set(key, value) {
      settings.set(key, String(value));
      set.run(key, String(value));
    },
  };
}

let store = null;

export function bindSettingsStore(s) {
  store = s;
}

export function isProxyEnabled() {
  return store?.get('proxy_enabled') === 'true';
}

export function setProxyEnabled(enabled) {
  store?.set('proxy_enabled', enabled ? 'true' : 'false');
}

export function getProxyUrl() {
  const enc = store?.get('proxy_url_enc');
  if (!enc) return null;
  return decryptPassword(enc);
}

export function getRotateUrl() {
  return store?.get('proxy_rotate_url') || DEFAULT_ROTATE_URL;
}

export function getAccountsOnIp() {
  return Number(store?.get('accounts_on_ip') || 0);
}

export function setAccountsOnIp(n) {
  store?.set('accounts_on_ip', String(n));
}

export function getRotateAfter() {
  return Number(store?.get('rotate_after') || ACCOUNTS_PER_IP);
}

export function isSmartRefreshEnabled() {
  return store?.get('smart_refresh_enabled') !== 'false';
}

export function setSmartRefreshEnabled(enabled) {
  store?.set('smart_refresh_enabled', enabled ? 'true' : 'false');
}

export function setRotateAfter(n) {
  store?.set('rotate_after', String(n));
}

export function getProxyStatus() {
  const url = getProxyUrl();
  let parsed = null;
  try {
    parsed = url ? parseProxyUrl(url) : null;
  } catch {
    // invalid
  }
  return {
    enabled: isProxyEnabled(),
    configured: !!parsed,
    host: parsed ? parsed.host : null,
    port: parsed ? parsed.port : null,
    username: parsed ? parsed.username : null,
    accountsOnCurrentIp: getAccountsOnIp(),
    rotateAfter: getRotateAfter(),
    rotateUrl: getRotateUrl(),
  };
}

/** socks5://host:port:user:pass */
export function parseProxyUrl(url) {
  const raw = String(url || '').trim();
  const m = raw.match(/^socks5:\/\/([^:/]+):(\d+):([^:]+):(.+)$/i);
  if (!m) throw new Error('Proxy must be socks5://host:port:user:pass');
  return {
    host: m[1],
    port: Number(m[2]),
    username: m[3],
    password: m[4],
    server: `socks5://${m[1]}:${m[2]}`,
  };
}

export function getPlaywrightProxy() {
  if (!isProxyEnabled()) return null;
  const url = getProxyUrl();
  if (!url) throw new Error('Proxy is ON but not configured.');
  const p = parseProxyUrl(url);
  return { server: p.server, username: p.username, password: p.password };
}

/** camoufox-js breaks socks5 URLs (server becomes null). Route via local HTTP relay for Firefox. */
export async function applyProxyToLaunchOptions(fromOptions) {
  delete fromOptions.proxy;

  if (!isProxyEnabled()) {
    return fromOptions;
  }

  const localProxy = await getLocalProxyForBrowser();
  fromOptions.proxy = { server: localProxy };

  fromOptions.firefoxUserPrefs = {
    ...(fromOptions.firefoxUserPrefs || {}),
    'network.proxy.socks_remote_dns': true,
  };
  return fromOptions;
}

export function assertProxyReady() {
  if (!isProxyEnabled()) return;
  getPlaywrightProxy();
}
