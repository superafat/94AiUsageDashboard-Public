import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('future public issue and PR templates guard secrets and require evidence',()=>{
 const bug=fs.readFileSync('.github/ISSUE_TEMPLATE/bug.yml','utf8');
 for(const p of ['doctor --json','token','auth','重現']) assert.match(bug,new RegExp(p,'i'));
 const feature=fs.readFileSync('.github/ISSUE_TEMPLATE/feature.yml','utf8'); assert.match(feature,/隱私|privacy/i);
 const pr=fs.readFileSync('.github/pull_request_template.md','utf8');
 for(const p of ['tests','screenshot','privacy','Provider']) assert.match(pr,new RegExp(p,'i'));
});
