import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const files = [
  'packages/ui/src/screens/DashboardScreen.tsx',
  'packages/ui/src/screens/ResetCreditsScreen.tsx',
  'packages/ui/src/screens/ProviderDetailScreen.tsx',
  'packages/ui/src/screens/GettingStartedScreen.tsx',
  'packages/ui/src/screens/HelpScreen.tsx',
  'packages/ui/src/screens/SettingsScreen.tsx',
  'packages/ui/src/screens/UpdatesScreen.tsx',
  'packages/ui/src/screens/UsageStatsScreen.tsx',
];
const forbidden = [
  'Quota overview', 'Read-only', 'Paired Mac', 'Provider detail', 'Help & privacy',
  'Push Notifications', 'Data Sources', 'Updates & Announcements', '>Providers<',
  'Reset Credits', 'Reset Credit', 'Reset 券', '3 steps',
];

test('正式 UI 標題與操作文案使用正體中文白話，不混入英文控制標籤', () => {
  for (const file of files) {
    const text = fs.readFileSync(path.resolve(file), 'utf8');
    for (const value of forbidden) {
      assert.equal(text.includes(value), false, `${file} 不應出現混英文介面文案：${value}`);
    }
  }
});
