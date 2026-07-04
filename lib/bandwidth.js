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

  context.on('response', (response) => {
    try {
      const req = response.request();
      const out = req.postDataBuffer()?.length || 0;
      const len = Number(response.headers()['content-length'] || 0);
      recordBandwidth(len > 0 ? len : 0, out);
    } catch {
      // ignore
    }
  });

  await context.route('**/*', (route) => {
    const req = route.request();
    if (shouldBlock(req.resourceType(), req.url())) {
      recordBlockedRequest();
      return route.abort();
    }
    return route.continue();
  });
}
