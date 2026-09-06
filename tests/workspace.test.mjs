import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const pkg = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url)),
);
const agentPkg = JSON.parse(
  fs.readFileSync(new URL('../apps/agent/package.json', import.meta.url)),
);

test('workspace exposes canonical verification commands', () => {
  assert.equal(fs.existsSync(new URL('../tsconfig.json', import.meta.url)), true);
  assert.deepEqual(pkg.workspaces.sort(), [
    'apps/agent',
    'apps/web',
    'packages/client',
    'packages/core',
    'packages/firebase',
    'packages/openusage',
    'packages/ui',
  ]);

  for (const script of [
    'lint',
    'typecheck',
    'test',
    'build',
    'test:rules',
    'test:acceptance',
    'test:e2e',
  ]) {
    assert.equal(typeof pkg.scripts?.[script], 'string');
  }
});

test('agent CLI loads root .env.local when present', () => {
  assert.match(agentPkg.scripts?.cli ?? '', /--env-file-if-exists=.*\.env\.local/);
});
