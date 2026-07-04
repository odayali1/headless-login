/** Reduce mobile-proxy traffic by blocking heavy assets; keep HTML/JS/XHR for login & MSAL. */

import { recordBandwidth, recordBlockedRequest } from './bandwidth-stats.js';

const BLOCKED_TYPES = new Set(['image', 'media', 'font']);
const TELEMETRY_RE = /telemetry|analytics|clarity\.ms|bing\.com\/.*\/collect|doubleclick|googletagmanager/i;
const HEAVY_EXT_RE = /\.(gif|webp|ico|woff2?|ttf|otf|eot)(\?|$)/i;

function shouldBlock(type, url) {
  if (/login\.(live|microsoftonline|microsoft)\.com/i.test(url)) {
    return type === 'image' || type === 'media';
  }
  if (BLOCKED_TYPES.has(type)) return true;
  if (HEAVY_EXT_RE.test(url)) return true;
  if (TELEMETRY_RE.test(url)) return true;
  return false;
}

export async function attachBandwidthSaver(context) {
  if (!context || context.__bandwidthSaver) return;
  context.__bandwidthSaver = true;

  await context.route('**/*', async (route) => {
    const req = route.request();
    const type = req.resourceType();
    const url = req.url();

    if (shouldBlock(type, url)) {
      recordBlockedRequest();
      return route.abort();
    }

    const outBytes = req.postDataBuffer()?.length || 0;
    try {
      const response = await route.fetch();
      const body = await response.body();
      recordBandwidth(body.length, outBytes);
      await route.fulfill({ response });
    } catch {
      recordBandwidth(0, outBytes);
      await route.continue().catch(() => {});
    }
  });
}
