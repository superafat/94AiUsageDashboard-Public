import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('mac install and troubleshooting use stable guided states',()=>{
 const install=fs.readFileSync('docs/install-macos.md','utf8');
 for(const p of ['doctor --json','setup','OpenUsage CLI','Self-hosted','背景同步']) assert.match(install,new RegExp(p,'i'));
 const trouble=fs.readFileSync('docs/troubleshooting.md','utf8');
 for(const p of ['engine_missing','尚未收到可用額度','登入','背景同步','舊資料','彈出']) assert.match(trouble,new RegExp(p,'i'));
 for(const p of ['.env.local','Keychain','token','cookie']) assert.match(trouble,new RegExp(p,'i'));
});
