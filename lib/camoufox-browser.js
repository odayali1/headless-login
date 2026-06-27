import fs from 'node:fs/promises';
import path from 'node:path';
import { firefox } from 'playwright-core';
import { launchOptions as buildCamoufoxLaunchOptions } from 'camoufox-js';
import { getAccountFingerprint } from './anti-detect.js';
import { PROFILES_DIR } from './profile.js';
import { applyProxyToLaunchOptions as fixProxy } from './settings.js';
import { assertProxyReady } from './proxy.js';

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
function baseCamoufoxConfig(email, fingerprint, savedState) {
  const fp = fingerprint || getAccountFingerprint(email);
  const config = {
    headless: true,
    humanize: true,
    os: platformOs(savedState),
    locale: fp.locale || 'en-US',
    window: [fp.viewport.width, fp.viewport.height],
    block_webrtc: false,
    enable_cache: true,
  };
  if (savedState?.camoufoxFingerprint) {
    config.fingerprint = savedState.camoufoxFingerprint;
  }
  return { config, fingerprint: fp };
}

export function firefoxProfileDir(email, target) {
  const safe = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
  return path.join(PROFILES_DIR, 'firefox', `${safe}-${target}`);
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

async function loadOrCreateLaunchOptions(email, target, fingerprint, savedState, forceFresh) {
  const optsFile = launchOptionsPath(email, target);
  const { config, fingerprint: fp } = baseCamoufoxConfig(email, fingerprint, savedState);

  if (!forceFresh) {
    try {
      const cached = sanitizeLaunchOptions(JSON.parse(await fs.readFile(optsFile, 'utf8')));
      if (isBrokenProxy(cached)) stripProxyFromOptions(cached);
      if (!(await isLaunchOptionsStale(cached))) {
        await patchExecutablePath(cached, config);
        return { fromOptions: cached, fingerprint: fp, config };
      }
    } catch {
      // create fresh options below
    }
  }

  await fs.mkdir(path.dirname(optsFile), { recursive: true });
  const fromOptions = sanitizeLaunchOptions(await buildCamoufoxLaunchOptions(config));
  await fs.writeFile(optsFile, JSON.stringify(fromOptions, null, 2));
  return { fromOptions, fingerprint: fp, config };
}

export async function launchCamoufoxSession({ email, target, fingerprint, saved, forceFresh }) {
  assertProxyReady();

  const { fromOptions, fingerprint: fp, config } = await loadOrCreateLaunchOptions(
    email,
    target,
    fingerprint || saved?.state?.fingerprint,
    saved?.state,
    forceFresh
  );

  const launchOpts = structuredClone(fromOptions);
  stripProxyFromOptions(launchOpts);
  await patchExecutablePath(launchOpts, config);
  applyContainerFirefoxFixes(launchOpts);
  await fixProxy(launchOpts);

  const browser = await firefox.launch(launchOpts);

  const contextOpts = {
    locale: fp.locale,
    timezoneId: fp.timezoneId,
  };

  if (!forceFresh && saved?.state?.cookies?.length) {
    contextOpts.storageState = {
      cookies: saved.state.cookies,
      origins: saved.state.origins || [],
    };
  }

  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();

  return {
    engine: 'camoufox',
    browser,
    context,
    page,
    persistent: false,
    profileDir: firefoxProfileDir(email, target),
    fingerprint: fp,
    close: async () => {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
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
