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

test('AGENTS.md exists and defines lean-role boundaries and telemetry truth', () => {
  const agentsPath = new URL('../AGENTS.md', import.meta.url);
  assert.ok(fs.existsSync(agentsPath), 'AGENTS.md must exist at root');
  const agents = fs.readFileSync(agentsPath, 'utf8');

  for (const phrase of [
    'read-only',
    'DevControl',
    'allocation',
    'reset credits',
    'credentials',
    'Keychain',
    'invented balances',
    'estimates',
  ]) {
    assert.match(agents, new RegExp(phrase, 'i'), `AGENTS.md must contain ${phrase}`);
  }
});

test('README documents read-only telemetry truth and non-centralization boundaries', () => {
  assert.match(readme, /DevControl/i);
  assert.match(readme, /不啟動.*工具|不控制.*Mac/);
  assert.match(readme, /估算.*費用.*不是.*帳單|不是實際帳單/);
  assert.match(readme, /不猜值|不造假|不會假造/);
});
