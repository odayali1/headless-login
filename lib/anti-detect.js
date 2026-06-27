import crypto from 'node:crypto';

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
];

const CHROME_BUILDS = ['145.0.0.0', '146.0.0.0', '147.0.0.0', '148.0.0.0', '149.0.0.0'];

/** Stable per-account fingerprint so each account looks like its own device. */
export function getAccountFingerprint(email) {
  const hash = crypto.createHash('sha256').update(email.toLowerCase().trim()).digest();
  const n = hash.readUInt32BE(0);

  const viewport = VIEWPORTS[n % VIEWPORTS.length];
  const chromeVer = CHROME_BUILDS[n % CHROME_BUILDS.length];

  return {
    seed: hash.toString('hex').slice(0, 16),
    viewport,
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`,
    locale: n % 2 === 0 ? 'en-US' : 'en-GB',
    timezoneId: n % 3 === 0 ? 'America/New_York' : n % 3 === 1 ? 'Europe/London' : 'America/Chicago',
  };
}

export function batchDelayMs(index = 0) {
  const base = 2000 + (index % 5) * 500;
  const jitter = Math.floor(Math.random() * 1000);
  return base + jitter;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
