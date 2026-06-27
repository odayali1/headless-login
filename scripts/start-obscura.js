import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(__dirname, '..', 'bin', 'obscura.exe');

const args = ['serve', '--port', '9222', '--stealth', '--quiet'];
const proc = spawn(bin, args, {
  cwd: path.join(__dirname, '..', 'bin'),
  stdio: 'inherit',
});

proc.on('exit', (code) => process.exit(code ?? 0));
