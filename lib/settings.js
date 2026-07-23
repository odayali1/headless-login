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
/** DataImpulse residential IPv4 — safe for Camoufox login (unlike hybrid IPv6). */
export const BUILT_IN_RESIDENTIAL_IPV4_PROXY_URL =
  'socks5://7c0f7e7e9347e4d38b37:aeb91a2e66b62ff6@gw.dataimpulse.com:10000';
const DEFAULT_RESIDENTIAL_PROXY_URL =
  String(process.env.PROXY_RESIDENTIAL_URL || '').trim() || BUILT_IN_RESIDENTIAL_PROXY_URL;
const DEFAULT_ROTATE_URL =
  process.env.PROXY_ROTATE_URL ||
  'https://i.fxdx.in/actionlinks/do/changeip/Is0bVUFyRyOOLVOPDO0Nog';

/**
 * Named login proxies. Selecting one writes into the existing mobile/residential/
 * rotate slots — login / Camoufox / rotateProxyIp keep using the same getters.
 */
export const BUILT_IN_PROXY_PRESETS = Object.freeze([
  Object.freeze({
    id: 'huawei-old',
    name: 'Huawei old',
    kind: 'mobile',
    url: 'socks5://dlhnjqwtlv.cn.fxdx.in:17539:vibrantroot242733:Q1jObv2qgZlx',
    rotateUrl: 'https://i.fxdx.in/actionlinks/do/changeip/Is0bVUFyRyOOLVOPDO0Nog',
  }),
  Object.freeze({
    id: 'samsung-new',
    name: 'New Samsung',
    kind: 'mobile',
    url: 'socks5://icj5kdzbdn.cn.fxdx.in:15247:vibrantroot210325:dWDabtvSf0tn',
    rotateUrl: 'https://i.fxdx.in/actionlinks/do/changeip/8xIake_5SJGWcHNP2Dg_Aw',
  }),
  Object.freeze({
    id: 'residential-ipv4',
    name: 'Residential IPv4',
    kind: 'residential',
    url: BUILT_IN_RESIDENTIAL_IPV4_PROXY_URL,
    rotateUrl: null,
  }),
]);

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

  // Keep built-in / env residential URL available (hybrid Loki IPv6 only — never login IPv4).
  if (!settings.has('proxy_residential_url_enc') || process.env.PROXY_RESIDENTIAL_URL) {
    set.run('proxy_residential_url_enc', encryptPassword(DEFAULT_RESIDENTIAL_PROXY_URL));
  } else {
    // Heal if an earlier preset write put DataImpulse IPv4 into the hybrid IPv6 slot.
    try {
      const cur = decryptPassword(settings.get('proxy_residential_url_enc') || '');
      if (cur && /dataimpulse\.com/i.test(cur)) {
        set.run('proxy_residential_url_enc', encryptPassword(BUILT_IN_RESIDENTIAL_PROXY_URL));
        console.warn('[settings] Restored hybrid residential slot to built-in IPv6 (was DataImpulse IPv4)');
      }
    } catch {
      // ignore
    }
  }

  // Login-only residential IPv4 (Camoufox). Separate from hybrid Loki IPv6.
  if (!settings.has('proxy_login_residential_url_enc')) {
    set.run('proxy_login_residential_url_enc', encryptPassword(BUILT_IN_RESIDENTIAL_IPV4_PROXY_URL));
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

  // Seed / reconcile named preset id from current URLs (env may have overwritten slots).
  {
    const profile = String(settings.get('proxy_profile') || 'mobile').trim().toLowerCase();
    const mobileUrl = (() => {
      const enc = settings.get('proxy_url_enc');
      return enc ? decryptPassword(enc) || '' : '';
    })();
    const loginResidentialUrl = (() => {
      const enc = settings.get('proxy_login_residential_url_enc');
      return enc ? decryptPassword(enc) || '' : '';
    })();
    const rotateUrl = String(settings.get('proxy_rotate_url') || '').trim();
    const storedPreset = String(settings.get('proxy_active_preset') || '').trim();
    // Prefer stored preset when it is a known id (IPv4 login must not depend on hybrid IPv6 URL).
    let next = storedPreset && BUILT_IN_PROXY_PRESETS.some((p) => p.id === storedPreset) ? storedPreset : '';
    if (!next) {
      next =
        matchProxyPresetId({
          profile,
          mobileUrl,
          loginResidentialUrl,
          rotateUrl,
          activePresetId: storedPreset,
        }) || 'huawei-old';
    }
    const current = storedPreset;
    if (next !== current) {
      set.run('proxy_active_preset', next);
      settings.set('proxy_active_preset', next);
    } else if (!settings.has('proxy_active_preset')) {
      set.run('proxy_active_preset', next);
      settings.set('proxy_active_preset', next);
    }
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
  // Hybrid bookkeeping: browserless HTTP uses IPv6 via lane; this flag means
  // "Camoufox/login uses residential IPv4" only when hybrid is OFF.
  // When hybrid is ON + IPv4 login, isLoginResidentialIpv4() is still true for login URL.
  if (isHybridProxyEnabled()) return false;
  return isLoginResidentialIpv4();
}

/**
 * Hybrid: Loki/MSAL HTTP via residential IPv6 SOCKS; cookie SSO via mobile.
 * Camoufox login can be mobile OR residential IPv4 (separate slot) — hybrid stays on.
 */
export function isHybridProxyEnabled() {
  return store?.get('proxy_hybrid') === 'true';
}

export function setHybridProxyEnabled(enabled) {
  const next = !!enabled;
  const prev = isHybridProxyEnabled();
  store?.set('proxy_hybrid', next ? 'true' : 'false');
  if (next) {
    // Keep profile=mobile for hybrid bookkeeping; login preset (incl. IPv4) is separate.
    store?.set('proxy_profile', 'mobile');
  }
  if (prev !== next) {
    import('./proxy-local.js')
      .then((m) => {
        m.resetProxyMode?.();
        return Promise.all([m.closeLocalProxy?.(), m.closeResidentialRelay?.(), m.closeMobileCookieRelay?.()]);
      })
      .catch(() => {});
  }
  return next;
}

export function getMobileProxyUrl() {
  // Prefer DB at runtime so dashboard preset switching works.
  // Coolify PROXY_URL / PROXY_MOBILE_URL still sync into DB on every boot.
  const enc = store?.get('proxy_url_enc');
  if (enc) {
    const dec = decryptPassword(enc);
    if (dec) return dec;
  }
  const fromEnv = String(process.env.PROXY_MOBILE_URL || process.env.PROXY_URL || '').trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_MOBILE_PROXY_URL;
}

/** Hybrid Loki/MSAL only — built-in IPv6 (or PROXY_RESIDENTIAL_URL). Never login IPv4. */
export function getResidentialProxyUrl() {
  const enc = store?.get('proxy_residential_url_enc');
  if (enc) {
    const dec = decryptPassword(enc);
    if (dec) return dec;
  }
  const fromEnv = String(process.env.PROXY_RESIDENTIAL_URL || '').trim();
  if (fromEnv) return fromEnv;
  return BUILT_IN_RESIDENTIAL_PROXY_URL;
}

export function setResidentialProxyUrl(url) {
  store?.set('proxy_residential_url_enc', encryptPassword(String(url || '').trim()));
}

/** DataImpulse IPv4 — Camoufox login only. */
export function getLoginResidentialProxyUrl() {
  const enc = store?.get('proxy_login_residential_url_enc');
  if (enc) {
    const dec = decryptPassword(enc);
    if (dec) return dec;
  }
  return BUILT_IN_RESIDENTIAL_IPV4_PROXY_URL;
}

export function setLoginResidentialProxyUrl(url) {
  store?.set('proxy_login_residential_url_enc', encryptPassword(String(url || '').trim()));
}

/** True when dashboard login preset is Residential IPv4 (hybrid may still be ON). */
export function isLoginResidentialIpv4() {
  return getActiveProxyPresetId() === 'residential-ipv4';
}

/**
 * Proxy used for Camoufox login: mobile phone OR residential IPv4.
 * Not used for hybrid Loki (IPv6) or cookie SSO (mobile).
 */
export function getLoginProxyUrl() {
  if (isLoginResidentialIpv4()) {
    const res = getLoginResidentialProxyUrl();
    if (!res) {
      throw new Error('Residential IPv4 login proxy is not configured.');
    }
    return res;
  }
  return getMobileProxyUrl();
}

/** Active Camoufox/login proxy URL (alias of getLoginProxyUrl). */
export function getProxyUrl() {
  return getLoginProxyUrl();
}

const MOBILE_RELAY_HOST_RE = /\.fxdx\.in$/i;

/**
 * iProxy HTTP CONNECT fallback only — NEVER used when PROXY_PROFILE=residential
 * (Coolify often still has PROXY_HTTP_URL=fxdx :16857 which would steal the session).
 */
export function getProxyHttpUrl() {
  // Never fall back to mobile HTTP CONNECT when Camoufox login is residential IPv4.
  if (isLoginResidentialIpv4() || isResidentialProxy()) return null;

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
  if (!isProxyEnabled() || isLoginResidentialIpv4() || isResidentialProxy()) return false;
  const hosts = [proxyHostFromUrl(getMobileProxyUrl()), proxyHostFromUrl(getProxyHttpUrl())].filter(Boolean);
  return hosts.some((h) => MOBILE_RELAY_HOST_RE.test(h));
}

/** socks | http | auto — residential IPv4 login is always SOCKS; iProxy mobile defaults to SOCKS5. */
export function getProxyPreferMode() {
  if (isLoginResidentialIpv4() || isResidentialProxy()) return 'socks';
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

export function setRotateUrl(url) {
  const next = String(url || '').trim();
  if (!next) throw new Error('rotate URL is required');
  store?.set('proxy_rotate_url', next);
  return next;
}

function proxyEndpointKey(url) {
  if (!url) return '';
  try {
    const p = parseProxyUrl(url);
    return `${p.host}:${p.port}`.toLowerCase();
  } catch {
    return String(url).trim().toLowerCase();
  }
}

/** Match a built-in preset from current profile + URLs (host:port). */
export function matchProxyPresetId({
  profile,
  mobileUrl,
  loginResidentialUrl,
  residentialUrl,
  rotateUrl,
  activePresetId,
} = {}) {
  const stored = String(activePresetId || '').trim();
  if (stored === 'residential-ipv4') return 'residential-ipv4';

  const loginResKey = proxyEndpointKey(loginResidentialUrl || '');
  const ipv4Key = proxyEndpointKey(BUILT_IN_RESIDENTIAL_IPV4_PROXY_URL);
  if (loginResKey && loginResKey === ipv4Key && stored === 'residential-ipv4') {
    return 'residential-ipv4';
  }

  // Legacy: profile=residential used to mean full residential (now login IPv4).
  const prof = String(profile || 'mobile').trim().toLowerCase();
  if (prof === 'residential') {
    return 'residential-ipv4';
  }

  const mobileKey = proxyEndpointKey(mobileUrl);
  const rot = String(rotateUrl || '').trim();
  const byUrlAndRotate = BUILT_IN_PROXY_PRESETS.find(
    (p) =>
      p.kind === 'mobile' &&
      proxyEndpointKey(p.url) === mobileKey &&
      (!p.rotateUrl || !rot || p.rotateUrl === rot)
  );
  if (byUrlAndRotate) return byUrlAndRotate.id;
  const byUrl = BUILT_IN_PROXY_PRESETS.find(
    (p) => p.kind === 'mobile' && proxyEndpointKey(p.url) === mobileKey
  );
  return byUrl?.id || null;
}

export function listProxyPresets() {
  return BUILT_IN_PROXY_PRESETS.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    canRotate: p.kind === 'mobile' && !!p.rotateUrl,
    host: (() => {
      try {
        return parseProxyUrl(p.url).host;
      } catch {
        return null;
      }
    })(),
    port: (() => {
      try {
        return parseProxyUrl(p.url).port;
      } catch {
        return null;
      }
    })(),
  }));
}

export function getProxyPresetById(id) {
  const wanted = String(id || '').trim();
  return BUILT_IN_PROXY_PRESETS.find((p) => p.id === wanted) || null;
}

export function getActiveProxyPresetId() {
  const stored = String(store?.get('proxy_active_preset') || '').trim();
  if (stored && getProxyPresetById(stored)) return stored;
  const matched = matchProxyPresetId({
    profile: getProxyProfile(),
    mobileUrl: getMobileProxyUrl(),
    loginResidentialUrl: getLoginResidentialProxyUrl(),
    rotateUrl: getRotateUrl(),
    activePresetId: stored,
  });
  return matched || 'huawei-old';
}

/**
 * Switch login proxy by named preset.
 * Residential IPv4 → login slot only (does NOT touch hybrid or Loki IPv6).
 * Mobile presets → mobile URL + rotate; hybrid left as-is.
 */
export function selectProxyPreset(id) {
  const preset = getProxyPresetById(id);
  if (!preset) throw new Error(`Unknown proxy preset: ${id}`);
  parseProxyUrl(preset.url);

  if (preset.kind === 'residential') {
    setLoginResidentialProxyUrl(preset.url);
    // Login IPv4 only — keep hybrid ON and keep Loki on built-in IPv6.
    store?.set('proxy_profile', 'mobile');
  } else {
    setProxyUrl(preset.url);
    if (preset.rotateUrl) setRotateUrl(preset.rotateUrl);
    store?.set('proxy_profile', 'mobile');
  }

  store?.set('proxy_active_preset', preset.id);
  setAccountsOnIp(0);

  import('./proxy-local.js')
    .then((m) => {
      m.resetProxyMode?.();
      // Only tear down login/Camoufox relay — do not kill hybrid Loki IPv6 relay.
      return Promise.all([m.closeLocalProxy?.(), m.closeMobileCookieRelay?.()]);
    })
    .catch(() => {});

  let host = null;
  let port = null;
  try {
    const p = parseProxyUrl(preset.url);
    host = p.host;
    port = p.port;
  } catch {
    // ignore
  }
  return {
    id: preset.id,
    name: preset.name,
    kind: preset.kind,
    host,
    port,
    canRotate: preset.kind === 'mobile' && !!preset.rotateUrl,
  };
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
  const loginIpv4 = isLoginResidentialIpv4();
  // Status "profile" for UI: residential only when login is IPv4 and hybrid is off.
  const profile = loginIpv4 && !hybrid ? 'residential' : hybrid || !loginIpv4 ? 'mobile' : 'mobile';
  let parsed = null;
  let residential = null;
  try {
    parsed = parseProxyUrl(getLoginProxyUrl());
  } catch {
    // invalid
  }
  try {
    residential = parseProxyUrl(getResidentialProxyUrl());
  } catch {
    // ignore
  }
  const activePresetId = getActiveProxyPresetId();
  const activePreset = getProxyPresetById(activePresetId);
  // Rotate = mobile changeip. Available for mobile login, or for hybrid cookie phone while login is IPv4.
  const canRotate = !!isProxyEnabled() && (!loginIpv4 || hybrid);
  return {
    enabled: isProxyEnabled(),
    profile,
    hybrid,
    loginResidentialIpv4: loginIpv4,
    residentialConfigured: !!residential,
    residentialHost: residential ? residential.host : null,
    residentialPort: residential ? residential.port : null,
    rotatesPerRequest: loginIpv4,
    configured: !!parsed,
    host: parsed ? parsed.host : null,
    port: parsed ? parsed.port : null,
    username: parsed ? parsed.username : null,
    accountsOnCurrentIp: loginIpv4 && !hybrid ? 0 : getAccountsOnIp(),
    rotateAfter: loginIpv4 && !hybrid ? 0 : getRotateAfter(),
    rotateUrl: loginIpv4 && !hybrid ? null : getRotateUrl(),
    activePresetId,
    activePresetName: activePreset?.name || null,
    canRotate,
    presets: listProxyPresets(),
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
