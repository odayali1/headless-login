/**
 * Truecaller feature — isolated from Outlook login.
 * Never writes Outlook profiles, never uses the main proxy/login queue.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..', '..');

export const TRUECALLER_DIR = path.join(DATA_DIR, 'truecaller');
export const TRUECALLER_DB_PATH = path.join(TRUECALLER_DIR, 'truecaller.db');
export const TRUECALLER_FIREFOX_DIR = path.join(TRUECALLER_DIR, 'firefox');
export const TRUECALLER_SHOT_DIR = path.join(TRUECALLER_DIR, 'screenshots');

export const SIGNIN_URL = 'https://www.truecaller.com/auth/sign-in';
export const MICROSOFT_CALLBACK_PATH = '/auth/microsoft/callback';
export const MICROSOFT_CLIENT_ID = '000000004818BA61';
export const SEARCH_ORIGIN = 'https://www.truecaller.com';

export const DEFAULT_PROXY_URL = String(process.env.TRUECALLER_PROXY_URL || '').trim();

/** Live/MSA cookies we copy into an isolated browser. Outlook mail cookies are excluded. */
export const SSO_COOKIE_NAMES = new Set([
  'ESTSAUTH',
  'ESTSAUTHPERSISTENT',
  'MSPAuth',
  'MSPProf',
  'WLSSC',
  'ANON',
  '__Host-MSAAUTHP',
  '__Host-MSAAUTH',
  'MSPOK',
  'MUID',
  'RPSSecAuth',
  'MSPShared',
  'NAP',
  'PPLState',
  'OParams',
  'SDIDC',
  'JSHP',
  'MSPPre',
  'MSPCID',
  'MSPVis',
]);

export function truecallerFirefoxDir(email) {
  const safe = String(email || '').replace(/[^a-zA-Z0-9@._-]/g, '_');
  return path.join(TRUECALLER_FIREFOX_DIR, safe);
}
