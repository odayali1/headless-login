/**
 * Isolated Camoufox for Truecaller only.
 * Uses its own firefox dir + its own proxy-chain relay.
 * Never calls launchCamoufoxSession / connectBrowser (those bind Outlook profiles).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { firefox } from 'playwright-core';
import { launchOptions as buildCamoufoxLaunchOptions } from 'camoufox-js';
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain';
import { getAccountFingerprint } from '../anti-detect.js';
import { isForeignExecutable } from '../camoufox-browser.js';
import { parseProxyUrl } from '../settings.js';
import { truecallerFirefoxDir } from './config.js';

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

async function loadLaunchOptions(email, fingerprint) {
  const dir = truecallerFirefoxDir(email);
  const optsFile = path.join(dir, 'launch-options.json');
  await fs.mkdir(dir, { recursive: true });

  const config = {
    headless: true,
    humanize: true,
    os: 'windows',
    window: [fingerprint.viewport.width, fingerprint.viewport.height],
    block_webrtc: true,
    enable_cache: false,
    locale: fingerprint.locale || 'en-US',
  };

  try {
    const cached = stripProxy(JSON.parse(await fs.readFile(optsFile, 'utf8')));
    const exe = cached?.executablePath;
    if (exe && !isForeignExecutable(exe)) {
      try {
        await fs.access(exe);
        const fresh = stripProxy(await buildCamoufoxLaunchOptions(config));
        if (fresh.executablePath) cached.executablePath = fresh.executablePath;
        return cached;
      } catch {
        // rebuild
      }
    }
  } catch {
    // create
  }

  const fromOptions = stripProxy(await buildCamoufoxLaunchOptions(config));
  await fs.writeFile(optsFile, JSON.stringify(fromOptions, null, 2));
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

/**
 * @param {{ email: string, cookies?: object[], fingerprint?: object, proxyUrl: string }} opts
 */
export async function launchTruecallerBrowser({ email, cookies = [], fingerprint, proxyUrl }) {
  if (!proxyUrl) {
    throw new Error('Truecaller proxy is not set. Set it on the Truecaller tab — it never uses the Outlook proxy.');
  }
  const parsed = parseProxyUrl(proxyUrl);
  const fp = fingerprint || getAccountFingerprint(email);
  const launchOpts = containerFixes(await loadLaunchOptions(email, fp));
  stripProxy(launchOpts);

  launchOpts.firefoxUserPrefs = {
    ...(launchOpts.firefoxUserPrefs || {}),
    'media.peerconnection.enabled': false,
    'network.proxy.socks_remote_dns': true,
    'network.http.http3.enable': false,
  };

  const relayUrl = await anonymizeProxy(buildUpstream(parsed));
  launchOpts.proxy = { server: relayUrl };

  const browser = await firefox.launch(launchOpts);
  const context = await browser.newContext();
  const dropped = [];
  if (cookies.length) {
    const now = Date.now() / 1000;
    const usable = [];
    for (const c of cookies) {
      if (typeof c.expires === 'number' && c.expires > 0 && c.expires < now) {
        dropped.push(`${c.name}:expired`);
        continue;
      }
      const cookie = { ...c };
      if (cookie.name.startsWith('__Host-')) {
        cookie.domain = String(cookie.domain || '').replace(/^\./, '');
        cookie.path = '/';
        cookie.secure = true;
      }
      if (cookie.sameSite === 'None') cookie.secure = true;
      usable.push(cookie);
    }
    try {
      await context.addCookies(usable);
    } catch {
      for (const c of usable) {
        try {
          await context.addCookies([c]);
        } catch {
          dropped.push(c.name);
        }
      }
    }
  }
  const page = await context.newPage();
  const accepted = await context.cookies().catch(() => []);

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
