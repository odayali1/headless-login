import fs from 'node:fs/promises';
import path from 'node:path';
import { firefox } from 'playwright-core';
import { launchOptions as buildCamoufoxLaunchOptions } from 'camoufox-js';
import { getAccountFingerprint, resolveAccountFingerprint } from './anti-detect.js';
import { PROFILES_DIR, CANONICAL_TARGET } from './profile.js';
import { applyProxyToLaunchOptions as fixProxy, isCamoufoxGeoipEnabled, isProxyEnabled } from './settings.js';
import { assertProxyReady } from './proxy.js';
import { probeExitIp } from './proxy-exit-ip.js';
import { pinLocalProxyRelay, unpinLocalProxyRelay } from './proxy-local.js';
import { attachBandwidthSaver } from './bandwidth.js';

/**
 * Jul 13 working bulk path: always Windows Firefox fingerprint (not host linux).
 * Mobile window sizes stay opt-in via mimicPhone (Camoufox has no android/ios).
 */
function pickAccountOs(_email = '', preferred = null) {
  if (preferred === 'macos' || preferred === 'windows') return preferred;
  return 'windows';
}

/** Bump when Camoufox device policy changes (forces one-time BrowserForge rebuild). */
const DEVICE_POLICY_VERSION = 7;

function deviceModePath(email, target) {
  return path.join(firefoxProfileDir(email, target), 'device-mode.json');
}

async function readCachedDeviceMode(email, target) {
  try {
    const data = JSON.parse(await fs.readFile(deviceModePath(email, target), 'utf8'));
    return {
      mimicPhone: !!data?.mimicPhone,
      version: Number(data?.version) || 0,
      os: data?.os === 'macos' || data?.os === 'windows' ? data.os : null,
    };
  } catch {
    return null;
  }
}

async function writeCachedDeviceMode(email, target, { mimicPhone, os }) {
  const file = deviceModePath(email, target);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify(
      {
        mimicPhone: !!mimicPhone,
        os: os === 'macos' ? 'macos' : 'windows',
        version: DEVICE_POLICY_VERSION,
      },
      null,
      2
    )
  );
}

/** Windows paths saved in profiles break Linux/Docker launches. */
export function isForeignExecutable(exe) {
  if (!exe) return false;
  const s = String(exe);
  if (process.platform === 'win32') {
    return s.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(s);
  }
  return /^[A-Za-z]:/i.test(s) || /\.exe$/i.test(s);
}

/**
 * Per-account Camoufox config — BrowserForge builds a unique device into launch-options.json.
 *
 * Pro usage (camoufox.com) for mass login:
 * - sticky os per email (windows|macos) — not host linux, not re-roll every login
 * - Do NOT fix window size (docs: fixed window → fingerprinting); let BrowserForge pick
 * - geoip+proxy spoofs timezone/locale/WebRTC IP — prefer that over block_webrtc
 * - block_webrtc only if geoip failed (never leak Coolify host IP)
 * - phone-sized window on desktop Firefox OS is inconsistent (docs warn) — avoid for bulk
 */
function baseCamoufoxConfig(email, fingerprint, savedState, { forGeoip = false, os } = {}) {
  const mimicPhone = !!(fingerprint?.mimicPhone ?? savedState?.mimicPhone);
  const fp =
    fingerprint && !!fingerprint.mimicPhone === mimicPhone
      ? fingerprint
      : getAccountFingerprint(email, { mimicPhone });
  const accountOs = pickAccountOs(email, os);

  const config = {
    headless: true,
    // Jul 13: humanize true (boolean). Sticky per-account window below.
    humanize: true,
    os: accountOs,
    // Jul 13 working bulk path: sticky per-account window from email fingerprint.
    window: [fp.viewport.width, fp.viewport.height],
    // Pro path: geoip spoofs WebRTC to exit IP. Blocking WebRTC is a last resort.
    block_webrtc: false,
    enable_cache: true,
  };

  // Phone mimic overrides desktop window with phone CSS size (opt-in only).
  if (mimicPhone) {
    config.window = [fp.viewport.width, fp.viewport.height];
  }

  // Manual locale fights geoip (Camoufox derives locale from proxy exit region).
  // Only set locale when geoip is off / unavailable.
  if (!forGeoip && !isCamoufoxGeoipEnabled()) {
    config.locale = fp.locale || 'en-US';
  }

  if (savedState?.camoufoxFingerprint) {
    config.fingerprint = savedState.camoufoxFingerprint;
  }
  return { config, fingerprint: fp, os: accountOs };
}

export function firefoxTabDir(email, _target) {
  const safe = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
  return path.join(PROFILES_DIR, 'firefox', `${safe}-${CANONICAL_TARGET}`);
}

export function firefoxProfileDir(email, target) {
  return firefoxTabDir(email, target);
}

function launchOptionsPath(email, target) {
  return path.join(firefoxProfileDir(email, target), 'launch-options.json');
}

function stripProxyFromOptions(opts) {
  if (!opts) return opts;
  delete opts.proxy;
  if (opts.firefoxUserPrefs) {
    for (const key of Object.keys(opts.firefoxUserPrefs)) {
      if (key.startsWith('network.proxy.')) {
        delete opts.firefoxUserPrefs[key];
      }
    }
  }
  return opts;
}

function sanitizeLaunchOptions(opts) {
  if (!opts) return opts;
  stripProxyFromOptions(opts);
  if (opts.env) {
    const kept = {};
    for (const [key, value] of Object.entries(opts.env)) {
      if (key.startsWith('CAMOU_CONFIG')) kept[key] = value;
    }
    opts.env = kept;
  }
  if (isForeignExecutable(opts.executablePath)) {
    delete opts.executablePath;
  }
  return opts;
}

async function isLaunchOptionsStale(opts) {
  if (!opts) return true;
  if (isForeignExecutable(opts.executablePath)) return true;
  const exe = opts.executablePath;
  if (!exe) return false;
  try {
    await fs.access(exe);
    return false;
  } catch {
    return true;
  }
}

function isBrokenProxy(opts) {
  const s = opts?.proxy?.server;
  return s === 'null' || s === 'undefined';
}

async function patchExecutablePath(launchOpts, config) {
  const fresh = sanitizeLaunchOptions(await buildCamoufoxLaunchOptions(config));
  if (fresh.executablePath) {
    launchOpts.executablePath = fresh.executablePath;
  } else {
    delete launchOpts.executablePath;
  }
}

/**
 * camoufox-js launchOptions({ geoip: true|ip }) ALWAYS re-fetches via Impit publicIP()
 * and ignores a passed IP string — that fails on many residential/IPv6 exits.
 * We probe the exit ourselves (curl through SOCKS, IPv4+IPv6) and merge MaxMind geo into CAMOU_CONFIG.
 */
function hardenWebRtcNoLeak(launchOpts) {
  launchOpts.firefoxUserPrefs = {
    ...(launchOpts.firefoxUserPrefs || {}),
    'media.peerconnection.enabled': false,
  };
}

function readCamouConfigEnv(env = {}) {
  const parts = [];
  for (let i = 1; i < 32; i++) {
    const chunk = env[`CAMOU_CONFIG_${i}`];
    if (chunk == null) break;
    parts.push(String(chunk));
  }
  if (!parts.length && env.CAMOU_CONFIG) {
    try {
      return JSON.parse(String(env.CAMOU_CONFIG));
    } catch {
      return {};
    }
  }
  if (!parts.length) return {};
  try {
    return JSON.parse(parts.join(''));
  } catch {
    return {};
  }
}

function writeCamouConfigEnv(env, config) {
  for (const key of Object.keys(env)) {
    if (key === 'CAMOU_CONFIG' || key.startsWith('CAMOU_CONFIG_')) delete env[key];
  }
  const raw = JSON.stringify(config);
  const chunkSize = process.platform === 'win32' ? 2047 : 32767;
  let n = 0;
  for (let i = 0; i < raw.length; i += chunkSize) {
    n += 1;
    env[`CAMOU_CONFIG_${n}`] = raw.slice(i, i + chunkSize);
  }
  return env;
}

async function applyGeoipToLaunchOptions(launchOpts, email, fingerprint, savedState, accountOs) {
  if (!isProxyEnabled() || !isCamoufoxGeoipEnabled() || !launchOpts.proxy?.server) {
    hardenWebRtcNoLeak(launchOpts);
    return false;
  }

  try {
    const exitIp = await probeExitIp();
    if (!exitIp) {
      throw new Error('could not resolve exit IP through proxy (tried IPv4+IPv6 endpoints)');
    }

    const { getGeolocation } = await import('camoufox-js/dist/locale.js');
    const { validIPv4, validIPv6 } = await import('camoufox-js/dist/ip.js');
    const geo = await getGeolocation(exitIp);
    const geoConfig = geo.asConfig();

    launchOpts.env = { ...(launchOpts.env || {}) };
    const camou = readCamouConfigEnv(launchOpts.env);
    Object.assign(camou, geoConfig);
    if (validIPv4(exitIp)) {
      camou['webrtc:ipv4'] = exitIp;
      delete camou['webrtc:ipv6'];
    } else if (validIPv6(exitIp)) {
      camou['webrtc:ipv6'] = exitIp;
      delete camou['webrtc:ipv4'];
    }
    writeCamouConfigEnv(launchOpts.env, camou);

    launchOpts.firefoxUserPrefs = {
      ...(launchOpts.firefoxUserPrefs || {}),
    };
    delete launchOpts.firefoxUserPrefs['media.peerconnection.enabled'];
    if (validIPv4(exitIp)) {
      launchOpts.firefoxUserPrefs['network.dns.disableIPv6'] = true;
    }

    console.log(
      `[camoufox] geoip matched exit IP ${exitIp} tz=${geoConfig.timezone || '?'} (WebRTC spoof — bypassed broken camoufox-js publicIP)`
    );
    return true;
  } catch (err) {
    hardenWebRtcNoLeak(launchOpts);
    console.warn(
      `[camoufox] geoip skipped (${err.message}) — WebRTC blocked so Coolify host IP cannot leak`
    );
    return false;
  }
}

/** Docker/VPS: disable Firefox sandbox + ensure env vars (clone() EPERM in containers). */
function applyContainerFirefoxFixes(opts) {
  if (process.platform === 'win32') return opts;
  opts.env = {
    ...(opts.env || {}),
    MOZ_DISABLE_CONTENT_SANDBOX: '1',
    MOZ_DISABLE_GMP_SANDBOX: '1',
  };
  opts.firefoxUserPrefs = {
    ...(opts.firefoxUserPrefs || {}),
    'security.sandbox.content.level': 0,
    'security.sandbox.plugin.level': 0,
  };
  return opts;
}

async function loadOrCreateLaunchOptions(email, target, fingerprint, savedState, regenerateFingerprint) {
  const optsFile = launchOptionsPath(email, target);
  const cachedMode = await readCachedDeviceMode(email, target);
  const accountOs = pickAccountOs(email, cachedMode?.os);
  const { config, fingerprint: fp, os } = baseCamoufoxConfig(email, fingerprint, savedState, {
    os: accountOs,
  });
  const wantPhone = !!fp.mimicPhone;

  // Phone/desktop / policy version change must rebuild (old caches: linux OS + fixed windows).
  let mustRebuild = regenerateFingerprint === true;
  if (cachedMode === null) {
    mustRebuild = true;
  } else if (cachedMode.mimicPhone !== wantPhone) {
    mustRebuild = true;
  } else if (cachedMode.version < DEVICE_POLICY_VERSION) {
    mustRebuild = true;
  }

  // Prefer cached launch-options — that IS the stable per-account Camoufox device.
  if (!mustRebuild) {
    try {
      const cached = sanitizeLaunchOptions(JSON.parse(await fs.readFile(optsFile, 'utf8')));
      if (isBrokenProxy(cached)) stripProxyFromOptions(cached);
      if (!(await isLaunchOptionsStale(cached))) {
        await patchExecutablePath(cached, config);
        return { fromOptions: cached, fingerprint: fp, config, os, reusedLaunchOptions: true };
      }
    } catch {
      // create fresh options below
    }
  }

  await fs.mkdir(path.dirname(optsFile), { recursive: true });
  const fromOptions = sanitizeLaunchOptions(await buildCamoufoxLaunchOptions(config));
  await fs.writeFile(optsFile, JSON.stringify(fromOptions, null, 2));
  await writeCachedDeviceMode(email, target, { mimicPhone: wantPhone, os });
  return { fromOptions, fingerprint: fp, config, os, reusedLaunchOptions: false };
}

/**
 * @param {object} opts
 * @param {boolean} [opts.forceFresh] - skip injecting saved cookies (password re-login)
 * @param {boolean} [opts.regenerateFingerprint] - rebuild Camoufox launch-options (new device). Default false.
 * @param {boolean} [opts.mimicPhone] - mobile-sized Camoufox window; inconsistent with desktop OS — avoid for bulk
 */
export async function launchCamoufoxSession({
  email,
  target,
  fingerprint,
  saved,
  forceFresh = false,
  regenerateFingerprint = false,
  mimicPhone,
  /** Password login: skip Playwright network route interception (can aggravate gct=429). */
  saveBandwidth = true,
} = {}) {
  assertProxyReady();

  const savedState = saved?.state || null;
  const fp = resolveAccountFingerprint(
    email,
    fingerprint || savedState?.fingerprint,
    typeof mimicPhone === 'boolean' ? mimicPhone : undefined
  );
  const modeChanged =
    typeof mimicPhone === 'boolean' &&
    !!mimicPhone !== !!(savedState?.mimicPhone ?? savedState?.fingerprint?.mimicPhone);

  if (fp.mimicPhone) {
    console.warn(
      `[camoufox] phone mimic for ${email}: mobile window on desktop Firefox OS — Camoufox docs warn this is inconsistent; prefer desktop for bulk login`
    );
  }

  const { fromOptions, fingerprint: resolvedFp, config, os: accountOs, reusedLaunchOptions } =
    await loadOrCreateLaunchOptions(
      email,
      target,
      fp,
      { ...savedState, mimicPhone: fp.mimicPhone },
      regenerateFingerprint === true || modeChanged
    );

  const launchOpts = structuredClone(fromOptions);
  stripProxyFromOptions(launchOpts);
  await patchExecutablePath(launchOpts, config);
  applyContainerFirefoxFixes(launchOpts);
  await fixProxy(launchOpts);
  // geoip spoofs WebRTC to exit IP; if geoip fails we block WebRTC (no Coolify IP leak).
  const geoipApplied = await applyGeoipToLaunchOptions(
    launchOpts,
    email,
    resolvedFp,
    { ...savedState, mimicPhone: resolvedFp.mimicPhone },
    accountOs
  );

  const browser = await firefox.launch(launchOpts);

  const contextOpts = {};
  // Never paint US/UK locale/TZ when geoip failed — that mismatches MENA mobile exit and farms us.
  // Camoufox CAMOU_CONFIG from launch-options already carries Intl when geoip succeeded.

  // forceFresh = no cookies only. Fingerprint continuity is independent (launch-options.json).
  if (!forceFresh && saved?.state?.cookies?.length) {
    contextOpts.storageState = {
      cookies: saved.state.cookies,
      origins: saved.state.origins || [],
    };
  }

  const context = await browser.newContext(contextOpts);
  // Login path: no route() abort — keep GetCredentialType traffic looking like a normal browser.
  await attachBandwidthSaver(context, { enabled: saveBandwidth !== false });
  const page = await context.newPage();
  pinLocalProxyRelay();
  let unpinned = false;
  const unpin = () => {
    if (unpinned) return;
    unpinned = true;
    unpinLocalProxyRelay();
  };

  if (!reusedLaunchOptions) {
    console.log(`[camoufox] New device for ${email}: os=${accountOs} (sticky — kept on every later login)`);
  }

  return {
    engine: 'camoufox',
    browser,
    context,
    page,
    persistent: false,
    profileDir: firefoxProfileDir(email, target),
    fingerprint: resolvedFp,
    camoufoxOs: accountOs,
    reusedLaunchOptions: !!reusedLaunchOptions,
    close: async () => {
      try {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
      } finally {
        unpin();
      }
    },
  };
}

export async function isCamoufoxAvailable() {
  try {
    const fresh = await buildCamoufoxLaunchOptions({ headless: true, os: 'windows' });
    return !!fresh.executablePath && !isForeignExecutable(fresh.executablePath);
  } catch {
    return false;
  }
}

/** Remove broken or cross-platform launch-options.json files (e.g. after Windows → Linux import). */
export async function repairAllLaunchOptions() {
  const firefoxDir = path.join(PROFILES_DIR, 'firefox');
  let sanitized = 0;
  let cleared = 0;
  try {
    const dirs = await fs.readdir(firefoxDir);
    for (const dir of dirs) {
      const file = path.join(firefoxDir, dir, 'launch-options.json');
      try {
        const raw = await fs.readFile(file, 'utf8');
        const data = JSON.parse(raw);
        if (isForeignExecutable(data.executablePath) || (await isLaunchOptionsStale(data))) {
          await fs.unlink(file);
          cleared += 1;
          continue;
        }
        const before = JSON.stringify(data);
        sanitizeLaunchOptions(data);
        if (JSON.stringify(data) !== before) {
          await fs.writeFile(file, JSON.stringify(data, null, 2));
          sanitized += 1;
        }
      } catch (err) {
        if (err?.code !== 'ENOENT') {
          try {
            await fs.unlink(file);
            cleared += 1;
          } catch {
            // skip
          }
        }
      }
    }
  } catch {
    // no firefox dir
  }
  if (sanitized) console.log(`[camoufox] Sanitized ${sanitized} launch-options.json file(s)`);
  if (cleared) {
    console.log(
      `[camoufox] Cleared ${cleared} stale launch-options (wrong OS / missing binary) — regenerates on next launch`
    );
  }
}
