import fs from 'node:fs/promises';
import path from 'node:path';
import { firefox } from 'playwright-core';
import { launchOptions as buildCamoufoxLaunchOptions } from 'camoufox-js';
import { getAccountFingerprint } from './anti-detect.js';
import { PROFILES_DIR } from './profile.js';
import { applyProxyToLaunchOptions as fixProxy } from './settings.js';
import { assertProxyReady } from './proxy.js';

function platformOs() {
  return process.platform === 'win32' ? 'windows' : 'linux';
}

/** Stable per-account Camoufox config — reused every session (does not re-randomize). */
function baseCamoufoxConfig(email, fingerprint, savedState) {
  const fp = fingerprint || getAccountFingerprint(email);
  const config = {
    headless: true,
    humanize: true,
    os: platformOs(),
    locale: fp.locale || 'en-US',
    window: [fp.viewport.width, fp.viewport.height],
    block_webrtc: false,
    enable_cache: true,
  };
  if (savedState?.camoufoxFingerprint) {
    config.fingerprint = savedState.camoufoxFingerprint;
  }
  // Proxy is applied at launch via local HTTP relay — never pass to camoufox-js (socks5 breaks).
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
  return opts;
}

async function isExecutableStale(exe) {
  if (!exe) return false;
  if (process.platform === 'win32') {
    if (exe.startsWith('/') && !exe.includes(':\\')) return true;
  } else if (exe.includes(':\\') || /\.exe$/i.test(exe)) {
    return true;
  }
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

async function loadOrCreateLaunchOptions(email, target, fingerprint, savedState, forceFresh) {
  const optsFile = launchOptionsPath(email, target);
  const { config, fingerprint: fp } = baseCamoufoxConfig(email, fingerprint, savedState);

  if (!forceFresh) {
    try {
      const cached = sanitizeLaunchOptions(JSON.parse(await fs.readFile(optsFile, 'utf8')));
      if (isBrokenProxy(cached)) stripProxyFromOptions(cached);
      if (!(await isExecutableStale(cached.executablePath))) {
        return { fromOptions: cached, fingerprint: fp };
      }
    } catch {
      // create fresh options below
    }
  }

  await fs.mkdir(path.dirname(optsFile), { recursive: true });
  const fromOptions = sanitizeLaunchOptions(await buildCamoufoxLaunchOptions(config));
  await fs.writeFile(optsFile, JSON.stringify(fromOptions, null, 2));
  return { fromOptions, fingerprint: fp };
}

export async function launchCamoufoxSession({ email, target, fingerprint, saved, forceFresh }) {
  assertProxyReady();

  const { fromOptions, fingerprint: fp } = await loadOrCreateLaunchOptions(
    email,
    target,
    fingerprint || saved?.state?.fingerprint,
    saved?.state,
    forceFresh
  );

  const launchOpts = structuredClone(fromOptions);
  stripProxyFromOptions(launchOpts);
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
    const pkg = await import('camoufox-js/dist/pkgman.js');
    return typeof pkg.installedVerStr === 'function' && !!pkg.installedVerStr();
  } catch {
    return false;
  }
}

/** Remove broken, stale, or cross-platform launch-options.json files. */
export async function repairAllLaunchOptions() {
  const firefoxDir = path.join(PROFILES_DIR, 'firefox');
  let sanitized = 0;
  let cleared = 0;
  try {
    const dirs = await fs.readdir(firefoxDir);
    for (const dir of dirs) {
      const file = path.join(firefoxDir, dir, 'launch-options.json');
      try {
        const data = JSON.parse(await fs.readFile(file, 'utf8'));
        if (await isExecutableStale(data.executablePath)) {
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
      } catch {
        // skip missing/invalid
      }
    }
  } catch {
    // no firefox dir
  }
  if (sanitized) console.log(`[camoufox] Sanitized ${sanitized} launch-options.json file(s)`);
  if (cleared) {
    console.log(
      `[camoufox] Cleared ${cleared} stale launch-options (wrong OS path) — regenerates on next browser launch`
    );
  }
}
