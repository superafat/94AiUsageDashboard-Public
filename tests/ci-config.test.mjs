import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workflow = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

test('CI uses current Node 24 based official action majors', () => {
  assert.match(workflow, /actions\/checkout@v5/);
  assert.match(workflow, /actions\/setup-node@v5/);
  assert.match(workflow, /actions\/setup-java@v5/);
  assert.doesNotMatch(workflow, /actions\/(?:checkout|setup-node|setup-java)@v4/);
});

test('CI workflow configures actions/checkout with fetch-depth: 0 for complete history audit', () => {
  assert.match(workflow, /actions\/checkout@v5[\s\S]*?with:\s*[\s\S]*?fetch-depth:\s*0/);
});


test('GitHub Actions workflow is manual-only and never auto-runs on push or pull request', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /(^|\n)\s*push:/m);
  assert.doesNotMatch(workflow, /(^|\n)\s*pull_request:/m);
});
