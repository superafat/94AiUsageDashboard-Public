import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('privacy and app distribution boundaries are explicit',()=>{
 const privacy=fs.readFileSync('docs/privacy-model.md','utf8');
 assert.match(privacy,/Provider.*(?:token|credential|憑證).*Mac/is);
 assert.match(privacy,/Firestore.*UID/is);
 assert.match(privacy,/OpenUsage.*匿名/is);
 assert.match(privacy,/(future official app|未來官方 App).*?(保留|刪除|威脅模型)/is);
 assert.match(privacy,/35.*天.*(?:Token|費用)/is);
 assert.match(privacy,/180.*天.*(?:Token|費用)/is);
 assert.doesNotMatch(privacy,/所有資料.*完全.*不離開 Mac/);
 const app=fs.readFileSync('docs/app-distribution.md','utf8');
 for(const p of ['Google Play','App Store','Capacitor','Mac','Self-hosted']) assert.match(app,new RegExp(p,'i'));
});
