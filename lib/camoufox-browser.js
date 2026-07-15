import fs from 'node:fs/promises';
import path from 'node:path';
import { firefox } from 'playwright-core';
import { launchOptions as buildCamoufoxLaunchOptions } from 'camoufox-js';
import { getAccountFingerprint } from './anti-detect.js';
import { PROFILES_DIR, CANONICAL_TARGET } from './profile.js';
import { applyProxyToLaunchOptions as fixProxy, isCamoufoxGeoipEnabled, isProxyEnabled } from './settings.js';
import { assertProxyReady } from './proxy.js';
import { pinLocalProxyRelay, unpinLocalProxyRelay } from './proxy-local.js';
import { attachBandwidthSaver } from './bandwidth.js';

function platformOs(savedState) {
  // Accounts are logged in as Windows Firefox via Camoufox — keep that even on Linux Docker.
  // Using os:linux on the server broke imported sessions (Microsoft sees a different device).
  if (savedState?.cookies?.length || savedState?.camoufoxFingerprint) {
    return 'windows';
  }
  return process.platform === 'win32' ? 'windows' : 'linux';
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

/** Stable per-account Camoufox config — reused every session (does not re-randomize). */
function baseCamoufoxConfig(email, fingerprint, savedState, { forGeoip = false } = {}) {
  const fp = fingerprint || getAccountFingerprint(email);
  const config = {
    headless: true,
    humanize: true,
    os: platformOs(savedState),
    window: [fp.viewport.width, fp.viewport.height],
    block_webrtc: false,
    enable_cache: true,
  };
  // Manual locale fights geoip (Camoufox derives locale from proxy exit region).
  if (!forGeoip) {
    config.locale = fp.locale || 'en-US';
  }
  if (savedState?.camoufoxFingerprint) {
    config.fingerprint = savedState.camoufoxFingerprint;
  }
  return { config, fingerprint: fp };
}

export function firefoxProfileDir(email, _target) {
  const safe = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
  return path.join(PROFILES_DIR, 'firefox', `${safe}-${CANONICAL_TARGET}`);
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
 * Refresh CAMOU_CONFIG env + WebRTC prefs from proxy exit IP (not cached — IP can rotate).
 * Falls back silently so a slow geo lookup never blocks login.
 */
async function applyGeoipToLaunchOptions(launchOpts, email, fingerprint, savedState) {
  if (!isProxyEnabled() || !isCamoufoxGeoipEnabled() || !launchOpts.proxy?.server) {
    return false;
  }

  const { config } = baseCamoufoxConfig(email, fingerprint, savedState, { forGeoip: true });

  try {
    const geoOpts = sanitizeLaunchOptions(
      await buildCamoufoxLaunchOptions({
        ...config,
        geoip: true,
        proxy: launchOpts.proxy,
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
    console.log('[camoufox] geoip matched to proxy exit IP (timezone/locale/WebRTC)');
    return true;
  } catch (err) {
    console.warn(`[camoufox] geoip skipped (${err.message}) — using saved fingerprint locale`);
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

  // Always prefer cached launch-options — that IS the stable per-account Camoufox device.
  // regenerateFingerprint=true only when the profile is broken / user forces a new device.
  if (!regenerateFingerprint) {
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
  return { fromOptions, fingerprint: fp, config, reusedLaunchOptions: false };
}

/**
 * @param {object} opts
 * @param {boolean} [opts.forceFresh] - skip injecting saved cookies (password re-login)
 * @param {boolean} [opts.regenerateFingerprint] - rebuild Camoufox launch-options (new device). Default false.
 */
export async function launchCamoufoxSession({
  email,
  target,
  fingerprint,
  saved,
  forceFresh = false,
  regenerateFingerprint = false,
} = {}) {
  assertProxyReady();

  const { fromOptions, fingerprint: fp, config, reusedLaunchOptions } = await loadOrCreateLaunchOptions(
    email,
    target,
    fingerprint || saved?.state?.fingerprint,
    saved?.state,
    regenerateFingerprint === true
  );

  const launchOpts = structuredClone(fromOptions);
  stripProxyFromOptions(launchOpts);
  await patchExecutablePath(launchOpts, config);
  applyContainerFirefoxFixes(launchOpts);
  await fixProxy(launchOpts);
  const geoipApplied = await applyGeoipToLaunchOptions(
    launchOpts,
    email,
    fingerprint || saved?.state?.fingerprint,
    saved?.state
  );

  const browser = await firefox.launch(launchOpts);

  const contextOpts = {};
  if (!geoipApplied) {
    contextOpts.locale = fp.locale;
    contextOpts.timezoneId = fp.timezoneId;
  }

  // forceFresh = no cookies only. Fingerprint continuity is independent (launch-options.json).
  if (!forceFresh && saved?.state?.cookies?.length) {
    contextOpts.storageState = {
      cookies: saved.state.cookies,
      origins: saved.state.origins || [],
    };
  }

  const context = await browser.newContext(contextOpts);
  await attachBandwidthSaver(context);
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
    fingerprint: fp,
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
