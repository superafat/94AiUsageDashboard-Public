import { writeUsageHistory } from '@94ai/firebase';
import fs from 'node:fs';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collectionGroup, doc, getDoc, getDocs, query, setDoc, where, type Firestore } from 'firebase/firestore';

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

  it('rejects pushProducer publicKey mutation while allowing timestamp updates', async () => {
    const alice = env.authenticatedContext('producer-owner').firestore();
    const ref = doc(alice, producerPath('producer-owner', 'mac-immutable'));
    const original = validProducer('producer-owner', 'mac-immutable');
    await assertSucceeds(setDoc(ref, original));
    await assertFails(setDoc(ref, { ...original, publicKey: 'BDifferentKeyForPushProducer1234567890123456789012345678901234567890123456' }));
    await assertSucceeds(setDoc(ref, { ...original, updatedAt: '2026-09-10T13:00:00.000Z' }));
  });
});

describe('Firestore reset control and results rules (Issue #30 R2)', () => {
  const requestPath = (uid: string, devId: string) => `users/${uid}/devices/${devId}/resetControl/request`;
  const inventoryPath = (uid: string, devId: string) => `users/${uid}/devices/${devId}/resetControl/inventory`;
  const resultPath = (uid: string, devId: string, cmdId: string) => `users/${uid}/devices/${devId}/resetResults/${cmdId}`;

  const resetPublicKey = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjGwVQxSbMuSt6';
  const validReq = (uid: string, devId: string, cmdId = 'cmd-1', requestedAt?: string, expiresAt?: string) => {
    const requested = requestedAt ?? new Date().toISOString();
    const expires = expiresAt ?? new Date(Date.now() + 9 * 60_000).toISOString();
    return ({
    version: 1,
    browserId: 'browser-1',
    producerPublicKey: resetPublicKey,
    leaseExpiresAt: expires,
    requestedAtTimestamp: new Date(requested),
    leaseExpiresAtTimestamp: new Date(expires),
    command: {
      version: 1,
      commandId: cmdId,
      idempotencyKey: `idem-${cmdId}`,
      creditId: 'credit-1',
      accountId: 'acc-1',
      targetDeviceId: devId,
      userId: uid,
      backendId: 'codex',
      requestedAt: requested,
      expiresAt: expires,
    },
  });
  };

  const validInv = (uid: string, devId: string) => {
    const observedAt = new Date(Date.now() - 30_000).toISOString();
    const expiresAt = new Date(Date.now() + 4 * 60_000).toISOString();
    return ({
    version: 1,
    type: 'inventory',
    publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjGwVQxSbMuSt6',
    signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    observedAtTimestamp: new Date(observedAt),
    expiresAtTimestamp: new Date(expiresAt),
    inventory: {
      version: 1,
      backendId: 'codex',
      userId: uid,
      targetDeviceId: devId,
      accountId: 'acc-1',
      observedAt,
      expiresAt,
      availableCount: 1,
      credits: [
        {
          creditId: 'credit-1',
          expiresAt: null,
          status: 'available',
          resetType: 'codexRateLimits',
        },
      ],
    },
  });
  };

  const validExec = (uid: string, devId: string, cmdId = 'cmd-1') => ({
    version: 1,
    type: 'executing',
    publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjGwVQxSbMuSt6',
    signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    backendId: 'codex',
    userId: uid,
    targetDeviceId: devId,
    accountId: 'acc-1',
    commandId: cmdId,
    idempotencyKey: `idem-${cmdId}`,
    creditId: 'credit-1',
    executedAt: '2026-09-12T10:01:00.000Z',
  });

  const validTerm = (uid: string, devId: string, cmdId = 'cmd-1') => ({
    version: 1,
    type: 'terminal',
    publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjGwVQxSbMuSt6',
    signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    backendId: 'codex',
    userId: uid,
    targetDeviceId: devId,
    accountId: 'acc-1',
    commandId: cmdId,
    idempotencyKey: `idem-${cmdId}`,
    creditId: 'credit-1',
    executedAt: '2026-09-12T10:01:00.000Z',
    result: {
      version: 1,
      commandId: cmdId,
      idempotencyKey: `idem-${cmdId}`,
      creditId: 'credit-1',
      accountId: 'acc-1',
      targetDeviceId: devId,
      userId: uid,
      backendId: 'codex',
      state: 'success',
      code: 'reset',
      executedAt: '2026-09-12T10:01:00.000Z',
      completedAt: '2026-09-12T10:01:05.000Z',
    },
  });

  const seedProducer = async (db: Firestore, uid: string, devId: string) => {
    await setDoc(doc(db, `users/${uid}/pushProducers/${devId}`), {
      schemaVersion: 1,
      userId: uid,
      deviceId: devId,
      publicKey: resetPublicKey,
      updatedAt: new Date().toISOString(),
    });
  };

  it('enforces owner isolation and strict schema while allowing owner-only inventory invalidation', async () => {
    const alice = env.authenticatedContext('reset-alice').firestore();
    const bob = env.authenticatedContext('reset-bob').firestore();
    const anon = env.unauthenticatedContext().firestore();
    const ref = doc(alice, inventoryPath('reset-alice', 'mac-1'));
    await seedProducer(alice, 'reset-alice', 'mac-1');

    await assertFails(getDoc(doc(anon, inventoryPath('reset-alice', 'mac-1'))));
    await assertFails(setDoc(doc(anon, inventoryPath('reset-alice', 'mac-1')), validInv('reset-alice', 'mac-1')));

    await assertFails(getDoc(doc(bob, inventoryPath('reset-alice', 'mac-1'))));
    await assertFails(setDoc(doc(bob, inventoryPath('reset-alice', 'mac-1')), validInv('reset-alice', 'mac-1')));
    await assertFails(setDoc(doc(bob, inventoryPath('reset-alice', 'mac-1')), validInv('reset-bob', 'mac-1')));

    await assertSucceeds(setDoc(ref, validInv('reset-alice', 'mac-1')));
    await assertSucceeds(getDoc(ref));

    // Reject extra keys
    await assertFails(setDoc(ref, { ...validInv('reset-alice', 'mac-1'), extraKey: 'bad' }));
    // Owner may delete a signed inventory only to invalidate stale actionable UI state; cross-UID delete stays forbidden.
    const { deleteDoc } = await import('firebase/firestore');
    await assertFails(deleteDoc(doc(bob, inventoryPath('reset-alice', 'mac-1'))));
    await assertSucceeds(deleteDoc(ref));
  });

  it('enforces owner isolation, 10m lease bound, and schema validity on reset request', async () => {
    const alice = env.authenticatedContext('reset-alice').firestore();
    const bob = env.authenticatedContext('reset-bob').firestore();
    const ref = doc(alice, requestPath('reset-alice', 'mac-req-schema'));
    await seedProducer(alice, 'reset-alice', 'mac-req-schema');

    // Reject cross-UID
    await assertFails(setDoc(doc(bob, requestPath('reset-alice', 'mac-req-schema')), validReq('reset-alice', 'mac-req-schema')));
    await assertFails(setDoc(ref, validReq('reset-bob', 'mac-req-schema')));

    // Reject wrong targetDeviceId
    await assertFails(setDoc(ref, validReq('reset-alice', 'wrong-mac')));

    // Reject extra key
    await assertFails(setDoc(ref, { ...validReq('reset-alice', 'mac-req-schema'), extra: 'bad' }));

    // Reject lease mismatch
    const badLease = validReq('reset-alice', 'mac-req-schema');
    badLease.leaseExpiresAt = '2026-09-12T10:05:00.000Z'; // command.expiresAt is 10:10
    await assertFails(setDoc(ref, badLease));

    // Reject lease > 10m
    const longLease = validReq('reset-alice', 'mac-req-schema', 'cmd-long', '2026-09-12T10:00:00.000Z', '2026-09-12T10:15:00.000Z');
    await assertFails(setDoc(ref, longLease));

    // Valid create succeeds
    await assertSucceeds(setDoc(ref, validReq('reset-alice', 'mac-req-schema')));

    // Reject delete
    const { deleteDoc } = await import('firebase/firestore');
    await assertFails(deleteDoc(ref));
  });

  it('enforces active-slot contention: two active phones cannot both win', async () => {
    const alice = env.authenticatedContext('phone-contention').firestore();
    const ref = doc(alice, requestPath('phone-contention', 'mac-slot'));
    await seedProducer(alice, 'phone-contention', 'mac-slot');

    // Phone 1 writes request with 10m lease in future
    const futureExpiry = new Date(Date.now() + 8 * 60_000).toISOString();
    const req1 = validReq('phone-contention', 'mac-slot', 'cmd-phone-1', new Date().toISOString(), futureExpiry);
    await assertSucceeds(setDoc(ref, req1));

    // Phone 2 tries to overwrite while Phone 1 lease is still active and no result exists
    const req2 = validReq('phone-contention', 'mac-slot', 'cmd-phone-2', new Date().toISOString(), futureExpiry);
    await assertFails(setDoc(ref, req2));
  });

  it('allows replacement of expired request slot', async () => {
    const alice = env.authenticatedContext('phone-expired').firestore();
    const ref = doc(alice, requestPath('phone-expired', 'mac-expired'));
    await seedProducer(alice, 'phone-expired', 'mac-expired');

    // Write a request with expired lease in past
    const pastRequested = '2026-01-01T10:00:00.000Z';
    const pastExpires = '2026-01-01T10:10:00.000Z';
    const expiredReq = validReq('phone-expired', 'mac-expired', 'cmd-old', pastRequested, pastExpires);
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), requestPath('phone-expired', 'mac-expired')), expiredReq);
    });

    // Replacement with new request succeeds
    const futureExpiry = new Date(Date.now() + 8 * 60_000).toISOString();
    const newReq = validReq('phone-expired', 'mac-expired', 'cmd-new', new Date().toISOString(), futureExpiry);
    await assertSucceeds(setDoc(ref, newReq));
  });

  it('prior-result existence releases the cloud slot even if lease is still in future', async () => {
    const alice = env.authenticatedContext('phone-result-release').firestore();
    const reqRef = doc(alice, requestPath('phone-result-release', 'mac-release'));
    const resRef = doc(alice, resultPath('phone-result-release', 'mac-release', 'cmd-prior'));
    await seedProducer(alice, 'phone-result-release', 'mac-release');

    // Write request with lease in future
    const futureExpiry = new Date(Date.now() + 8 * 60_000).toISOString();
    const reqPrior = validReq('phone-result-release', 'mac-release', 'cmd-prior', new Date().toISOString(), futureExpiry);
    await assertSucceeds(setDoc(reqRef, reqPrior));

    // Another phone cannot write yet
    const reqNext = validReq('phone-result-release', 'mac-release', 'cmd-next', new Date().toISOString(), futureExpiry);
    await assertFails(setDoc(reqRef, reqNext));

    // Create result document for cmd-prior
    await assertSucceeds(setDoc(resRef, validExec('phone-result-release', 'mac-release', 'cmd-prior')));

    // Now replacement of request slot is permitted
    await assertSucceeds(setDoc(reqRef, reqNext));
  });

  it('enforces result state transitions: create executing/terminal, update executing->terminal only, terminal immutable and delete false', async () => {
    const alice = env.authenticatedContext('result-lifecycle').firestore();
    const bob = env.authenticatedContext('result-bob').firestore();
    const resRef = doc(alice, resultPath('result-lifecycle', 'mac-res', 'cmd-life'));
    await seedProducer(alice, 'result-lifecycle', 'mac-res');

    // Reject wrong UID/device/path
    await assertFails(setDoc(doc(bob, resultPath('result-lifecycle', 'mac-res', 'cmd-life')), validExec('result-lifecycle', 'mac-res', 'cmd-life')));
    // Exact commandId path: mismatch between path and payload
    await assertFails(setDoc(doc(alice, resultPath('result-lifecycle', 'mac-res', 'wrong-cmd-id')), validExec('result-lifecycle', 'mac-res', 'cmd-life')));

    // Create executing succeeds
    await assertSucceeds(setDoc(resRef, validExec('result-lifecycle', 'mac-res', 'cmd-life')));

    // Mutating executing to another executing fails
    await assertFails(setDoc(resRef, { ...validExec('result-lifecycle', 'mac-res', 'cmd-life'), creditId: 'credit-mutated' }));

    // Transition cannot change device key or account identity.
    await assertFails(setDoc(resRef, { ...validTerm('result-lifecycle', 'mac-res', 'cmd-life'), publicKey: 'BDifferentPublicKey123456789012345678901234567890123456789012345678901234' }));
    await assertFails(setDoc(resRef, { ...validTerm('result-lifecycle', 'mac-res', 'cmd-life'), accountId: 'acc-other', result: { ...validTerm('result-lifecycle', 'mac-res', 'cmd-life').result, accountId: 'acc-other' } }));

    // Transition executing -> terminal succeeds
    await assertSucceeds(setDoc(resRef, validTerm('result-lifecycle', 'mac-res', 'cmd-life')));

    // Mutating terminal result fails (terminal immutable)
    await assertFails(setDoc(resRef, { ...validTerm('result-lifecycle', 'mac-res', 'cmd-life'), signature: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }));

    // Deleting terminal result fails
    const { deleteDoc } = await import('firebase/firestore');
    await assertFails(deleteDoc(resRef));

    // Also: directly creating terminal result succeeds
    const directTermRef = doc(alice, resultPath('result-lifecycle', 'mac-res', 'cmd-direct-term'));
    await assertSucceeds(setDoc(directTermRef, validTerm('result-lifecycle', 'mac-res', 'cmd-direct-term')));
    await assertFails(deleteDoc(directTermRef));

    // Terminal result with r3_authorization_required succeeds
    const r3BlockedRef = doc(alice, resultPath('result-lifecycle', 'mac-res', 'cmd-r3-blocked'));
    const r3Term = validTerm('result-lifecycle', 'mac-res', 'cmd-r3-blocked');
    r3Term.result.state = 'failed';
    r3Term.result.code = 'r3_authorization_required';
    await assertSucceeds(setDoc(r3BlockedRef, r3Term));
  });

  it('rejects future-dated request leases that could lock the fixed slot indefinitely', async () => {
    const alice = env.authenticatedContext('future-lock').firestore();
    await seedProducer(alice, 'future-lock', 'mac-future');
    const ref = doc(alice, requestPath('future-lock', 'mac-future'));
    const requested = '2099-01-01T00:00:00.000Z';
    const expires = '2099-01-01T00:09:00.000Z';
    await assertFails(setDoc(ref, validReq('future-lock', 'mac-future', 'cmd-future', requested, expires)));
  });

  it('binds reset records to the immutable producer key and enforces a five-minute inventory window', async () => {
    const alice = env.authenticatedContext('key-bound').firestore();
    await seedProducer(alice, 'key-bound', 'mac-key');
    const invRef = doc(alice, inventoryPath('key-bound', 'mac-key'));
    const reqRef = doc(alice, requestPath('key-bound', 'mac-key'));
    const resRef = doc(alice, resultPath('key-bound', 'mac-key', 'cmd-key'));

    await assertFails(setDoc(invRef, { ...validInv('key-bound', 'mac-key'), publicKey: 'BWrongKey12345678901234567890123456789012345678901234567890123456789012' }));
    const tooLong = validInv('key-bound', 'mac-key');
    tooLong.inventory.expiresAt = new Date(Date.parse(tooLong.inventory.observedAt) + 6 * 60_000).toISOString();
    tooLong.expiresAtTimestamp = new Date(tooLong.inventory.expiresAt);
    await assertFails(setDoc(invRef, tooLong));

    const wrongReq = validReq('key-bound', 'mac-key', 'cmd-key');
    wrongReq.producerPublicKey = 'BWrongKey12345678901234567890123456789012345678901234567890123456789012';
    await assertFails(setDoc(reqRef, wrongReq));

    await assertFails(setDoc(resRef, { ...validExec('key-bound', 'mac-key', 'cmd-key'), publicKey: 'BWrongKey12345678901234567890123456789012345678901234567890123456789012' }));
  });

  it('validates every remote inventory credit row and rejects backwards terminal completion time', async () => {
    const alice = env.authenticatedContext('deep-schema').firestore();
    await seedProducer(alice, 'deep-schema', 'mac-deep');
    const invRef = doc(alice, inventoryPath('deep-schema', 'mac-deep'));
    const inv = validInv('deep-schema', 'mac-deep');
    inv.inventory.credits = [
      inv.inventory.credits[0]!,
      { creditId: 'credit-2', expiresAt: null, status: 'available', resetType: 'codexRateLimits', extra: 'forged' } as never,
    ];
    await assertFails(setDoc(invRef, inv));

    const tooMany = validInv('deep-schema', 'mac-deep');
    tooMany.inventory.availableCount = 3;
    tooMany.inventory.credits = [
      tooMany.inventory.credits[0]!,
      { creditId: 'credit-2', expiresAt: null, status: 'available', resetType: 'codexRateLimits' },
      { creditId: 'credit-3', expiresAt: null, status: 'available', resetType: 'codexRateLimits' },
    ];
    await assertFails(setDoc(invRef, tooMany));

    const resRef = doc(alice, resultPath('deep-schema', 'mac-deep', 'cmd-backwards'));
    const terminal = validTerm('deep-schema', 'mac-deep', 'cmd-backwards');
    terminal.result.completedAt = '2026-09-12T10:00:59.000Z';
    await assertFails(setDoc(resRef, terminal));
  });

  it('enforces millisecond precision for completedAt >= executedAt within the same second', async () => {
    const alice = env.authenticatedContext('ms-precision').firestore();
    await seedProducer(alice, 'ms-precision', 'mac-ms');

    // Case A: backwards within the same second — MUST FAIL
    const resRefBackwards = doc(alice, resultPath('ms-precision', 'mac-ms', 'cmd-ms-backwards'));
    const termBackwards = validTerm('ms-precision', 'mac-ms', 'cmd-ms-backwards');
    termBackwards.executedAt = '2026-09-12T10:01:00.900Z';
    termBackwards.result.executedAt = '2026-09-12T10:01:00.900Z';
    termBackwards.result.completedAt = '2026-09-12T10:01:00.100Z';
    await assertFails(setDoc(resRefBackwards, termBackwards));

    // Case B: forwards within the same second — MUST PASS
    const resRefForwards = doc(alice, resultPath('ms-precision', 'mac-ms', 'cmd-ms-forwards'));
    const termForwards = validTerm('ms-precision', 'mac-ms', 'cmd-ms-forwards');
    termForwards.executedAt = '2026-09-12T10:01:00.100Z';
    termForwards.result.executedAt = '2026-09-12T10:01:00.100Z';
    termForwards.result.completedAt = '2026-09-12T10:01:00.900Z';
    await assertSucceeds(setDoc(resRefForwards, termForwards));

    // Case C: exact same instant — MUST PASS
    const resRefEqual = doc(alice, resultPath('ms-precision', 'mac-ms', 'cmd-ms-equal'));
    const termEqual = validTerm('ms-precision', 'mac-ms', 'cmd-ms-equal');
    termEqual.executedAt = '2026-09-12T10:01:00.500Z';
    termEqual.result.executedAt = '2026-09-12T10:01:00.500Z';
    termEqual.result.completedAt = '2026-09-12T10:01:00.500Z';
    await assertSucceeds(setDoc(resRefEqual, termEqual));
  });

});
