import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('managed engine setup is documented without secret or silent-install shortcuts', () => {
  const readme = fs.readFileSync('README.md','utf8');
  for (const phrase of ['doctor --json','OpenUsage CLI','HTTP fallback','可重跑','不會自動安裝 OpenUsage']) assert.match(readme,new RegExp(phrase,'i'));
  assert.doesNotMatch(fs.readFileSync('.env.example','utf8'),/(access|refresh)[_-]?token\s*=/i);
});
