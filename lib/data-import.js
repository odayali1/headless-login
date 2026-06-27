import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const ALLOWED = [
  /^app\.db(-wal|-shm)?$/,
  /^\.credentials-key$/,
  /^profiles\/.+/,
];

function isAllowed(entryName) {
  const n = entryName.replace(/\\/g, '/').replace(/^\/+/, '');
  return ALLOWED.some((re) => re.test(n));
}

export function importDataBackup(buffer, dataDir) {
  const zip = new AdmZip(Buffer.from(buffer));
  const entries = zip.getEntries();
  let filesWritten = 0;

  fs.mkdirSync(dataDir, { recursive: true });

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/\\/g, '/').replace(/^\/+/, '');
    if (name.includes('..')) throw new Error('Invalid zip path');
    if (!isAllowed(name)) continue;

    const dest = path.join(dataDir, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
    filesWritten += 1;
  }

  if (filesWritten === 0) {
    throw new Error('No valid files in zip (expected app.db and profiles/)');
  }

  const profilesDir = path.join(dataDir, 'profiles');
  const profileCount = fs.existsSync(profilesDir)
    ? fs.readdirSync(profilesDir).filter((f) => f.endsWith('.json')).length
    : 0;

  let accountCount = 0;
  const dbPath = path.join(dataDir, 'app.db');
  if (fs.existsSync(dbPath)) {
    const db = new Database(dbPath, { readonly: true });
    accountCount = db.prepare('SELECT COUNT(*) AS c FROM accounts').get().c;
    db.close();
  }

  return { filesWritten, profileCount, accountCount };
}
