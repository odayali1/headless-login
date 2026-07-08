import { encryptPassword, decryptPassword } from './credentials.js';
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

  // Coolify PROXY_URL always syncs into encrypted settings so the dashboard matches the env.
  if (process.env.PROXY_URL) {
    set.run('proxy_url_enc', encryptPassword(String(process.env.PROXY_URL).trim()));
  } else if (!settings.has('proxy_url_enc')) {
    set.run('proxy_url_enc', encryptPassword(DEFAULT_PROXY_URL));
  } else {
    const current = decryptPassword(settings.get('proxy_url_enc'));
    if (!current) {
      console.warn(
        '[settings] proxy_url_enc could not be decrypted — re-saving from default PROXY_URL. ' +
          'If account passwords fail too, set CREDENTIALS_KEY to match the machine that created the backup.'
      );
      set.run('proxy_url_enc', encryptPassword(DEFAULT_PROXY_URL));
    }
  }

  if (process.env.PROXY_ROTATE_URL) {
    set.run('proxy_rotate_url', String(process.env.PROXY_ROTATE_URL).trim());
  } else if (!settings.has('proxy_rotate_url')) {
    set.run('proxy_rotate_url', DEFAULT_ROTATE_URL);
  }
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
  // Coolify env always wins so redeploys can switch SOCKS↔HTTP without DB surgery.
  const fromEnv = String(process.env.PROXY_URL || '').trim();
  if (fromEnv) return fromEnv;

  const enc = store?.get('proxy_url_enc');
  if (enc) {
    const dec = decryptPassword(enc);
    if (dec) return dec;
  }
  return DEFAULT_PROXY_URL;
}

/** iProxy HTTP port — use with IPROXY_WIFI_SPLIT=1 when SOCKS relay stalls from the server. */
export function getProxyHttpUrl() {
  const fromEnv = String(process.env.PROXY_HTTP_URL || '').trim();
  return fromEnv || null;
}

export function isIproxyWifiSplitMode() {
  return /^(1|true|yes|on)$/i.test(String(process.env.IPROXY_WIFI_SPLIT || '').trim());
}

const MOBILE_RELAY_HOST_RE = /\.fxdx\.in$/i;

function proxyHostFromUrl(url) {
  if (!url) return '';
  try {
    return parseProxyUrl(url).host;
  } catch {
    return '';
  }
}

/**
 * iProxy / fxdx mobile relay — curl can be fast while Camoufox/Outlook SPA is slow
 * (especially with phone Wi‑Fi Split ON). Detect by host, not phone toggle.
 */
export function isMobileRelayProxy() {
  if (!isProxyEnabled()) return false;
  const hosts = [proxyHostFromUrl(getProxyUrl()), proxyHostFromUrl(getProxyHttpUrl())].filter(Boolean);
  return hosts.some((h) => MOBILE_RELAY_HOST_RE.test(h));
}

/** socks | http | auto — iProxy mobile relay defaults to SOCKS5 for Camoufox. */
export function getProxyPreferMode() {
  const prefer = String(process.env.PROXY_PREFER || '').trim().toLowerCase();
  if (prefer === 'socks' || prefer === 'http') return prefer;
  if (isMobileRelayProxy()) return 'socks';
  return 'auto';
}

export function setProxyUrl(url) {
  const parsed = parseProxyUrl(url);
  store?.set('proxy_url_enc', encryptPassword(String(url).trim()));
  return parsed;
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

/**
 * Supported formats:
 *   socks5://host:port:user:pass
 *   socks5://user:pass@host:port
 *   socks5h://user:pass@host:port
 *   http://host:port:user:pass
 *   http://user:pass@host:port
 * Optional rotate link suffix in brackets is stripped:
 *   http://host:port:user:pass[https://…/changeip/…]
 */
export function parseProxyUrl(url) {
  let raw = String(url || '').trim();
  raw = raw.replace(/\s*\[https?:\/\/[^\]]+\]\s*$/i, '').trim();

  let m = raw.match(/^(socks5h?|https?):\/\/([^:/@]+):(\d+):([^:]+):(.+)$/i);
  if (m) {
    const protocol = m[1].toLowerCase().startsWith('http') ? 'http' : 'socks5';
    return {
      protocol,
      host: m[2],
      port: Number(m[3]),
      username: m[4],
      password: m[5],
      server: `${protocol}://${m[2]}:${m[3]}`,
    };
  }

  m = raw.match(/^(socks5h?|https?):\/\/([^:@/]+):([^@/]+)@([^:/]+):(\d+)\/?$/i);
  if (m) {
    const protocol = m[1].toLowerCase().startsWith('http') ? 'http' : 'socks5';
    return {
      protocol,
      host: m[4],
      port: Number(m[5]),
      username: decodeURIComponent(m[2]),
      password: decodeURIComponent(m[3]),
      server: `${protocol}://${m[4]}:${m[5]}`,
    };
  }

  throw new Error(
    'Proxy must be http://host:port:user:pass or socks5://host:port:user:pass (curl user:pass@host form OK)'
  );
}

export function getPlaywrightProxy() {
  if (!isProxyEnabled()) return null;
  const url = getProxyUrl();
  if (!url) throw new Error('Proxy is ON but not configured.');
  const p = parseProxyUrl(url);
  return { server: p.server, username: p.username, password: p.password, protocol: p.protocol };
}

/** camoufox-js breaks socks5 URLs (server becomes null). SOCKS uses local relay; HTTP uses direct CONNECT auth. */
export async function applyProxyToLaunchOptions(fromOptions, { forceNewRelay = false } = {}) {
  delete fromOptions.proxy;

  if (!isProxyEnabled()) {
    return fromOptions;
  }

  const { getPlaywrightProxyConfig } = await import('./proxy-local.js');
  const cfg = await getPlaywrightProxyConfig({ forceNew: forceNewRelay });
  if (!cfg) return fromOptions;

  if (cfg.mode === 'http-direct') {
    fromOptions.proxy = {
      server: cfg.server,
      username: cfg.username,
      password: cfg.password,
    };
  } else {
    fromOptions.proxy = { server: cfg.server };
  }

  const prefs = {
    ...(fromOptions.firefoxUserPrefs || {}),
    'network.proxy.socks_remote_dns': true,
    'network.proxy.socks5_remote_dns': true,
    'network.http.http3.enable': false,
    'network.http.http3.enable_0rtt': false,
  };

  fromOptions.firefoxUserPrefs = prefs;
  return fromOptions;
}

export function assertProxyReady() {
  if (!isProxyEnabled()) return;
  getPlaywrightProxy();
}

/** Match proxy exit IP for timezone/locale/WebRTC (Camoufox geoip). Default on; set CAMOUFOX_GEOIP=0 to disable. */
export function isCamoufoxGeoipEnabled() {
  const v = String(process.env.CAMOUFOX_GEOIP ?? 'true').trim().toLowerCase();
  return !/^(0|false|no|off)$/.test(v);
}
