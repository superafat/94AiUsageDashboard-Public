import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('canonical public-ready verifier is wired into CI',()=>{
 const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
 assert.equal(pkg.scripts['verify:public-ready'],'node scripts/verify-public-ready.mjs');
 assert.match(fs.readFileSync('.github/workflows/ci.yml','utf8'),/npm run verify:public-ready/);
 assert.ok(fs.existsSync('scripts/verify-public-ready.mjs'));
});
