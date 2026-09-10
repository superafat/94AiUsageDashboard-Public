import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('root and all workspace packages report exact release version 0.1.4', () => {
  const rootPkgPath = path.resolve('package.json');
  assert.ok(fs.existsSync(rootPkgPath), 'root package.json exists');
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
  assert.equal(rootPkg.version, '0.1.4', 'root package version must be 0.1.4');

  const workspaces = rootPkg.workspaces ?? [];
  assert.ok(workspaces.length > 0, 'workspaces must be defined');

  for (const workspace of workspaces) {
    const wsPkgPath = path.resolve(workspace, 'package.json');
    assert.ok(fs.existsSync(wsPkgPath), `workspace package.json exists for ${workspace}`);
    const wsPkg = JSON.parse(fs.readFileSync(wsPkgPath, 'utf8'));
    assert.equal(
      wsPkg.version,
      '0.1.4',
      `workspace package ${wsPkg.name} (${workspace}) version must be 0.1.4`,
    );
  }
});

test('publication checklist exists and contains required gates and visibility constraints', () => {
  const checklistPath = path.resolve('docs/publication-checklist.md');
  assert.ok(fs.existsSync(checklistPath), 'docs/publication-checklist.md must exist');

  const content = fs.readFileSync(checklistPath, 'utf8');

  const requiredPhrases = [
    'history scan',
    'binary review',
    'license approval',
    'owner approval',
    'clean export',
  ];

  for (const phrase of requiredPhrases) {
    assert.match(
      content,
      new RegExp(phrase, 'i'),
      `checklist must contain required gate: "${phrase}"`,
    );
  }

  assert.match(
    content,
    /private development repository stays private permanently/i,
    'checklist must explicitly keep the private development repository private',
  );
  assert.match(
    content,
    /sanitized clean export in a separate public repository/i,
    'checklist must require a separate sanitized public repository',
  );
});
