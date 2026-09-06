import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('AI_INSTALL.md exists and establishes deterministic AI install contract', () => {
  const content = fs.readFileSync('AI_INSTALL.md', 'utf8');

  // Prerequisites & Architecture
  for (const phrase of [
    'macOS', 'Node.js 22', 'Google', 'OpenUsage', 'Firebase',
    'Mac + OpenUsage',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `missing prerequisite/arch: ${phrase}`);
  }
  // Must state phone cannot be standalone quota collector
  assert.match(content, /手機.*不能獨立.*額度|不支援.*phone-only|獨立.*手機|Mac \+ OpenUsage/i);

  // Exact install commands
  for (const cmd of [
    'npm ci',
    'npm run usage -- doctor',
    'npm run usage -- doctor --json',
    'npm run usage -- setup',
    'npm run usage -- sync',
    'npm run usage -- install',
    'npm run usage -- uninstall',
  ]) {
    assert.ok(content.includes(cmd), `missing exact command: ${cmd}`);
  }

  // Firebase setup & Web deploy
  for (const phrase of [
    '.env.local',
    'firebase deploy --only firestore',
    'firebase deploy --only hosting',
    'Google Authentication',
    'Firestore Security Rules',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `missing Firebase/deploy: ${phrase}`);
  }

  // Doctor safe diagnostic surface & verification
  assert.match(content, /doctor --json/i);
  assert.match(content, /首.*同步|first sync/i);
  assert.match(content, /背景同步|LaunchAgent/i);
  assert.match(content, /PWA|預覽|preview/i);

  // Uninstall and Rollback
  assert.match(content, /卸載|uninstall/i);
  assert.match(content, /回滾|rollback/i);
});

test('AI safety instructions and forbidden actions are explicitly mandated', () => {
  const content = fs.readFileSync('AI_INSTALL.md', 'utf8');

  // Forbidden secrets
  for (const forbidden of [
    '.env.local',
    'Keychain',
    'Provider',
    'service-account',
    'cookie',
  ]) {
    assert.match(content, new RegExp(forbidden, 'i'), `missing forbidden item: ${forbidden}`);
  }

  // Clarifications on API key vs service account
  assert.match(content, /公開.*client|public.*client/i);
  assert.match(content, /不需要.*service-account|never.*service-account|不使用.*service-account/i);

  // Forbidden operational actions
  assert.match(content, /計費|billing/i);
  assert.match(content, /公開.*repo|repo.*visibility/i);
  assert.match(content, /授權條款|license/i);
  assert.match(content, /Reset Credit/i);
  assert.match(content, /Provider.*登入狀態|mutate.*login/i);
});

test('Deterministic state machine and recovery paths are fully documented', () => {
  const content = fs.readFileSync('AI_INSTALL.md', 'utf8');

  // Recovery paths
  for (const condition of [
    'engine_missing',
    'auth_missing',
    'Firebase 專案|Firebase project',
    'Rules deploy|規則部署',
    '歷史|history',
    '背景|background',
  ]) {
    assert.match(content, new RegExp(condition, 'i'), `missing recovery path for: ${condition}`);
  }

  // Safe retry & preserve invariants
  assert.match(content, /可安全重試|safe to retry/i);
  assert.match(content, /不可刪除|不得刪除|保留/i);
});

test('README and Getting Started link to AI_INSTALL.md as canonical AI-assisted path', () => {
  const readme = fs.readFileSync('README.md', 'utf8');
  assert.match(readme, /AI_INSTALL\.md/);

  const gettingStarted = fs.readFileSync('docs/getting-started.md', 'utf8');
  assert.match(gettingStarted, /AI_INSTALL\.md/);
});

test('All CLI subcommands referenced in AI_INSTALL.md are implemented in cli.ts', () => {
  const content = fs.readFileSync('AI_INSTALL.md', 'utf8');
  const cliSource = fs.readFileSync('apps/agent/src/cli.ts', 'utf8');

  // Find all `npm run usage -- <subcommand>` in AI_INSTALL.md
  const matches = [...content.matchAll(/npm run usage -- ([a-z0-9-]+)/g)].map(m => m[1]);
  assert.ok(matches.length > 0, 'No npm run usage commands found');
  const uniqueSubcommands = [...new Set(matches)];

  // Extract supported commands from cli.ts usage or branch checks
  const usageMatch = cliSource.match(/usage: 94ai-usage <([^>]+)>/);
  assert.ok(usageMatch, 'Could not find usage string in cli.ts');
  const supportedCommands = new Set(usageMatch[1].split('|').map(s => s.trim()));

  for (const subcmd of uniqueSubcommands) {
    assert.ok(
      supportedCommands.has(subcmd),
      `Subcommand "${subcmd}" referenced in AI_INSTALL.md is not implemented in cli.ts (supported: ${[...supportedCommands].join(', ')})`
    );
  }
});

test('.env.local creation and modification guardrails are strictly enforced', () => {
  const content = fs.readFileSync('AI_INSTALL.md', 'utf8');

  // cp .env.example .env.local only if .env.local does not exist
  assert.match(content, /僅在.*\.env\.local.*不存在時.*cp \.env\.example|\.env\.local.*不存在時.*才.*cp/i);
  assert.match(content, /若.*\.env\.local.*已存在.*嚴禁.*(覆蓋|replace|dump|整檔)/i);

  // Safe edit mechanism for specific named keys without printing old values
  assert.match(content, /安全編輯機制|safe edit/i);
  assert.match(content, /不輸出.*舊值|without printing old values|不列印舊值/i);

  // If tool cannot do key-scoped edit without reading unrelated content, stop and ask user
  assert.match(content, /無法.*(範圍|key-scoped).*編輯.*(停止|請使用者手動)|stop and ask.*manually/i);

  // Never recommend cat .env.local as a command
  assert.doesNotMatch(content, /```(?:bash|sh)?\r?\ncat \.env\.local/m);
  assert.doesNotMatch(content, /^\s*cat \.env\.local/m);
  assert.match(content, /嚴禁.*cat \.env\.local|never.*cat \.env\.local/i);
});

test('Wrong Firebase project recovery covers entire config set and safe workflow', () => {
  const content = fs.readFileSync('AI_INSTALL.md', 'utf8');

  // Must replace/check entire Firebase Web public config set
  assert.match(content, /projectId.*apiKey.*authDomain.*appId/i);
  assert.match(content, /完整.*Firebase Web.*公開設定|完整公開設定集/i);

  // firebase use correct project
  assert.match(content, /firebase use/i);

  // redeploy Firestore, rerun setup and doctor, do not delete Firestore
  assert.match(content, /firebase deploy --only firestore/i);
  assert.match(content, /npm run usage -- setup/i);
  assert.match(content, /npm run usage -- doctor/i);
  assert.match(content, /不可刪除.*Firestore|不得刪除.*Firestore/i);
});

test('Rollback and uninstall accurately distinguish public config from Keychain credentials', () => {
  const content = fs.readFileSync('AI_INSTALL.md', 'utf8');

  // Must NOT claim deleting .env.local completely removes dashboard credentials
  assert.doesNotMatch(content, /刪除 \.env\.local 即可.*完全還原/);

  // State explicitly it removes local public config only
  assert.match(content, /僅.*(移除|清除).*本機公開設定|removes local public config only/i);

  // Firebase refresh credential can remain in Keychain
  assert.match(content, /Keychain.*(保留|殘留|remain)|refresh credential.*Keychain/i);

  // Full lifecycle cleanup documented separately in uninstall/lifecycle guide
  assert.match(content, /完整生命週期|卸載與生命週期指南|lifecycle guide/i);

  // Do not instruct AI to dump Keychain
  assert.match(content, /嚴禁.*(dump|導出|輸出|讀取).*Keychain/i);
});

test('Hosting deployment predeploy safety and State 9 preview role are documented', () => {
  const content = fs.readFileSync('AI_INSTALL.md', 'utf8');

  // Predeploy rebuilds production bundle with fixture guard
  assert.match(content, /build:hosting|predeploy/i);
  assert.match(content, /fixture guard|正式 bundle|production bundle/i);

  // State 9 is explicit local preview, not a prerequisite for safe Hosting deployment
  assert.match(content, /State 9.*(本機預覽|非先決條件|preview.*not a prerequisite)/i);
});



test('AI_INSTALL.md uses the actual LaunchAgent label from implementation', () => {
  const content = fs.readFileSync('AI_INSTALL.md', 'utf8');
  const source = fs.readFileSync('apps/agent/src/background.ts', 'utf8');
  const match = source.match(/BACKGROUND_LABEL\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(match, 'BACKGROUND_LABEL must be discoverable');
  const expected = `${match[1]}.plist`;
  assert.ok(content.includes(expected), `AI_INSTALL.md must reference ${expected}`);
  assert.doesNotMatch(content, /com\.94ai\.usage\.agent\.plist/);
});
