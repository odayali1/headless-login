import { isProxyEnabled, isMobileRelayProxy, useSessionOnlyTokenPath } from './settings.js';

const DEFAULT_NAV_MS = Number(process.env.PROXY_NAV_TIMEOUT_MS || 45_000);
const MOBILE_NAV_MS = Number(
  process.env.PROXY_MOBILE_NAV_TIMEOUT_MS ||
    process.env.PROXY_WIFI_SPLIT_NAV_TIMEOUT_MS ||
    120_000
);

/** Navigation timeout — login and refresh must share this on mobile relay proxies. */
export function navTimeoutMs() {
  if (isProxyEnabled() && isMobileRelayProxy()) return MOBILE_NAV_MS;
  return DEFAULT_NAV_MS;
}

export function domContentLoadedTimeoutMs() {
  if (isProxyEnabled() && isMobileRelayProxy()) return 60_000;
  return 30_000;
}

export function msalReadyTimeoutMs() {
  if (isProxyEnabled() && isMobileRelayProxy()) return 60_000;
  return 35_000;
}

export function captureTimeoutMs({ refreshTokenKnownBad = false, slowProxyPath = false } = {}) {
  if (slowProxyPath) return Number(process.env.PROXY_SLOW_CAPTURE_TIMEOUT_MS || 300_000);
  if (useSessionOnlyTokenPath()) return 180_000;
  if (refreshTokenKnownBad) return 90_000;
  if (isProxyEnabled()) return 90_000;
  return 150_000;
}

export function skipPlaywrightHttpRefresh() {
  return useSessionOnlyTokenPath();
}
