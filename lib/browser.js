import { launchCamoufoxSession } from './camoufox-browser.js';
import { assertProxyReady } from './proxy.js';

/** All automation uses Camoufox — stealth Firefox with stable per-account profile. */
export function resolveEngine(_engine = 'auto') {
  return 'camoufox';
}

export async function connectBrowser({ email, target, fingerprint, saved, forceFresh } = {}) {
  assertProxyReady();
  const session = await launchCamoufoxSession({ email, target, fingerprint, saved, forceFresh });
  return {
    ...session,
    cdpUrl: null,
  };
}

export function getDefaultEngine() {
  return 'camoufox';
}
