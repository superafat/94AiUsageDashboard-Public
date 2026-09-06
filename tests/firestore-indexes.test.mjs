import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const config = JSON.parse(fs.readFileSync(new URL('../firestore.indexes.json', import.meta.url), 'utf8'));

test('providers userId has a collection-group index', () => {
  const all = [...(config.indexes ?? []), ...(config.fieldOverrides ?? [])];
  const found = all.some((entry) =>
    entry.collectionGroup === 'providers' &&
    (entry.fields?.some?.((field) => field.fieldPath === 'userId') || entry.fieldPath === 'userId') &&
    (entry.queryScope === 'COLLECTION_GROUP' || entry.indexes?.some?.((index) => index.queryScope === 'COLLECTION_GROUP'))
  );
  assert.equal(found, true, 'collectionGroup(providers).where(userId == uid) needs a COLLECTION_GROUP index');
});