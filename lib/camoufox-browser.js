import fs from 'node:fs/promises';
import path from 'node:path';
import { firefox } from 'playwright-core';
import { launchOptions as buildCamoufoxLaunchOptions } from 'camoufox-js';
import { getAccountFingerprint, resolveAccountFingerprint } from './anti-detect.js';
import { PROFILES_DIR, CANONICAL_TARGET } from './profile.js';
import { applyProxyToLaunchOptions as fixProxy, isCamoufoxGeoipEnabled, isProxyEnabled } from './settings.js';
import { assertProxyReady, probeExitIp } from './proxy.js';
import { pinLocalProxyRelay, unpinLocalProxyRelay } from './proxy-local.js';
import { attachBandwidthSaver } from './bandwidth.js';

/**
 * Camoufox OS for BrowserForge — always Windows.
 * Coolify runs Linux, but os:"linux" makes every new Docker account a Linux Firefox device.
 * Docs: fingerprint must be internally consistent; Microsoft sees the spoofed OS, not the host.
 * @see https://camoufox.com/ — "Consistent" design principle
 */
function platformOs() {
  return 'windows';
}

/** Bump when Camoufox device policy changes (forces one-time BrowserForge rebuild). */
const DEVICE_POLICY_VERSION = 2;

function deviceModePath(email, target) {
  return path.join(firefoxProfileDir(email, target), 'device-mode.json');
}

async function readCachedDeviceMode(email, target) {
  try {
    const data = JSON.parse(await fs.readFile(deviceModePath(email, target), 'utf8'));
    return {
      mimicPhone: !!data?.mimicPhone,
      version: Number(data?.version) || 0,
    };
  } catch {
    return null;
  }
}

async function writeCachedDeviceMode(email, target, mimicPhone) {
  const file = deviceModePath(email, target);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({ mimicPhone: !!mimicPhone, version: DEVICE_POLICY_VERSION }, null, 2)
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
 * Pro usage (camoufox.com):
 * - os: windows (stable) — not host linux
 * - Do NOT fix window size (docs: fixed window → fingerprinting); let BrowserForge pick
 * - geoip+proxy spoofs timezone/locale/WebRTC IP — prefer that over block_webrtc
 * - block_webrtc only as last resort (absence of WebRTC is itself a signal)
 * - phone-sized window on desktop Firefox OS is inconsistent (docs warn) — avoid for bulk
 */
function baseCamoufoxConfig(email, fingerprint, savedState, { forGeoip = false } = {}) {
  const mimicPhone = !!(fingerprint?.mimicPhone ?? savedState?.mimicPhone);
  const fp =
    fingerprint && !!fingerprint.mimicPhone === mimicPhone
      ? fingerprint
      : getAccountFingerprint(email, { mimicPhone });

  const config = {
    headless: true,
    humanize: true,
    os: platformOs(),
    // Constrain screen so BrowserForge varies window uniquely inside a desktop range.
    // Do not set `window:[w,h]` for desktop — Camoufox docs warn fixed window clusters fingerprints.
    screen: {
      minWidth: 1280,
      maxWidth: 1920,
      minHeight: 720,
      maxHeight: 1080,
    },
    // Pro path: geoip spoofs WebRTC to exit IP. Blocking WebRTC is a last resort.
    block_webrtc: false,
    enable_cache: true,
  };

  // Phone mimic: Camoufox has no android/ios — mobile CSS on desktop Firefox is inconsistent.
  // Only apply fixed window when user explicitly forces phone mode (not for 10k bulk).
  if (mimicPhone) {
    config.window = [fp.viewport.width, fp.viewport.height];
    delete config.screen;
  }

  // Manual locale fights geoip (Camoufox derives locale from proxy exit region).
  // Only set locale when geoip is off / unavailable.
  if (!forGeoip && !isCamoufoxGeoipEnabled()) {
    config.locale = fp.locale || 'en-US';
  }

  if (savedState?.camoufoxFingerprint) {
    config.fingerprint = savedState.camoufoxFingerprint;
  }
  return { config, fingerprint: fp };
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
 * Refresh CAMOU_CONFIG env + WebRTC IP spoof from proxy exit (not cached — IP rotates).
 * Official path: geoip=true|exitIp + proxy → timezone, locale, WebRTC match exit IP.
 * @see https://camoufox.com/python/geoip/
 */
async function applyGeoipToLaunchOptions(launchOpts, email, fingerprint, savedState) {
  if (!isProxyEnabled() || !isCamoufoxGeoipEnabled() || !launchOpts.proxy?.server) {
    return false;
  }

  const { config } = baseCamoufoxConfig(email, fingerprint, savedState, { forGeoip: true });

  try {
    // Prefer explicit exit IP — more reliable than auto-detect through nested SOCKS relay.
    const exitIp = await probeExitIp().catch(() => null);
    const geoOpts = sanitizeLaunchOptions(
      await buildCamoufoxLaunchOptions({
        ...config,
        geoip: exitIp || true,
        proxy: launchOpts.proxy,
        block_webrtc: false,
      })
    );

    const sandboxEnv = {
      MOZ_DISABLE_CONTENT_SANDBOX: launchOpts.env?.MOZ_DISABLE_CONTENT_SANDBOX,
      MOZ_DISABLE_GMP_SANDBOX: launchOpts.env?.MOZ_DISABLE_GMP_SANDBOX,
      DISPLAY: launchOpts.env?.DISPLAY,
    };

    launchOpts.env = { ...geoOpts.env, ...Object.fromEntries(Object.entries(sandboxEnv).filter(([, v]) => v != null)) };
    launchOpts.firefoxUserPrefs = {
      ...geoOpts.firefoxUserPrefs,
      ...launchOpts.firefoxUserPrefs,
    };
    // Ensure WebRTC stays enabled so Camoufox can spoof ICE to the exit IP (not block).
    if (launchOpts.firefoxUserPrefs) {
      delete launchOpts.firefoxUserPrefs['media.peerconnection.enabled'];
    }
    console.log(
      exitIp
        ? `[camoufox] geoip matched exit IP ${exitIp} (timezone/locale/WebRTC spoof — pro path)`
        : '[camoufox] geoip auto-matched to proxy exit (timezone/locale/WebRTC spoof — pro path)'
    );
    return true;
  } catch (err) {
    console.warn(`[camoufox] geoip skipped (${err.message}) — locale/WebRTC may mismatch proxy`);
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
  const { config, fingerprint: fp } = baseCamoufoxConfig(email, fingerprint, savedState);
  const wantPhone = !!fp.mimicPhone;

  // Phone/desktop / policy version change must rebuild (old caches: linux OS + 5 shared windows).
  const cachedMode = await readCachedDeviceMode(email, target);
  let mustRebuild = regenerateFingerprint === true;
  if (cachedMode === null) {
    // Missing sidecar — rebuild once onto DEVICE_POLICY_VERSION (unique BrowserForge device).
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
        return { fromOptions: cached, fingerprint: fp, config, reusedLaunchOptions: true };
      }
    } catch {
      // create fresh options below
    }
  }

  await fs.mkdir(path.dirname(optsFile), { recursive: true });
  const fromOptions = sanitizeLaunchOptions(await buildCamoufoxLaunchOptions(config));
  await fs.writeFile(optsFile, JSON.stringify(fromOptions, null, 2));
  await writeCachedDeviceMode(email, target, wantPhone);
  return { fromOptions, fingerprint: fp, config, reusedLaunchOptions: false };
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

  const { fromOptions, fingerprint: resolvedFp, config, reusedLaunchOptions } = await loadOrCreateLaunchOptions(
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
  // Do NOT force-disable WebRTC here — geoip path spoofs ICE to the exit IP (pro Camoufox usage).
  const geoipApplied = await applyGeoipToLaunchOptions(
    launchOpts,
    email,
    resolvedFp,
    { ...savedState, mimicPhone: resolvedFp.mimicPhone }
  );

  const browser = await firefox.launch(launchOpts);

  const contextOpts = {};
  // Only apply our anti-detect locale/TZ when geoip did not (avoids US TZ on MENA mobile IP).
  if (!geoipApplied) {
    contextOpts.locale = resolvedFp.locale;
    contextOpts.timezoneId = resolvedFp.timezoneId;
  }

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

  return {
    engine: 'camoufox',
    browser,
    context,
    page,
    persistent: false,
    profileDir: firefoxProfileDir(email, target),
    fingerprint: resolvedFp,
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
