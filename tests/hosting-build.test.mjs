import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const firebase = JSON.parse(fs.readFileSync(new URL('../firebase.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('hosting deployment always rebuilds a non-fixture bundle after browser tests', () => {
  assert.ok(firebase.hosting.predeploy?.includes('npm run build:hosting'));
  assert.equal(pkg.scripts['build:hosting'], 'node scripts/build-hosting.mjs');
});
