import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('plain-language getting started covers current and future App modes', () => {
  const text=fs.readFileSync('docs/getting-started.md','utf8');
  for(const phrase of ['這是什麼','需要準備','Mac','自己的額度','不會上傳','Self-hosted','未來 App','Android','iPhone']) assert.match(text,new RegExp(phrase,'i'));
});
