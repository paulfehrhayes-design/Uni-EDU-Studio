import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vitePackage = path.join(root, 'node_modules', 'vite', 'package.json');

if (!existsSync(vitePackage)) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(
    npm,
    ['ci', '--prefer-offline', '--no-audit', '--no-fund'],
    { cwd: root, stdio: 'inherit', shell: false },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
