import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OBSCURA_BIN = path.join(ROOT, 'bin', 'obscura.exe');
const DEFAULT_PORT = 9222;
const CDP_URL = `ws://127.0.0.1:${DEFAULT_PORT}`;

let obscuraProcess = null;

export function getCdpUrl() {
  return CDP_URL;
}

export function isObscuraRunning() {
  return obscuraProcess !== null && !obscuraProcess.killed;
}

export async function isObscuraOnline(port = DEFAULT_PORT) {
  return isCdpReachable(port);
}

export async function ensureObscura({ stealth = true, port = DEFAULT_PORT } = {}) {
  const cdpUrl = `ws://127.0.0.1:${port}`;

  if (await isCdpReachable(port)) return cdpUrl;
  if (isObscuraRunning()) {
    await waitForCdp(port, 10_000);
    return cdpUrl;
  }

  const args = ['serve', '--port', String(port), '--quiet'];
  if (stealth) args.push('--stealth');

  obscuraProcess = spawn(OBSCURA_BIN, args, {
    cwd: path.join(ROOT, 'bin'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  obscuraProcess.stdout?.on('data', (d) => process.stdout.write(`[obscura] ${d}`));
  obscuraProcess.stderr?.on('data', (d) => process.stderr.write(`[obscura] ${d}`));
  obscuraProcess.on('exit', () => {
    obscuraProcess = null;
  });

  await waitForCdp(port, 30_000);
  return cdpUrl;
}

export function stopObscura() {
  if (obscuraProcess && !obscuraProcess.killed) {
    obscuraProcess.kill();
    obscuraProcess = null;
  }
}

async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isCdpReachable(port)) return;
    await sleep(500);
  }
  throw new Error(`Obscura CDP did not start on port ${port} within ${timeoutMs}ms`);
}

async function isCdpReachable(port) {
  const http = await import('node:http');
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

process.on('exit', stopObscura);
process.on('SIGINT', () => {
  stopObscura();
  process.exit(0);
});
