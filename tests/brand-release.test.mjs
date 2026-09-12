import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('apps/web/index.html title uses exact canonical Chinese name with lowercase i', () => {
  const indexPath = path.resolve('apps/web/index.html');
  assert.ok(fs.existsSync(indexPath), 'apps/web/index.html exists');
  const html = fs.readFileSync(indexPath, 'utf8');
  assert.match(
    html,
    new RegExp('<title>蜂神榜 Ai 額度儀表板</title>'),
    'index.html title must be exactly <title>蜂神榜 Ai 額度儀表板</title>',
  );
  assert.doesNotMatch(
    html,
    new RegExp('<title>.*AI.*</title>'),
    'index.html must not use uppercase AI in product title',
  );
});

test('apps/web/public/manifest.webmanifest brand strings use canonical name with lowercase i', () => {
  const manifestPath = path.resolve('apps/web/public/manifest.webmanifest');
  assert.ok(fs.existsSync(manifestPath), 'manifest exists');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(
    manifest.name,
    '蜂神榜 Ai 額度儀表板',
    'manifest name must be canonical Chinese name',
  );
  assert.ok(
    manifest.short_name.includes('蜂神榜'),
    'manifest short_name must reflect brand',
  );
  assert.doesNotMatch(
    manifest.name,
    /蜂神榜 AI/,
    'manifest name must not use uppercase AI',
  );
});

test('backend, package, and repository identities are preserved without renaming', () => {
  const rootPkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  assert.equal(rootPkg.name, '94ai-usage-dashboard');

  const expectedPackages = {
    'apps/web': '@94ai/web',
    'apps/agent': '@94ai/agent',
    'packages/ui': '@94ai/ui',
    'packages/core': '@94ai/core',
    'packages/firebase': '@94ai/firebase',
    'packages/openusage': '@94ai/openusage',
    'packages/client': '@94ai/client',
  };

  for (const [wsDir, expectedName] of Object.entries(expectedPackages)) {
    const wsPkg = JSON.parse(
      fs.readFileSync(path.resolve(wsDir, 'package.json'), 'utf8'),
    );
    assert.equal(wsPkg.name, expectedName, `${wsDir} package name must be preserved`);
  }
});

test('version sources cannot silently drift from root/workspace package version 0.1.4', async () => {
  const rootPkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  const expectedVersion = '0.1.4';
  assert.equal(rootPkg.version, expectedVersion, 'root package version must be 0.1.4');

  for (const ws of rootPkg.workspaces ?? []) {
    const wsPkg = JSON.parse(
      fs.readFileSync(path.resolve(ws, 'package.json'), 'utf8'),
    );
    assert.equal(
      wsPkg.version,
      expectedVersion,
      `workspace ${ws} version must be ${expectedVersion}`,
    );
  }

  const brandFile = path.resolve('packages/core/src/brand.ts');
  assert.ok(fs.existsSync(brandFile), 'packages/core/src/brand.ts must exist');
  const brandContent = fs.readFileSync(brandFile, 'utf8');
  assert.match(
    brandContent,
    /export const APP_VERSION = ['"`]0\.1\.4['"`]/,
    'packages/core/src/brand.ts APP_VERSION must match 0.1.4',
  );
});
