import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertFails, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, collectionGroup, doc, getDoc, getDocs, query, setDoc, where, writeBatch } from 'firebase/firestore';
import type { UsageHistorySnapshot } from '@94ai/core';
import { historyDocPath, subscribeUsageHistory, writeUsageHistory } from '@94ai/firebase';
import { assembleUsageHistory, splitHistoryForStorage } from '../packages/firebase/src/history-storage';

let env: RulesTestEnvironment;
beforeAll(async () => { env = await initializeTestEnvironment({ projectId: 'demo-94aiusage', firestore: { rules: fs.readFileSync('firestore.rules', 'utf8') } }); });
afterAll(async () => { await env.cleanup(); });
function history(uid: string, count: number): UsageHistorySnapshot {
  return { schemaVersion: 1, userId: uid, deviceId: 'device-storage', providerId: 'codex', syncedAt: '2026-09-06T08:00:00.000Z', currency: 'USD',
    periods: { today: { tokens: 123, estimatedCostUsd: 1.23 }, yesterday: { tokens: 456, estimatedCostUsd: 4.56 }, last30Days: { tokens: 9999999, estimatedCostUsd: 99.99 } },
    daily: Array.from({ length: count }, (_, i) => ({ date: new Date(Date.UTC(2026, 7, 3 + i)).toISOString().slice(0, 10), tokens: 2_000_000_000 + i, estimatedCostUsd: i / 10, finalized: i < count - 1 })) };
}
describe('full-size production history storage', () => {
  for (const count of [0, 1, 7, 31, 35]) it(`roundtrips ${count} days through real owner rules and production adapters`, async () => {
    const uid = `storage-${count}`; const db = env.authenticatedContext(uid).firestore(); const item = history(uid, count);
    await writeUsageHistory(db, uid, item);
    const summaryRef = doc(db, historyDocPath(uid, item.deviceId, item.providerId));
    const summary = (await getDoc(summaryRef)).data()!;
    expect(summary.storageVersion).toBe(2);
    const chunks = (await getDocs(collection(db, `${summaryRef.path}/historyChunks`))).docs.map(d => d.data());
    expect(assembleUsageHistory(summary, chunks)).toEqual(item);
    const observed = await new Promise<UsageHistorySnapshot[]>((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new Error('history subscription timeout')); }, 4000);
      const stop = subscribeUsageHistory(db, uid, values => { if (values.some(v => v.daily.length === count)) { clearTimeout(timer); stop(); resolve(values); } }, reject);
    });
    expect(observed).toEqual([item]);
    const foreign = env.authenticatedContext('storage-bob').firestore();
    await assertFails(getDocs(query(collectionGroup(foreign, 'historyChunks'), where('userId', '==', uid))));
    await assertFails(getDoc(doc(foreign, summaryRef.path)));
  });
  it('deletes old chunks when history shrinks and rejects sensitive rows atomically', async () => {
    const uid = 'storage-shrink'; const db = env.authenticatedContext(uid).firestore(); const item = history(uid, 35);
    await writeUsageHistory(db, uid, item);
    const base = historyDocPath(uid, item.deviceId, item.providerId);
    const changed = { ...history(uid, 1), syncedAt: '2026-09-06T08:05:00.000Z' };
    const candidate = splitHistoryForStorage(changed);
    const batch = writeBatch(db);
    batch.set(doc(db, base), candidate.summary);
    batch.set(doc(db, `${base}/historyChunks/0`), { ...candidate.chunks[0], daily: [{ ...changed.daily[0], prompt: 'private' }] });
    await assertFails(batch.commit());
    expect((await getDoc(doc(db, base))).data()!.syncedAt).toBe(item.syncedAt);
    await writeUsageHistory(db, uid, changed);
    expect((await getDocs(collection(db, `${base}/historyChunks`))).size).toBe(1);
    const good = { ...splitHistoryForStorage(item).chunks[0]! };
    for (const patch of [{ tokens: -1 }, { estimatedCostUsd: -2 }, { date: 'not-a-date' }, { token: 'secret' }]) {
      await assertFails(setDoc(doc(db, `${base}/historyChunks/0`), { ...good, daily: [{ ...good.daily[0], ...patch }] }));
    }
    await assertFails(setDoc(doc(db, `${base}/historyChunks/7`), { ...good, chunkId: '7' }));
    await assertFails(setDoc(doc(db, `${base}/historyChunks/0`), { ...good, daily: [...good.daily, good.daily[0]] }));
    const bob = env.authenticatedContext('storage-bob').firestore();
    await assertFails(setDoc(doc(bob, `${base}/historyChunks/0`), good));
  });
});
