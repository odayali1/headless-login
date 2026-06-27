#!/usr/bin/env node
/**
 * CLI login test — usage:
 *   node scripts/cli-login.js email@outlook.com password outlook chromium
 */
import { loginMicrosoft } from '../lib/microsoft-login.js';

const [email, password, target = 'outlook', engine = 'auto'] = process.argv.slice(2);

if (!email || !password) {
  console.error('Usage: node scripts/cli-login.js <email> <password> [outlook|teams] [chromium|obscura|auto]');
  process.exit(1);
}

const result = await loginMicrosoft({
  email,
  password,
  target,
  engine,
  jobId: 'cli',
  onProgress: ({ step, message }) => console.log(`[${step}] ${message}`),
});

console.log('\nResult:', JSON.stringify(result, null, 2));
