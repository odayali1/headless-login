import { encryptPassword, decryptPassword } from './credentials.js';
const DEFAULT_MOBILE_PROXY_URL =
  process.env.PROXY_MOBILE_URL ||
  process.env.PROXY_URL ||
  'socks5://dlhnjqwtlv.cn.fxdx.in:17539:vibrantroot242733:Q1jObv2qgZlx';
/** @deprecated use DEFAULT_MOBILE_PROXY_URL — kept for older imports */
const DEFAULT_PROXY_URL = DEFAULT_MOBILE_PROXY_URL;
/**
 * Built-in IPv6 residential SOCKS for hybrid mode (Loki/MSAL HTTP only).
 * Cannot reach login.live.com — never use for Camoufox login / cookie SSO.
 * Override with PROXY_RESIDENTIAL_URL in Coolify if needed.
 */
export const BUILT_IN_RESIDENTIAL_PROXY_URL =
  'socks5://proxyapp:43cd061ec3283608d93b4505b2b2a7ef@77.237.239.187:8324';
const DEFAULT_RESIDENTIAL_PROXY_URL =
  String(process.env.PROXY_RESIDENTIAL_URL || '').trim() || BUILT_IN_RESIDENTIAL_PROXY_URL;
const DEFAULT_ROTATE_URL =
  process.env.PROXY_ROTATE_URL ||
  'https://i.fxdx.in/actionlinks/do/changeip/x5YFizXpTi-QHOFZaiv1Kw';

const settings = new Map();

export const ACCOUNTS_PER_IP = Number(process.env.PROXY_ROTATE_EVERY || 10);

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

  // Coolify PROXY_URL / PROXY_MOBILE_URL syncs into encrypted mobile settings.
  const mobileFromEnv = String(process.env.PROXY_MOBILE_URL || process.env.PROXY_URL || '').trim();
  if (mobileFromEnv) {
    set.run('proxy_url_enc', encryptPassword(mobileFromEnv));
  } else if (!settings.has('proxy_url_enc')) {
    set.run('proxy_url_enc', encryptPassword(DEFAULT_MOBILE_PROXY_URL));
  } else {
    const current = decryptPassword(settings.get('proxy_url_enc'));
    if (!current) {
      console.warn(
        '[settings] proxy_url_enc could not be decrypted — re-saving from default PROXY_URL. ' +
          'If account passwords fail too, set CREDENTIALS_KEY to match the machine that created the backup.'
      );
      set.run('proxy_url_enc', encryptPassword(DEFAULT_MOBILE_PROXY_URL));
    }
  }

  // Keep built-in / env residential URL available (hybrid + residential profile).
  if (!settings.has('proxy_residential_url_enc') || process.env.PROXY_RESIDENTIAL_URL) {
    set.run('proxy_residential_url_enc', encryptPassword(DEFAULT_RESIDENTIAL_PROXY_URL));
  }

  if (!settings.has('proxy_hybrid')) {
    const hy = String(process.env.PROXY_HYBRID || '').trim().toLowerCase();
    set.run('proxy_hybrid', /^(1|true|yes|on)$/i.test(hy) ? 'true' : 'false');
  }

  // PROXY_PROFILE sets the DEFAULT only when DB has no value.
  // Dashboard switch must stick — do NOT overwrite proxy_profile on every Coolify restart
  // (that locked users on broken residential and broke refresh/mobile).
  if (!settings.has('proxy_profile')) {
    const profileEnv = String(process.env.PROXY_PROFILE || '').trim().toLowerCase();
    set.run(
      'proxy_profile',
      profileEnv === 'residential' || profileEnv === 'mobile' ? profileEnv : 'mobile'
    );
  }
  // Optional: PROXY_PROFILE_LOCK=1 forces env on every boot (ignore dashboard).
  if (/^(1|true|yes|on)$/i.test(String(process.env.PROXY_PROFILE_LOCK || '').trim())) {
    const profileEnv = String(process.env.PROXY_PROFILE || '').trim().toLowerCase();
    if (profileEnv === 'residential' || profileEnv === 'mobile') {
      set.run('proxy_profile', profileEnv);
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

/**
 * Active proxy backend: mobile (iProxy) or residential (rotating SOCKS).
 * Dashboard/DB always wins at runtime so you can switch without redeploy.
 * Coolify PROXY_PROFILE is only the initial default (unless PROXY_PROFILE_LOCK=1).
 */
export function getProxyProfile() {
  if (/^(1|true|yes|on)$/i.test(String(process.env.PROXY_PROFILE_LOCK || '').trim())) {
    const fromEnv = String(process.env.PROXY_PROFILE || '').trim().toLowerCase();
    if (fromEnv === 'residential' || fromEnv === 'mobile') return fromEnv;
  }
  const fromDb = String(store?.get('proxy_profile') || '').trim().toLowerCase();
  if (fromDb === 'residential' || fromDb === 'mobile') return fromDb;
  const fromEnv = String(process.env.PROXY_PROFILE || '').trim().toLowerCase();
  if (fromEnv === 'residential' || fromEnv === 'mobile') return fromEnv;
  return 'mobile';
}

export function setProxyProfile(profile) {
  const next = String(profile || '').trim().toLowerCase() === 'residential' ? 'residential' : 'mobile';
  const prev = getProxyProfile();
  store?.set('proxy_profile', next);
  if (prev !== next) {
    // Drop cached SOCKS/HTTP mode so the next job cannot keep using the other profile's exit.
    import('./proxy-local.js')
      .then((m) => {
        m.resetProxyMode?.();
        return m.closeLocalProxy?.();
      })
      .catch(() => {});
  }
  return next;
}

export function isResidentialProxy() {
  // Hybrid uses residential only for browserless HTTP — browser path stays mobile.
  if (isHybridProxyEnabled()) return false;
  return getProxyProfile() === 'residential';
}

/**
 * Hybrid: Loki/MSAL HTTP via residential IPv6 SOCKS; login / Camoufox / cookie SSO via mobile.
 * Off by default — toggle from dashboard.
 */
export function isHybridProxyEnabled() {
  return store?.get('proxy_hybrid') === 'true';
}

export function setHybridProxyEnabled(enabled) {
  const next = !!enabled;
  const prev = isHybridProxyEnabled();
  store?.set('proxy_hybrid', next ? 'true' : 'false');
  if (next) {
    // Browser traffic must use mobile while hybrid is on.
    store?.set('proxy_profile', 'mobile');
  }
  if (prev !== next) {
    import('./proxy-local.js')
      .then((m) => {
        m.resetProxyMode?.();
        return Promise.all([m.closeLocalProxy?.(), m.closeResidentialRelay?.()]);
      })
      .catch(() => {});
  }
  return next;
}

export function getMobileProxyUrl() {
  const fromEnv = String(process.env.PROXY_MOBILE_URL || process.env.PROXY_URL || '').trim();
  if (fromEnv) return fromEnv;
  const enc = store?.get('proxy_url_enc');
  if (enc) {
    const dec = decryptPassword(enc);
    if (dec) return dec;
  }
  return DEFAULT_MOBILE_PROXY_URL;
}

export function getResidentialProxyUrl() {
  const fromEnv = String(process.env.PROXY_RESIDENTIAL_URL || '').trim();
  if (fromEnv) return fromEnv;
  const enc = store?.get('proxy_residential_url_enc');
  if (enc) {
    const dec = decryptPassword(enc);
    if (dec) return dec;
  }
  return BUILT_IN_RESIDENTIAL_PROXY_URL;
}

export function setResidentialProxyUrl(url) {
  store?.set('proxy_residential_url_enc', encryptPassword(String(url || '').trim()));
}

/** Active proxy URL for the selected profile (mobile or residential). */
export function getProxyUrl() {
  if (isResidentialProxy()) {
    const res = getResidentialProxyUrl();
    if (!res) {
      throw new Error(
        'PROXY_PROFILE=residential but PROXY_RESIDENTIAL_URL is empty — set the rotating SOCKS URL.'
      );
    }
    return res;
  }
  return getMobileProxyUrl();
}

const MOBILE_RELAY_HOST_RE = /\.fxdx\.in$/i;

/**
 * iProxy HTTP CONNECT fallback only — NEVER used when PROXY_PROFILE=residential
 * (Coolify often still has PROXY_HTTP_URL=fxdx :16857 which would steal the session).
 */
export function getProxyHttpUrl() {
  if (isResidentialProxy()) return null;

  const fromEnv = String(process.env.PROXY_HTTP_URL || '').trim();
  if (fromEnv) return fromEnv;

  // iProxy mobile: HTTP CONNECT is usually SOCKS port − 682 (17539 → 16857).
  try {
    const main = parseProxyUrl(getMobileProxyUrl());
    if (MOBILE_RELAY_HOST_RE.test(main.host) && String(main.protocol).startsWith('socks')) {
      const httpPort = Number(main.port) - 682;
      if (httpPort > 0) {
        return `http://${main.host}:${httpPort}:${main.username}:${main.password}`;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export function isIproxyWifiSplitMode() {
  return /^(1|true|yes|on)$/i.test(String(process.env.IPROXY_WIFI_SPLIT || '').trim());
}

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
  if (!isProxyEnabled() || isResidentialProxy()) return false;
  const hosts = [proxyHostFromUrl(getMobileProxyUrl()), proxyHostFromUrl(getProxyHttpUrl())].filter(Boolean);
  return hosts.some((h) => MOBILE_RELAY_HOST_RE.test(h));
}

/** socks | http | auto — residential is always SOCKS; iProxy mobile defaults to SOCKS5. */
export function getProxyPreferMode() {
  if (isResidentialProxy()) return 'socks';
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
  const hybrid = isHybridProxyEnabled();
  const profile = hybrid ? 'mobile' : getProxyProfile();
  let parsed = null;
  let residential = null;
  try {
    parsed = parseProxyUrl(hybrid ? getMobileProxyUrl() : getProxyUrl());
  } catch {
    // invalid / residential not configured
  }
  try {
    residential = parseProxyUrl(getResidentialProxyUrl());
  } catch {
    // ignore
  }
  return {
    enabled: isProxyEnabled(),
    profile,
    hybrid,
    residentialConfigured: !!residential,
    residentialHost: residential ? residential.host : null,
    residentialPort: residential ? residential.port : null,
    rotatesPerRequest: !hybrid && profile === 'residential',
    configured: !!parsed,
    host: parsed ? parsed.host : null,
    port: parsed ? parsed.port : null,
    username: parsed ? parsed.username : null,
    accountsOnCurrentIp: !hybrid && profile === 'residential' ? 0 : getAccountsOnIp(),
    rotateAfter: !hybrid && profile === 'residential' ? 0 : getRotateAfter(),
    rotateUrl: !hybrid && profile === 'residential' ? null : getRotateUrl(),
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
