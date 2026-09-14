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
  assert.match(readme, /憑證.*Mac|Mac.*憑證/);
  assert.match(readme, /安全|隱私/);
  assert.match(readme, /94AiUsageDashboard-Public/);
});

test('README is product-first, avoids private-version noise, and showcases real browser screenshots', () => {
  assert.doesNotMatch(readme, /目前私人|v1\.5.*Public-ready|完整私人開發歷史/i);
  assert.match(readme, /v0\.1\.3/i);
  assert.match(readme, /App-first/i);
  for (const image of [
    'dashboard-desktop.png',
    'dashboard-mobile.png',
    'usage-history-desktop.png',
    'provider-codex-desktop.png',
  ]) {
    assert.match(readme, new RegExp(`docs/images/readme/${image.replace('.', '\\.')}`));
  }
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

  assert.match(agents, /Reset Credit R2/i, 'AGENTS.md must define the bounded R2 reset exception');
  assert.match(agents, /explicit user confirmation/i, 'R2 reset requires explicit user confirmation');
  assert.match(agents, /paired Mac/i, 'R2 reset must execute only through a paired Mac');
  assert.match(agents, /Journal/i, 'R2 reset must preserve the local Journal authority boundary');
  assert.match(agents, /must not automatically reset|automatic reset.*forbidden/i, 'automatic reset must remain forbidden');
});

test('README documents read-only telemetry truth and non-centralization boundaries', () => {
  assert.match(readme, /DevControl/i);
  assert.match(readme, /不啟動.*工具|不控制.*Mac/);
  assert.match(readme, /估算.*費用.*不是.*帳單|不是實際帳單/);
  assert.match(readme, /不猜值|不造假|不會假造/);
});

test('docs/notifications.md documents both iPhone and Android onboarding flows with caveats and troubleshooting', () => {
  const notificationsPath = new URL('../docs/notifications.md', import.meta.url);
  assert.ok(fs.existsSync(notificationsPath), 'docs/notifications.md must exist');
  const notifications = fs.readFileSync(notificationsPath, 'utf8');

  // iPhone onboarding steps & caveats
  assert.match(notifications, /iPhone/i);
  assert.match(notifications, /Safari/i);
  assert.match(notifications, /加入主畫面/);
  assert.match(notifications, /專注模式/);

  // Android onboarding steps & caveats
  assert.match(notifications, /Android/i);
  assert.match(notifications, /Chrome/i);
  assert.match(notifications, /電池最佳化|背景限制/);

  // Cadence & push-service acceptance vs device display
  assert.match(notifications, /約每\s*5\s*分鐘/);
  assert.match(notifications, /推播服務.*(?:接受|受理).*(?:不代表|不等於).*(?:顯示|收到)/);

  // Troubleshooting
  assert.match(notifications, /常見問題|排查|Troubleshooting/i);
  assert.match(notifications, /Mac.*(?:離線|在線|Companion)/);
  assert.match(notifications, /權限.*(?:封鎖|拒絕)/);
});

test('README includes push onboarding subsection linking to docs/notifications.md', () => {
  assert.match(readme, /推播.*(?:通知|設定|教學)/);
  assert.match(readme, /docs\/notifications\.md/);
  assert.doesNotMatch(readme, /Google Play.*已發布|App Store.*已發布/);
});

test('docs enforce R2 transport vs R3 consume gate, device interlock, and development release state', () => {
  const agentsPath = new URL('../AGENTS.md', import.meta.url);
  const agents = fs.readFileSync(agentsPath, 'utf8');
  assert.match(agents, /AI_USAGE_RESET_COMMANDS_ENABLED/);
  assert.match(agents, /AI_USAGE_RESET_REAL_CONSUME_ENABLED/);
  assert.match(agents, /r3_authorization_required/);
  assert.match(agents, /device-wide|cross-account/i);

  const resetDocPath = new URL('../docs/reset-credit-command.md', import.meta.url);
  const resetDoc = fs.readFileSync(resetDocPath, 'utf8');
  assert.match(resetDoc, /r3_authorization_required/);
  assert.match(resetDoc, /AI_USAGE_RESET_REAL_CONSUME_ENABLED=1/);
  assert.match(resetDoc, /裝置級跨帳號未決互鎖/);

  const securityPath = new URL('../SECURITY.md', import.meta.url);
  const security = fs.readFileSync(securityPath, 'utf8');
  assert.match(security, /AI_USAGE_RESET_COMMANDS_ENABLED=1/);
  assert.match(security, /AI_USAGE_RESET_REAL_CONSUME_ENABLED=1/);
  assert.match(security, /r3_authorization_required/);
  assert.match(security, /裝置級全域未決互鎖/);
});
