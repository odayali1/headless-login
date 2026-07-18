import crypto from 'node:crypto';

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
];

/** Common phone CSS viewports — varied per account (Camoufox has no android/ios OS). */
const PHONE_VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 393, height: 852 },
  { width: 360, height: 800 },
  { width: 412, height: 915 },
  { width: 384, height: 854 },
  { width: 414, height: 896 },
  { width: 375, height: 812 },
  { width: 360, height: 780 },
];

const CHROME_BUILDS = ['145.0.0.0', '146.0.0.0', '147.0.0.0', '148.0.0.0', '149.0.0.0'];

/**
 * Stable per-account fingerprint so each account looks like its own device.
 * @param {string} email
 * @param {{ mimicPhone?: boolean }} [opts]
 */
export function getAccountFingerprint(email, { mimicPhone = false } = {}) {
  const hash = crypto.createHash('sha256').update(email.toLowerCase().trim()).digest();
  const n = hash.readUInt32BE(0);
  const phone = mimicPhone === true;

  let viewport;
  if (phone) {
    const base = PHONE_VIEWPORTS[n % PHONE_VIEWPORTS.length];
    // Slight per-account jitter so many accounts don't share identical CSS sizes.
    const jitterW = n % 9;
    const jitterH = (n >>> 8) % 13;
    viewport = { width: base.width + jitterW, height: base.height + jitterH };
  } else {
    viewport = VIEWPORTS[n % VIEWPORTS.length];
  }

  const chromeVer = CHROME_BUILDS[n % CHROME_BUILDS.length];

  return {
    seed: hash.toString('hex').slice(0, 16),
    viewport,
    mimicPhone: phone,
    // Touch phones typically report 5; vary 3–5 so accounts aren't identical.
    maxTouchPoints: phone ? 3 + (n % 3) : 0,
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`,
    locale: n % 2 === 0 ? 'en-US' : 'en-GB',
    timezoneId: n % 3 === 0 ? 'America/New_York' : n % 3 === 1 ? 'Europe/London' : 'America/Chicago',
  };
}

/**
 * Resolve fingerprint for a login, regenerating when phone/desktop mode changes.
 * @param {string} email
 * @param {object|null|undefined} savedFingerprint
 * @param {boolean|undefined} mimicPhone - true/false to set mode; undefined keeps saved mode
 */
export function resolveAccountFingerprint(email, savedFingerprint, mimicPhone) {
  const savedPhone = !!(savedFingerprint?.mimicPhone);
  const wantPhone = typeof mimicPhone === 'boolean' ? mimicPhone : savedPhone;
  if (
    savedFingerprint?.viewport?.width &&
    savedFingerprint?.viewport?.height &&
    !!savedFingerprint.mimicPhone === wantPhone
  ) {
    return {
      ...savedFingerprint,
      mimicPhone: wantPhone,
      maxTouchPoints:
        savedFingerprint.maxTouchPoints ??
        (wantPhone ? 5 : 0),
    };
  }
  return getAccountFingerprint(email, { mimicPhone: wantPhone });
}

/**
 * Gap between batch logins on the same mobile IP.
 * Microsoft GetCredentialType starts returning false failures after ~10 rapid lookups (MS Q&A).
 * Override with LOGIN_BATCH_DELAY_MS (base) if needed.
 */
export function batchDelayMs(index = 0) {
  const envBase = Number(process.env.LOGIN_BATCH_DELAY_MS || 0);
  const base = envBase > 0 ? envBase : 9000 + (index % 5) * 2000;
  const jitter = Math.floor(Math.random() * 5000);
  return base + jitter;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
