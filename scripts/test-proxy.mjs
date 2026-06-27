import '../lib/db.js';
import { getLocalProxyForBrowser } from '../lib/proxy-local.js';
import { firefox } from 'playwright-core';
import { launchOptions as buildCamoufoxLaunchOptions } from 'camoufox-js';
import { applyProxyToLaunchOptions } from '../lib/settings.js';

const local = await getLocalProxyForBrowser();
console.log('local relay:', local);

const opts = await buildCamoufoxLaunchOptions({ headless: true, os: 'windows' });
await applyProxyToLaunchOptions(opts);
console.log('proxy server:', opts.proxy?.server);

const browser = await firefox.launch(opts);
const page = await browser.newPage();
try {
  await page.goto('https://login.live.com/', { timeout: 60000, waitUntil: 'domcontentloaded' });
  console.log('login.live.com title:', await page.title());
} catch (e) {
  console.error('goto failed:', e.message);
}
await browser.close();
process.exit(0);
