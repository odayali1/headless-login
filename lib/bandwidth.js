/** Reduce mobile-proxy traffic by blocking heavy assets; keep HTML/JS/XHR for login & MSAL. */

const BLOCKED_TYPES = new Set(['image', 'media', 'font']);
const TELEMETRY_RE = /telemetry|analytics|clarity\.ms|bing\.com\/.*\/collect|doubleclick|googletagmanager/i;
const HEAVY_EXT_RE = /\.(gif|webp|ico|woff2?|ttf|otf|eot)(\?|$)/i;

export async function attachBandwidthSaver(context) {
  if (!context || context.__bandwidthSaver) return;
  context.__bandwidthSaver = true;

  await context.route('**/*', (route) => {
    const req = route.request();
    const type = req.resourceType();
    const url = req.url();

    if (BLOCKED_TYPES.has(type)) return route.abort();
    if (HEAVY_EXT_RE.test(url)) return route.abort();
    if (TELEMETRY_RE.test(url)) return route.abort();

    return route.continue();
  });
}
