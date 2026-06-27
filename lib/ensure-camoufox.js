import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isCamoufoxAvailable } from './camoufox-browser.js';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function defaultInstallDir() {
  if (process.env.CAMOUFOX_INSTALL_DIR) return process.env.CAMOUFOX_INSTALL_DIR;
  const data = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return path.join(data, 'camoufox');
}

function runFetch() {
  return new Promise((resolve) => {
    const child = spawn('npx', ['camoufox-js', 'fetch'], {
      stdio: 'inherit',
      env: process.env,
      shell: process.platform === 'win32',
    });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

/**
 * Download Camoufox once into persistent storage (not at Docker build time).
 * Skips if already present unless CAMOUFOX_FORCE_FETCH=1.
 */
export async function ensureCamoufoxInstalled() {
  const installDir = defaultInstallDir();
  process.env.CAMOUFOX_INSTALL_DIR = installDir;
  await fs.mkdir(installDir, { recursive: true });

  const force = process.env.CAMOUFOX_FORCE_FETCH === '1' || process.env.CAMOUFOX_FORCE_FETCH === 'true';

  if (!force && (await isCamoufoxAvailable())) {
    console.log(`[camoufox] Ready (${installDir})`);
    return true;
  }

  if (force) {
    console.log('[camoufox] CAMOUFOX_FORCE_FETCH set — re-downloading…');
  } else {
    console.log(`[camoufox] Not found — downloading to ${installDir} (one-time, persisted on data volume)…`);
  }

  const maxAttempts = Number(process.env.CAMOUFOX_FETCH_RETRIES || 8);
  const waitMs = Number(process.env.CAMOUFOX_FETCH_RETRY_MS || 30_000);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ok = await runFetch();
    if (ok && (await isCamoufoxAvailable())) {
      console.log('[camoufox] Install complete');
      return true;
    }
    if (attempt < maxAttempts) {
      console.warn(`[camoufox] Fetch attempt ${attempt}/${maxAttempts} failed — retry in ${Math.round(waitMs / 1000)}s…`);
      await sleep(waitMs);
    }
  }

  console.error('[camoufox] Install failed after all retries. Check outbound HTTPS from the server.');
  return false;
}
