import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Playwright E2E uses a project-isolated configurable preview port', async () => {
  const source = await readFile('playwright.config.ts', 'utf8');
  assert.match(source, /E2E_PORT/u);
  assert.doesNotMatch(source, /127\.0\.0\.1:4173|--port\s+4173/u);
});
