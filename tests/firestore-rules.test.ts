import { writeUsageHistory } from '@94ai/firebase';
import fs from 'node:fs';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collectionGroup, doc, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore';

let env: RulesTestEnvironment;
const path = (uid: string) => `users/${uid}/devices/device-1/providers/codex`;
const historyPath = (uid: string) => `users/${uid}/devices/device-1/history/codex`;
const healthPath = (uid: string) => `users/${uid}/devices/device-1/health/current`;
const valid = (uid: string) => ({
  schemaVersion: 1,
  userId: uid,
  deviceId: 'device-1',
  providerId: 'codex',
  plan: 'Plus',
  fetchedAt: '2026-09-05T10:00:00.000Z',
  syncedAt: '2026-09-05T10:00:05.000Z',
  expiresAt: '2026-09-05T10:05:00.000Z',
  stale: false,
  resources: { session: { kind: 'consumption', unit: 'percent', remaining: 51 } },
  sourceVersion: 'openusage.limits.v1',
});


const validHistory = (uid: string) => ({
  schemaVersion: 1,
  userId: uid,
  deviceId: 'device-1',
  providerId: 'codex',
  syncedAt: '2026-09-06T00:00:00.000Z',
  currency: 'USD',
  periods: {
    today: { tokens: 100, estimatedCostUsd: 1.5 },
    yesterday: { tokens: 80 },
    last30Days: { tokens: 8000, estimatedCostUsd: 120 },
  },
  daily: [{ date: '2026-09-06', tokens: 100, estimatedCostUsd: 1.5, finalized: false }],
});


const validHealth = (uid: string) => ({
  schemaVersion: 1, userId: uid, deviceId: 'device-1', updatedAt: '2026-09-06T10:00:00.000Z',
  engine: 'ready', background: 'ready', sync: 'ready', providerReadyCount: 3, providerWarningCount: 1,
});

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-94aiusage',
    firestore: { rules: fs.readFileSync('firestore.rules', 'utf8') },
  });
});

afterAll(async () => env.cleanup());

describe('Firestore usage snapshot rules', () => {
  it('rejects unauthenticated reads and writes', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, path('alice'))));
    await assertFails(setDoc(doc(db, path('alice')), valid('alice')));
  });

  it('allows owner read/write but rejects cross-UID access', async () => {
    const alice = env.authenticatedContext('alice').firestore();
    const bob = env.authenticatedContext('bob').firestore();
    await assertSucceeds(setDoc(doc(alice, path('alice')), valid('alice')));
    await assertSucceeds(getDoc(doc(alice, path('alice'))));
    await assertFails(getDoc(doc(bob, path('alice'))));
    await assertFails(setDoc(doc(bob, path('alice')), valid('alice')));
  });

  it('allows the owner-scoped collection-group query used by the web app', async () => {
    const alice = env.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(alice, path('alice')), valid('alice')));
    const snapshots = query(collectionGroup(alice, 'providers'), where('userId', '==', 'alice'));
    await assertSucceeds(getDocs(snapshots));
  });

  it('rejects invalid schema and oversized resource maps', async () => {
    const alice = env.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(alice, path('alice')), { ...valid('alice'), access_token: 'secret' }));
    const resources = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`r${i}`, { kind: 'balance', unit: 'count', available: 1 }]));
    await assertFails(setDoc(doc(alice, path('alice')), { ...valid('alice'), resources }));
  });

  it('isolates owner history and rejects secret-bearing or oversized history', async () => {
    const alice = env.authenticatedContext('alice').firestore();
    const bob = env.authenticatedContext('bob').firestore();
    await assertSucceeds(setDoc(doc(alice, historyPath('alice')), validHistory('alice')));
    const thirtyOneDays = Array.from({ length: 31 }, (_, index) => ({
      date: `2026-${index < 25 ? '08' : '09'}-${String(index < 25 ? index + 1 : index - 24).padStart(2, '0')}`,
      tokens: 50_000_000 + index * 1_000_000,
      ...(index >= 29 ? { estimatedCostUsd: 2.5 + index } : {}),
      finalized: index < 30,
    }));
    await assertSucceeds(writeUsageHistory(alice, 'alice', { ...validHistory('alice'), daily: thirtyOneDays } as import('@94ai/core').UsageHistorySnapshot));
    await assertSucceeds(getDoc(doc(alice, historyPath('alice'))));
    await assertFails(getDoc(doc(bob, historyPath('alice'))));
    await assertFails(setDoc(doc(bob, historyPath('alice')), validHistory('alice')));
    await assertFails(setDoc(doc(alice, historyPath('alice')), { ...validHistory('alice'), prompt: 'secret' }));
    await assertFails(setDoc(doc(alice, historyPath('alice')), { ...validHistory('alice'), daily: [{ date: '2026-09-06', tokens: 10, finalized: true, prompt: 'private' }] }));
    await assertFails(setDoc(doc(alice, historyPath('alice')), { ...validHistory('alice'), daily: [{ date: '2026-09-06', tokens: 10, finalized: true, token: 'secret' }] }));
    await assertFails(setDoc(doc(alice, historyPath('alice')), { ...validHistory('alice'), daily: Array.from({ length: 36 }, (_, i) => ({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, tokens: i, finalized: true })) }));
  });


  it('isolates minimal device health and rejects diagnostics or cross-UID writes', async () => {
    const alice = env.authenticatedContext('alice').firestore();
    const bob = env.authenticatedContext('bob').firestore();
    await assertSucceeds(setDoc(doc(alice, healthPath('alice')), validHealth('alice')));
    await assertSucceeds(getDoc(doc(alice, healthPath('alice'))));
    await assertFails(getDoc(doc(bob, healthPath('alice'))));
    await assertFails(setDoc(doc(bob, healthPath('alice')), validHealth('alice')));
    for (const key of ['token', 'path', 'stderr']) {
      await assertFails(setDoc(doc(alice, healthPath('alice')), { ...validHealth('alice'), [key]: 'private' }));
    }
  });

  it('isolates owner provider preferences and enforces bounded schema and identity', async () => {
    const prefPath = (uid: string, family: string) => `users/${uid}/preferences/${family}`;
    const validPreference = (uid: string, family: string) => ({
      schemaVersion: 1,
      userId: uid,
      family,
      enabled: true,
      updatedAt: '2026-09-10T10:00:00.000Z',
    });

    const alice = env.authenticatedContext('alice').firestore();
    const bob = env.authenticatedContext('bob').firestore();
    const anon = env.unauthenticatedContext().firestore();

    // Rejects unauthenticated read and write
    await assertFails(getDoc(doc(anon, prefPath('alice', 'cursor'))));
    await assertFails(setDoc(doc(anon, prefPath('alice', 'cursor')), validPreference('alice', 'cursor')));

    // Allows owner write and read
    await assertSucceeds(setDoc(doc(alice, prefPath('alice', 'cursor')), validPreference('alice', 'cursor')));
    await assertSucceeds(getDoc(doc(alice, prefPath('alice', 'cursor'))));

    // Allows reserved notification fields
    await assertSucceeds(setDoc(doc(alice, prefPath('alice', 'claude')), {
      ...validPreference('alice', 'claude'),
      notifications: { lowQuota: false, reset: false },
    }));

    // Rejects cross-UID access
    await assertFails(getDoc(doc(bob, prefPath('alice', 'cursor'))));
    await assertFails(setDoc(doc(bob, prefPath('alice', 'cursor')), validPreference('alice', 'cursor')));
    await assertFails(setDoc(doc(bob, prefPath('alice', 'cursor')), validPreference('bob', 'cursor')));

    // Rejects unexpected fields or non-boolean enabled
    await assertFails(setDoc(doc(alice, prefPath('alice', 'codex')), {
      ...validPreference('alice', 'codex'),
      token: 'not-a-real-value',
    }));
    await assertFails(setDoc(doc(alice, prefPath('alice', 'codex')), {
      ...validPreference('alice', 'codex'),
      enabled: 'true',
    }));
    await assertFails(setDoc(doc(alice, prefPath('alice', 'codex')), {
      ...validPreference('alice', 'codex'),
      family: 'wrong-family',
    }));
    await assertFails(setDoc(doc(alice, prefPath('alice', 'unknown-family')), validPreference('alice', 'unknown-family')));
  });
});

it('rejects oversized preference timestamps and preserves notification fields on source-only changes', async () => {
  const alice = env.authenticatedContext('preference-lifecycle').firestore();
  const ref = doc(alice, 'users/preference-lifecycle/preferences/codex');
  const preference = {schemaVersion: 1, userId: 'preference-lifecycle', family: 'codex', enabled: true, updatedAt: '2026-09-10T00:00:00.000Z'};
  for (const updatedAt of ['x'.repeat(100), 'x', '2026-02-30T00:00:00Z', '2026-09-10T99:00:00Z']) {
    await assertFails(setDoc(ref, {...preference, updatedAt}));
  }
  await assertSucceeds(setDoc(ref, {...preference, updatedAt: '2024-02-29T23:59:59.123Z'}));
  await assertSucceeds(setDoc(ref, {...preference, notifications: {lowQuota: true, reset: true}}));
  await assertSucceeds(setDoc(ref, {...preference, enabled: false}, {merge: true}));
  const actual = (await getDoc(ref)).data();
  if (actual?.enabled !== false || actual.notifications?.lowQuota !== true || actual.notifications?.reset !== true) throw new Error('source-only update erased notifications');
});

describe('Firestore push notifications rules', () => {
  const producerPath = (uid: string, devId: string) => `users/${uid}/pushProducers/${devId}`;
  const subPath = (uid: string, browserId: string) => `users/${uid}/pushSubscriptions/${browserId}`;

  const validProducer = (uid: string, devId: string) => ({
    schemaVersion: 1,
    userId: uid,
    deviceId: devId,
    publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjGwVQxSbMuSt6',
    updatedAt: '2026-09-10T12:00:00.000Z',
  });

  const validSub = (uid: string, browserId: string) => ({
    schemaVersion: 1,
    userId: uid,
    browserId,
    targetDeviceId: 'mac-1',
    enrollmentEpoch: 1,
    applicationServerKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjGwVQxSbMuSt6',
    endpoint: 'https://fcm.googleapis.com/fcm/send/sample-token',
    p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QT9P04MgDxBCH40PvK_VQzsQmtiUtWIf8DnnyP4PhAj2XXTc',
    auth: 'tBHItJI5svbpez7KI4CCXg',
    createdAt: '2026-09-10T12:00:00.000Z',
    expiresAt: '2026-10-10T12:00:00.000Z',
  });

  it('enforces owner isolation and schema on pushProducers', async () => {
    const alice = env.authenticatedContext('alice').firestore();
    const bob = env.authenticatedContext('bob').firestore();
    const anon = env.unauthenticatedContext().firestore();

    await assertFails(getDoc(doc(anon, producerPath('alice', 'mac-1'))));
    await assertFails(setDoc(doc(anon, producerPath('alice', 'mac-1')), validProducer('alice', 'mac-1')));

    await assertSucceeds(setDoc(doc(alice, producerPath('alice', 'mac-1')), validProducer('alice', 'mac-1')));
    await assertSucceeds(getDoc(doc(alice, producerPath('alice', 'mac-1'))));

    await assertFails(getDoc(doc(bob, producerPath('alice', 'mac-1'))));
    await assertFails(setDoc(doc(bob, producerPath('alice', 'mac-1')), validProducer('bob', 'mac-1')));

    // Rejects delete
    const { deleteDoc } = await import('firebase/firestore');
    await assertFails(deleteDoc(doc(alice, producerPath('alice', 'mac-1'))));
    // Rejects unknown fields
    await assertFails(setDoc(doc(alice, producerPath('alice', 'mac-1')), { ...validProducer('alice', 'mac-1'), privateKey: 'not-a-real-value' }));
  });

  it('enforces owner isolation, endpoint whitelist, and owner deletion on pushSubscriptions', async () => {
    const alice = env.authenticatedContext('alice').firestore();
    const bob = env.authenticatedContext('bob').firestore();

    await assertSucceeds(setDoc(doc(alice, subPath('alice', 'browser-1')), validSub('alice', 'browser-1')));
    await assertSucceeds(getDoc(doc(alice, subPath('alice', 'browser-1'))));

    await assertFails(getDoc(doc(bob, subPath('alice', 'browser-1'))));
    await assertFails(setDoc(doc(bob, subPath('alice', 'browser-1')), validSub('bob', 'browser-1')));

    // Rejects invalid endpoints (non-whitelisted host)
    await assertFails(setDoc(doc(alice, subPath('alice', 'browser-2')), {
      ...validSub('alice', 'browser-2'),
      endpoint: 'https://evil.com/push',
    }));

    // Allows owner delete (for logout/revoke)
    const { deleteDoc } = await import('firebase/firestore');
    await assertSucceeds(deleteDoc(doc(alice, subPath('alice', 'browser-1'))));
  });
  it('keeps enrolled routing immutable while allowing an owner test request', async () => {
    const db=env.authenticatedContext('immutable-push').firestore(),ref=doc(db,subPath('immutable-push','browser-fixed'));
    const original=validSub('immutable-push','browser-fixed');await assertSucceeds(setDoc(ref,original));
    for(const patch of [{targetDeviceId:'another-mac'},{enrollmentEpoch:2},{endpoint:'https://fcm.googleapis.com/fcm/send/changed'},{auth:'different-value'}])await assertFails(setDoc(ref,{...original,...patch}));
    await assertSucceeds(setDoc(ref,{...original,testRequestId:'owner-test',testRequestedAt:'2026-09-10T12:01:00.000Z'}));
  });

});
