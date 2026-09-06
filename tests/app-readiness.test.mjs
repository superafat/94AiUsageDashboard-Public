import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(file) : /\.(?:ts|tsx)$/.test(file) && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(file) ? [file] : [];
  });
}

test('shared UI exists and contains no browser or Firebase coupling', () => {
  assert.equal(fs.existsSync('packages/ui/src/AppRoot.tsx'), true);
  for (const file of filesUnder('packages/ui/src')) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /from ['"]firebase\//, file);
    assert.doesNotMatch(source, /from ['"]@94ai\/ui['"]/, file);
    assert.doesNotMatch(source, /\bauth\/[a-z-]+/, file);
    assert.doesNotMatch(source, /\b(?:window|document|navigator|localStorage|sessionStorage)\b/, file);
  }
});
