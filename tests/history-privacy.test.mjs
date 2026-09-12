import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('history fixture and persistence boundary contain aggregate fields only', () => {
  const fixture = fs.readFileSync('apps/web/src/e2e-fixtures.ts', 'utf8');
  const historyIndex = fixture.indexOf('function histories(');
  assert.notEqual(historyIndex, -1, 'function histories( must exist in e2e-fixtures.ts');
  const historySection = fixture.slice(historyIndex);
  assert.match(historySection, /schemaVersion/);
  assert.match(historySection, /providerId/);
  assert.match(historySection, /periods/);
  assert.match(historySection, /daily/);
  assert.match(historySection, /tokens/);
  assert.doesNotMatch(historySection, /prompt|response|access[_-]?token|refresh[_-]?token|\/Users\//i);
  const rules = fs.readFileSync('firestore.rules', 'utf8');
  assert.match(rules, /validDailyUsage/);
  assert.match(rules, /hasOnly\(\['date', 'tokens', 'estimatedCostUsd', 'finalized'\]\)/);
});
