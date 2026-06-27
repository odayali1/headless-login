import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, DB_PATH } from './db.js';
import { PROFILES_DIR, consolidateLegacyProfiles } from './profile.js';
import { consolidateDbCredentials } from './db.js';
import { repairAllLaunchOptions } from './camoufox-browser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LEGACY_PROFILES = path.join(ROOT, 'profiles');

export async function runStartupMigrations() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PROFILES_DIR, { recursive: true });

  if (LEGACY_PROFILES !== PROFILES_DIR && fs.existsSync(LEGACY_PROFILES)) {
    for (const file of fs.readdirSync(LEGACY_PROFILES)) {
      const src = path.join(LEGACY_PROFILES, file);
      const dest = path.join(PROFILES_DIR, file);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
      }
    }
    console.log(`[migrate] Copied legacy profiles from ${LEGACY_PROFILES} → ${PROFILES_DIR}`);
  }

  console.log(`[db] SQLite: ${DB_PATH}`);
  console.log(`[db] Profiles: ${PROFILES_DIR}`);
  consolidateDbCredentials();
  await consolidateLegacyProfiles();
  await repairAllLaunchOptions();
}
