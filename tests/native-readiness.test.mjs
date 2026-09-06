import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const uiPackage = JSON.parse(fs.readFileSync('packages/ui/package.json', 'utf8'));
const webPackage = JSON.parse(fs.readFileSync('apps/web/package.json', 'utf8'));
const clientSource = fs.readFileSync('packages/client/src/contracts.ts', 'utf8');
const readme = fs.readFileSync('README.md', 'utf8');

test('shared product layer is ready for a future native shell', () => {
  assert.equal(uiPackage.dependencies?.firebase, undefined);
  assert.equal(uiPackage.dependencies?.vite, undefined);
  assert.equal(webPackage.dependencies?.['@94ai/client'], '*');
  assert.match(clientSource, /official-app/);
  assert.match(clientSource, /NavigationClient/);
  assert.match(clientSource, /BackendProfile/);
});

test('README makes App-first distribution explicit', () => {
  assert.match(readme, /Google Play/);
  assert.match(readme, /App Store/);
  assert.match(readme, /Capacitor/);
  assert.match(readme, /BackendProfile/);
  assert.match(readme, /Self-hosted.*進階|進階.*Self-hosted/i);
});
