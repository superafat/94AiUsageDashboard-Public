import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('docs/uninstall.md covers complete self-hosted lifecycle and clear boundary separation', () => {
  const uninstall = fs.readFileSync('docs/uninstall.md', 'utf8');

  // Must distinguish removing 94AiUsageDashboard from removing OpenUsage / Provider credentials
  assert.match(uninstall, /不會.*(?:登出|logout).*?(?:Codex|Antigravity|Claude)/i);
  assert.match(uninstall, /不會.*(?:刪除|清除).*?(?:Provider|供應商|模型).*?(?:credential|憑證|session)/i);
  assert.match(uninstall, /不會.*(?:解除安裝|uninstall).*?OpenUsage/i);

  // Section 1: Mac background agent removal
  assert.match(uninstall, /npm run usage -- uninstall/);
  assert.match(uninstall, /launchctl/i);
  assert.match(uninstall, /com\.94ai\.usage-dashboard\.sync\.plist/);

  // Section 2: Local dashboard credentials & state removal
  assert.match(uninstall, /94AiUsageDashboard/);
  assert.match(uninstall, /firebase-refresh-token/);
  assert.match(uninstall, /\.config\/94ai-usage-dashboard\/device-id/);
  assert.match(uninstall, /\.env\.local/);

  // Section 3: Firebase project and cloud data removal
  assert.match(uninstall, /Firestore/i);
  assert.match(uninstall, /\/users\/{uid}/);
  assert.match(uninstall, /Firebase Console|firebase projects:delete/i);

  // Section 4: OpenUsage independence & Provider credential boundaries
  assert.match(uninstall, /OpenUsage/i);
  assert.match(uninstall, /brew uninstall/i);

  // Section 5: Browser and PWA cleanup
  assert.match(uninstall, /PWA|瀏覽器|browser/i);
  assert.match(uninstall, /localStorage|IndexedDB|Service Worker|快取|Cache/i);
});

test('docs/privacy-model.md lists exact Firebase collection paths and actual retention semantics', () => {
  const privacy = fs.readFileSync('docs/privacy-model.md', 'utf8');

  // Exact Firestore collection paths
  assert.match(privacy, /\/users\/{uid}\/devices\/{deviceId}\/providers\/{providerId}/);
  assert.match(privacy, /\/users\/{uid}\/devices\/{deviceId}\/history\/{providerId}/);
  assert.match(privacy, /\/users\/{uid}\/devices\/{deviceId}\/history\/{providerId}\/historyChunks\/{chunkId}/);
  assert.match(privacy, /\/users\/{uid}\/devices\/{deviceId}\/health\/{healthId}/);

  // Reset-command metadata retention semantics
  assert.match(privacy, /(?:reset|重置).*?(?:command|命令|額度|metadata)/i);

  // Actual retention semantics
  assert.match(privacy, /保留|retention/i);
  assert.match(privacy, /35.*天/);
  assert.match(privacy, /覆寫|overwrite|最新|快照|snapshot/i);

  // Provider credential logout independence
  assert.match(uninstallOrPrivacyMatches(privacy), /不會.*(?:登出|刪除).*?(?:Codex|Antigravity|Claude|Provider)/i);
});

function uninstallOrPrivacyMatches(text) {
  return text;
}

test('SECURITY.md and troubleshooting.md explicitly forbid attaching sensitive files and full logs', () => {
  const security = fs.readFileSync('SECURITY.md', 'utf8');
  const trouble = fs.readFileSync('docs/troubleshooting.md', 'utf8');

  for (const doc of [security, trouble]) {
    assert.match(doc, /\.env\.local/);
    assert.match(doc, /Keychain/i);
    assert.match(doc, /(?:Provider.*?(?:auth|session)|auth\/session)/i);
    assert.match(doc, /(?:log.*?(?:token|權杖)|權杖.*log|完整.*log)/i);
  }

  // Security reporting instructs safe sanitized sharing
  assert.match(trouble, /doctor --json/);
  assert.match(security, /Private Vulnerability Reporting|Security Advisory/i);
});
