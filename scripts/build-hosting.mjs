import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Browser tests use fixture mode and replace dist. Never deploy that artifact.
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build', '-w', 'apps/web'], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  env: { ...process.env, VITE_E2E: '0' },
  stdio: 'inherit',
});
if (result.error) {
  console.error('Unable to start the hosting build. Check the Node.js/npm installation.');
}
process.exitCode = result.status ?? 1;
