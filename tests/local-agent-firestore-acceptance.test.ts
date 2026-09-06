import fs from 'node:fs';
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertFails, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collectionGroup, doc, getDoc, getDocs, query, setDoc, where } from 'firebase/firestore';
import { runSyncWithDependencies, serializeSafeSnapshot } from '../apps/agent/src/sync';
import { fetchOpenUsageLimits, readLegacyUsageHistory } from '@94ai/openusage';
import { healthDocPath, historyDocPath, usageDocPath } from '@94ai/firebase';

let env: RulesTestEnvironment;
let server: http.Server;
let baseUrl = '';

function openUsagePayload() {
  const now = Date.now();
  const fetchedAt = new Date(now - 30_000).toISOString();
  const expiresAt = new Date(now + 300_000).toISOString();
  return {
    schema: 'openusage.limits.v1',
    providers: {
      codex: { plan: 'Pro', fetchedAt, expiresAt, stale: false, resources: {
        weekly: { kind: 'consumption', unit: 'percent', used: 80, limit: 100, remaining: 20 },
        rateLimitResets: { kind: 'balance', unit: 'resets', available: 3, expiresAt: [expiresAt] },
      } },
      antigravity: { plan: 'Ultra', fetchedAt, expiresAt, stale: false, resources: {
        geminiSession: { kind: 'consumption', unit: 'percent', used: 4, limit: 100, remaining: 96 },
        geminiWeekly: { kind: 'consumption', unit: 'percent', used: 23, limit: 100, remaining: 77 },
      } },
      'claude@team-a': { plan: 'Max', fetchedAt, expiresAt, stale: false, resources: {
        session: { kind: 'consumption', unit: 'percent', used: 37, limit: 100, remaining: 63 },
        weekly: { kind: 'consumption', unit: 'percent', used: 58, limit: 100, remaining: 42 },
        fable: { kind: 'consumption', unit: 'percent', used: 20, limit: 100, remaining: 80 },
      } },
    },
    errors: [],
  };
}


function openUsageHistoryPayload() {
  return [{
    providerId: 'codex', plan: 'Pro', fetchedAt: new Date().toISOString(), lines: [
      { type: 'text', label: 'Today', value: '$1.25 · 100 tokens' },
      { type: 'text', label: 'Yesterday', value: '$0.50 · 50 tokens' },
      { type: 'text', label: 'Last 30 Days', value: '$9.00 · 900 tokens' },
      { type: 'barChart', label: 'Usage Trend', points: [
        { label: 'Sep 5', value: 50, valueLabel: '50 tokens' },
        { label: 'Sep 6', value: 100, valueLabel: '100 tokens' },
      ] },
    ],
  }];
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-94aiusage',
    firestore: { rules: fs.readFileSync('firestore.rules', 'utf8') },
  });
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/v1/usage' ? openUsageHistoryPayload() : openUsagePayload()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server failed to start');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await env.cleanup();
});

describe('v1 local agent + Firestore acceptance', () => {
  it('syncs three providers, isolates users, keeps last-good data, and rejects secrets', async () => {
    const aliceDb = env.authenticatedContext('agent-alice').firestore();
    const sync = () => runSyncWithDependencies({
      now: () => new Date(),
      getDeviceId: async () => 'device-acceptance',
      getAuthContext: async () => ({ uid: 'agent-alice', idToken: 'test-id-token', close: async () => undefined }),
      fetchLimits: () => fetchOpenUsageLimits({ baseUrl }),
      writeSnapshot: async (auth, snapshot) => {
        await setDoc(doc(aliceDb, usageDocPath(auth.uid, snapshot.deviceId, snapshot.providerId)), snapshot);
      },
    });

    const result = await sync();
    expect(result.providerCount).toBe(3);
    const ownerQuery = query(collectionGroup(aliceDb, 'providers'), where('userId', '==', 'agent-alice'));
    expect((await getDocs(ownerQuery)).size).toBe(3);

    const bobDb = env.authenticatedContext('bob').firestore();
    await assertFails(getDocs(query(collectionGroup(bobDb, 'providers'), where('userId', '==', 'agent-alice'))));

    await expect(runSyncWithDependencies({
      now: () => new Date(),
      getDeviceId: async () => 'device-acceptance',
      getAuthContext: async () => ({ uid: 'agent-alice', idToken: 'test-id-token', close: async () => undefined }),
      fetchLimits: () => fetchOpenUsageLimits({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 50 }),
      writeSnapshot: async (auth, snapshot) => {
        await setDoc(doc(aliceDb, usageDocPath(auth.uid, snapshot.deviceId, snapshot.providerId)), snapshot);
      },
    })).rejects.toThrow();
    expect((await getDocs(ownerQuery)).size).toBe(3);

    expect(() => serializeSafeSnapshot({ ...openUsagePayload(), access_token: 'secret-value' })).toThrow(/sensitive/i);
    await assertFails(setDoc(doc(aliceDb, 'users/agent-alice/devices/device-acceptance/providers/bad'), {
      schemaVersion: 1, userId: 'agent-alice', deviceId: 'device-acceptance', providerId: 'bad',
      fetchedAt: new Date().toISOString(), syncedAt: new Date().toISOString(), expiresAt: new Date().toISOString(),
      stale: false, resources: {}, access_token: 'secret-value',
    }));
  });

  it('syncs numeric history aggregates for the owner and denies another UID', async () => {
    const aliceDb = env.authenticatedContext('history-alice').firestore();
    const historyRef = doc(aliceDb, historyDocPath('history-alice', 'device-history', 'codex'));
    const result = await runSyncWithDependencies({
      now: () => new Date('2026-09-06T10:00:00.000Z'),
      getDeviceId: async () => 'device-history',
      getAuthContext: async () => ({ uid: 'history-alice', idToken: 'test-id-token', close: async () => undefined }),
      fetchLimits: () => fetchOpenUsageLimits({ baseUrl }),
      writeSnapshot: async (auth, snapshot) => setDoc(doc(aliceDb, usageDocPath(auth.uid, snapshot.deviceId, snapshot.providerId)), snapshot),
      fetchHistory: () => readLegacyUsageHistory((_, init) => fetch(`${baseUrl}/v1/usage`, init), new Date('2026-09-06T10:00:00.000Z')),
      readHistory: async () => undefined,
      writeHistory: async (_auth, history) => setDoc(historyRef, history),
    });
    expect(result.historyProviderCount).toBe(1);
    const saved = (await getDoc(historyRef)).data()!;
    expect(saved.periods.today).toEqual({ tokens: 100, estimatedCostUsd: 1.25 });
    expect(saved.daily).toHaveLength(2);
    expect(JSON.stringify(saved)).not.toMatch(/prompt|response|access[_-]?token|refresh[_-]?token/i);

    const bobDb = env.authenticatedContext('history-bob').firestore();
    await assertFails(getDoc(doc(bobDb, historyDocPath('history-alice', 'device-history', 'codex'))));
  });


  it('syncs minimal device health for the owner and denies another UID', async () => {
    const aliceDb = env.authenticatedContext('health-alice').firestore();
    const healthRef = doc(aliceDb, healthDocPath('health-alice', 'device-health'));
    const result = await runSyncWithDependencies({
      now: () => new Date('2026-09-06T10:00:00.000Z'),
      getDeviceId: async () => 'device-health',
      getAuthContext: async () => ({ uid: 'health-alice', idToken: 'test-id-token', close: async () => undefined }),
      fetchLimits: () => fetchOpenUsageLimits({ baseUrl }),
      writeSnapshot: async (auth, snapshot) => setDoc(doc(aliceDb, usageDocPath(auth.uid, snapshot.deviceId, snapshot.providerId)), snapshot),
      backgroundReady: async () => true,
      writeHealth: async (_auth, health) => setDoc(healthRef, health),
    });
    expect(result.providerCount).toBe(3);
    const saved = (await getDoc(healthRef)).data()!;
    expect(saved).toMatchObject({ engine: 'ready', background: 'ready', sync: 'ready', providerReadyCount: 3, providerWarningCount: 0 });
    expect(JSON.stringify(saved)).not.toMatch(/token|stderr|\/Users\//i);
    const bobDb = env.authenticatedContext('health-bob').firestore();
    await assertFails(getDoc(doc(bobDb, healthDocPath('health-alice', 'device-health'))));
  });

});
