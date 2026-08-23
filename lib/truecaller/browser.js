/**
 * Isolated Camoufox for Truecaller only.
 *
 * Uses the same Camoufox engine as Outlook (camoufox-js + sticky launch-options + geoip),
 * but NEVER calls launchCamoufoxSession / connectBrowser / saveProfile.
 * Outlook firefox dir is read-only (copy launch-options into data/truecaller/).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { firefox } from 'playwright-core';
import { launchOptions as buildCamoufoxLaunchOptions } from 'camoufox-js';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { getAccountFingerprint } from '../anti-detect.js';
import { firefoxProfileDir, isForeignExecutable } from '../camoufox-browser.js';
import { PROFILES_DIR, CANONICAL_TARGET } from '../profile.js';
import { parseProxyUrl } from '../settings.js';
import { truecallerFirefoxDir } from './config.js';
import { toPlaywrightCookies, isLiveTicketCookie } from './cookies.js';

function stripProxy(opts) {
  if (!opts) return opts;
  delete opts.proxy;
  if (opts.firefoxUserPrefs) {
    for (const key of Object.keys(opts.firefoxUserPrefs)) {
      if (key.startsWith('network.proxy.')) delete opts.firefoxUserPrefs[key];
    }
  }
  return opts;
}

function containerFixes(opts) {
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

function readCamouConfigEnv(env = {}) {
  const parts = [];
  for (let i = 1; i < 32; i++) {
    const chunk = env[`CAMOU_CONFIG_${i}`];
    if (chunk == null) break;
    parts.push(String(chunk));
  }
  if (!parts.length && env.CAMOU_CONFIG) {
    try {
      return JSON.parse(String(env.CAMOU_CONFIG));
    } catch {
      return {};
    }
  }
  if (!parts.length) return {};
  try {
    return JSON.parse(parts.join(''));
  } catch {
    return {};
  }
}

function writeCamouConfigEnv(env, config) {
  for (const key of Object.keys(env)) {
    if (key === 'CAMOU_CONFIG' || key.startsWith('CAMOU_CONFIG_')) delete env[key];
  }
  const raw = JSON.stringify(config);
  const chunkSize = process.platform === 'win32' ? 2047 : 32767;
  let n = 0;
  for (let i = 0; i < raw.length; i += chunkSize) {
    n += 1;
    env[`CAMOU_CONFIG_${n}`] = raw.slice(i, i + chunkSize);
  }
  return env;
}

async function applyTruecallerGeoip(launchOpts, log) {
  if (!launchOpts?.proxy?.server) {
    launchOpts.firefoxUserPrefs = {
      ...(launchOpts.firefoxUserPrefs || {}),
      'media.peerconnection.enabled': false,
    };
    return false;
  }
  try {
    const { probeExitIp } = await import('../proxy-exit-ip.js');
    const exitIp = await probeExitIp({ playwrightProxy: launchOpts.proxy });
    if (!exitIp) throw new Error('no exit IP through Truecaller proxy');
    const { getGeolocation } = await import('camoufox-js/dist/locale.js');
    const { validIPv4, validIPv6 } = await import('camoufox-js/dist/ip.js');
    const geo = await getGeolocation(exitIp);
    const geoConfig = geo.asConfig();
    launchOpts.env = { ...(launchOpts.env || {}) };
    const camou = readCamouConfigEnv(launchOpts.env);
    Object.assign(camou, geoConfig);
    if (validIPv4(exitIp)) {
      camou['webrtc:ipv4'] = exitIp;
      delete camou['webrtc:ipv6'];
    } else if (validIPv6(exitIp)) {
      camou['webrtc:ipv6'] = exitIp;
      delete camou['webrtc:ipv4'];
    }
    writeCamouConfigEnv(launchOpts.env, camou);
    launchOpts.firefoxUserPrefs = { ...(launchOpts.firefoxUserPrefs || {}) };
    delete launchOpts.firefoxUserPrefs['media.peerconnection.enabled'];
    if (validIPv4(exitIp)) launchOpts.firefoxUserPrefs['network.dns.disableIPv6'] = true;
    log('browser', `Camoufox geoip matched exit ${exitIp} tz=${geoConfig.timezone || '?'}`);
    return true;
  } catch (err) {
    launchOpts.firefoxUserPrefs = {
      ...(launchOpts.firefoxUserPrefs || {}),
      'media.peerconnection.enabled': false,
    };
    log('browser', `geoip skipped (${err.message}) — WebRTC blocked`);
    return false;
  }
}

async function resolveOutlookLaunchOptionsFile(email) {
  const candidates = [
    path.join(firefoxProfileDir(email, CANONICAL_TARGET), 'launch-options.json'),
    path.join(firefoxProfileDir(String(email).toLowerCase(), CANONICAL_TARGET), 'launch-options.json'),
  ];
  const seen = new Set();
  for (const f of candidates) {
    if (seen.has(f)) continue;
    seen.add(f);
    try {
      await fs.access(f);
      return f;
    } catch {
      // next
    }
  }
  const root = path.join(PROFILES_DIR, 'firefox');
  let entries = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    return null;
  }
  const want = String(email)
    .replace(/[^a-zA-Z0-9@._-]/g, '_')
    .toLowerCase();
  const hit = entries.find((d) => d.toLowerCase() === `${want}-outlook`);
  if (!hit) return null;
  const f = path.join(root, hit, 'launch-options.json');
  try {
    await fs.access(f);
    return f;
  } catch {
    return null;
  }
}

async function loadLaunchOptions(email, fingerprint, log) {
  const dir = truecallerFirefoxDir(email);
  const optsFile = path.join(dir, 'launch-options.json');
  await fs.mkdir(dir, { recursive: true });

  const outlookOpts = await resolveOutlookLaunchOptionsFile(email);
  if (outlookOpts) {
    try {
      const cached = stripProxy(JSON.parse(await fs.readFile(outlookOpts, 'utf8')));
      const exe = cached?.executablePath;
      if (exe && isForeignExecutable(exe)) delete cached.executablePath;
      if (cached?.executablePath) {
        try {
          await fs.access(cached.executablePath);
        } catch {
          delete cached.executablePath;
        }
      }
      const fresh = stripProxy(
        await buildCamoufoxLaunchOptions({
          headless: true,
          humanize: true,
          os: 'windows',
        })
      );
      if (fresh.executablePath) cached.executablePath = fresh.executablePath;
      await fs.writeFile(optsFile, JSON.stringify(cached, null, 2));
      log('browser', 'Reusing Outlook Camoufox device (launch-options copied read-only)');
      return cached;
    } catch (err) {
      log('browser', `Outlook launch-options unusable (${err.message}) — building Truecaller device`);
    }
  }

  try {
    const cached = stripProxy(JSON.parse(await fs.readFile(optsFile, 'utf8')));
    const exe = cached?.executablePath;
    if (exe && !isForeignExecutable(exe)) {
      try {
        await fs.access(exe);
        const fresh = stripProxy(await buildCamoufoxLaunchOptions({ headless: true, humanize: true, os: 'windows' }));
        if (fresh.executablePath) cached.executablePath = fresh.executablePath;
        return cached;
      } catch {
        // rebuild
      }
    }
  } catch {
    // create
  }

  const fp = fingerprint?.viewport?.width ? fingerprint : getAccountFingerprint(email);
  const config = {
    headless: true,
    humanize: true,
    os: 'windows',
    window: [fp.viewport.width, fp.viewport.height],
    block_webrtc: false,
    enable_cache: true,
  };
  const fromOptions = stripProxy(await buildCamoufoxLaunchOptions(config));
  await fs.writeFile(optsFile, JSON.stringify(fromOptions, null, 2));
  log('browser', 'Built new Truecaller Camoufox device (no Outlook launch-options on disk)');
  return fromOptions;
}

function buildUpstream(parsed) {
  const user = encodeURIComponent(parsed.username);
  const pass = encodeURIComponent(parsed.password);
  if (parsed.protocol === 'http' || parsed.protocol === 'https') {
    return `http://${user}:${pass}@${parsed.host}:${parsed.port}`;
  }
  return `socks5h://${user}:${pass}@${parsed.host}:${parsed.port}`;
}

async function addCookieWithFallback(context, cookie, dropped) {
  try {
    await context.addCookies([cookie]);
    return true;
  } catch (e1) {
    const host = String(cookie.domain || '').replace(/^\./, '') || 'login.live.com';
    const retry = {
      name: cookie.name,
      value: cookie.value,
      url: cookie.name.startsWith('__Host-') ? `https://${host}/` : `https://${host}/`,
      path: cookie.name.startsWith('__Host-') ? '/' : cookie.path || '/',
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: true,
      sameSite: cookie.sameSite === 'None' ? 'None' : cookie.sameSite,
    };
    try {
      await context.addCookies([retry]);
      return true;
    } catch (e2) {
      dropped.push(`${cookie.name}:${String(e2.message || e1.message).slice(0, 80)}`);
      return false;
    }
  }
}

async function injectSsoCookies(browser, cookies, log) {
  const outlook = toPlaywrightCookies(cookies, { hostPrefix: 'keep' });
  const dropped = [...outlook.dropped];
  if (!outlook.cookies.length) {
    const context = await browser.newContext();
    return { context, dropped, accepted: [] };
  }

  const attempts = [
    { label: 'Outlook cookie shape', list: outlook.cookies },
    { label: '__Host- url shape', list: toPlaywrightCookies(cookies, { hostPrefix: 'url' }).cookies },
  ];

  for (const attempt of attempts) {
    try {
      const context = await browser.newContext({
        storageState: { cookies: attempt.list, origins: [] },
      });
      const accepted = await context.cookies().catch(() => []);
      if (accepted.some(isLiveTicketCookie) || !attempt.list.some(isLiveTicketCookie)) {
        log('sso', `storageState accepted (${attempt.label})`);
        return { context, dropped, accepted };
      }
      await context.close().catch(() => {});
      log('sso', `storageState loaded without Microsoft tickets (${attempt.label})`);
    } catch (err) {
      log(
        'sso',
        `storageState rejected ${attempt.label} (${String(err.message || err).slice(0, 160)})`
      );
    }
  }

  log('sso', 'Adding Microsoft cookies one by one');
  const context = await browser.newContext();
  const seen = new Set();
  for (const list of attempts.map((a) => a.list)) {
    for (const c of list) {
      const key = `${c.name}|${c.domain || c.url || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await addCookieWithFallback(context, c, dropped);
    }
  }
  const accepted = await context.cookies().catch(() => []);
  return { context, dropped, accepted };
}

/**
 * @param {{ email: string, cookies?: object[], fingerprint?: object, proxyUrl: string, log?: Function }} opts
 */
export async function launchTruecallerBrowser({ email, cookies = [], fingerprint, proxyUrl, log = () => {} }) {
  if (!proxyUrl) {
    throw new Error('Truecaller proxy is not set. Set it on the Truecaller tab — it never uses the Outlook proxy.');
  }
  const parsed = parseProxyUrl(proxyUrl);
  const fp = fingerprint?.viewport?.width ? fingerprint : getAccountFingerprint(email);
  log('browser', `Preparing Camoufox (${parsed.protocol}://${parsed.host}:${parsed.port})…`);
  const launchOpts = containerFixes(await loadLaunchOptions(email, fp, log));
  stripProxy(launchOpts);

  launchOpts.firefoxUserPrefs = {
    ...(launchOpts.firefoxUserPrefs || {}),
    'network.proxy.socks_remote_dns': true,
    'network.proxy.socks5_remote_dns': true,
    'network.http.http3.enable': false,
    'network.http.http3.enable_0rtt': false,
  };

  log('browser', 'Starting isolated proxy relay (not the Outlook login relay)…');
  const relayUrl = await anonymizeProxy(buildUpstream(parsed));
  launchOpts.proxy = { server: relayUrl };
  await applyTruecallerGeoip(launchOpts, log);

  log('browser', 'Launching Firefox…');
  const browser = await firefox.launch(launchOpts);
  const injected = await injectSsoCookies(browser, cookies, log);
  const { context, dropped, accepted } = injected;
  const tickets = accepted.filter(isLiveTicketCookie);
  log(
    'sso',
    `Browser tickets: ${tickets.map((c) => c.name).join(', ') || 'none'} (${accepted.length} cookies in jar)`
  );
  const wantedTickets = cookies.filter(isLiveTicketCookie);
  if (wantedTickets.length && !tickets.length) {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await closeAnonymizedProxy(relayUrl, true).catch(() => {});
    throw new Error(
      `Firefox did not accept Microsoft tickets (${wantedTickets.map((c) => c.name).join(', ')}). Dropped: ${(dropped || []).slice(0, 8).join(', ') || 'none'}. Outlook profile was not written.`
    );
  }
  const page = await context.newPage();

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await closeAnonymizedProxy(relayUrl, true).catch(() => {});
  };

  return {
    browser,
    context,
    page,
    fingerprint: fp,
    proxyLabel: `${parsed.protocol}://${parsed.host}:${parsed.port}`,
    cookiesAccepted: accepted.length,
    cookiesDropped: dropped,
    close,
  };
}
