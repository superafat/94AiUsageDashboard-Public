import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('README documents the complete self-hosted v1 path', () => {
  for (const phrase of [
    'OpenUsage', 'Firebase', 'Google Authentication', 'Local Agent',
    'Codex', 'Antigravity', 'Claude Code', 'Firestore Security Rules',
    'PWA', '只讀', '隱私', '自行部署',
  ]) assert.match(readme, new RegExp(phrase, 'i'), `missing ${phrase}`);
});

test('README makes production boundaries explicit', () => {
  assert.match(readme, /不會.*上傳.*權杖|不會.*同步.*權杖/);
  assert.match(readme, /自己的 Firebase|your own Firebase/i);
  assert.match(readme, /完整私人開發歷史不公開/);
  assert.match(readme, /乾淨匯出/);
  assert.match(readme, /94AiUsageDashboard-Public/);
});

test('README describes v1.5 as the current private public-ready build rather than work-in-progress', () => {
  assert.match(readme, /v1\.5.*Public-ready/i);
  assert.doesNotMatch(readme, /v1\.5.*正在/);
  assert.match(readme, /App-first/);
});
