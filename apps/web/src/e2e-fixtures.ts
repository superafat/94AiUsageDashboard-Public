import type { AppClientServices } from '@94ai/client';
import { parseProviderPreference, parsePushSubscriptionRecord, resolveFamilyEnabled, type PushSubscriptionRecord, type ProviderPreference, type UsageHistorySnapshot, type UsageSnapshot } from '@94ai/core';
import { createBrowserConnectivity, createBrowserNavigation } from './platform';

const baseTime = '2026-09-05T10:00:05.000Z';

function snapshots(forceStale: boolean): UsageSnapshot[] {
  return [
    {
      schemaVersion: 1, userId: 'e2e-user', deviceId: 'e2e-device', providerId: 'codex', plan: 'Pro 20x',
      fetchedAt: '2026-09-05T10:00:00.000Z', syncedAt: baseTime, expiresAt: '2026-09-05T10:05:00.000Z', stale: forceStale,
      resources: {
        session: { kind: 'consumption', unit: 'percent', remaining: 51, resetsAt: '2026-09-05T15:06:00.000Z' },
        weekly: { kind: 'consumption', unit: 'percent', remaining: 48, resetsAt: '2026-09-07T11:06:00.000Z' },
        sparkWeekly: { kind: 'consumption', unit: 'percent', remaining: 94, resetsAt: '2026-09-12T05:53:06.000Z' },
        rateLimitResets: { kind: 'balance', unit: 'resets', available: 3, expiries: ['2026-09-21T00:00:02.128Z','2026-10-04T01:58:40.461Z','2026-10-05T04:18:44.901Z'] },
      },
    },
    {
      schemaVersion: 1, userId: 'e2e-user', deviceId: 'e2e-device', providerId: 'antigravity', plan: 'Ultra',
      fetchedAt: '2026-09-05T10:00:00.000Z', syncedAt: baseTime, expiresAt: '2026-09-05T10:05:00.000Z', stale: forceStale,
      resources: {
        geminiSession: { kind: 'consumption', unit: 'percent', remaining: 98 },
        geminiWeekly: { kind: 'consumption', unit: 'percent', remaining: 77 },
        nonGeminiSession: { kind: 'consumption', unit: 'percent', remaining: 100 },
        nonGeminiWeekly: { kind: 'consumption', unit: 'percent', remaining: 24 },
      },
    },
    {
      schemaVersion: 1, userId: 'e2e-user', deviceId: 'e2e-device', providerId: 'claude@personal', plan: 'Max',
      fetchedAt: '2026-09-05T10:00:00.000Z', syncedAt: baseTime, expiresAt: '2026-09-05T10:05:00.000Z', stale: forceStale,
      resources: {
        session: { kind: 'consumption', unit: 'percent', remaining: 63 },
        weekly: { kind: 'consumption', unit: 'percent', remaining: 42 },
        fable: { kind: 'consumption', unit: 'percent', remaining: 80 },
      },
    },
  ];
}


export function histories(dense180 = false): UsageHistorySnapshot[] {
  const totalDays = dense180 ? 180 : 31;
  const makeDaily = (scale: number, withCosts: boolean) => Array.from({ length: totalDays }, (_, index) => {
    const daysAgo = totalDays - 1 - index;
    const date = new Date(Date.UTC(2026, 8, 5 - daysAgo, 12));
    const tokens = (index + 1) * scale;
    return {
      date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
      tokens,
      ...(withCosts ? { estimatedCostUsd: Number((tokens / 1_000_000).toFixed(2)) } : {}),
      finalized: index < totalDays - 1,
    };
  });

  const codexDaily = makeDaily(1_000_000, true);
  const codexTodayTokens = codexDaily.at(-1)?.tokens ?? 0;
  const codexYesterdayTokens = codexDaily.at(-2)?.tokens ?? 0;
  const codexLast30Tokens = codexDaily.slice(-30).reduce((sum, item) => sum + item.tokens, 0);

  const agDaily = makeDaily(500_000, false);
  const agTodayTokens = agDaily.at(-1)?.tokens ?? 0;
  const agYesterdayTokens = agDaily.at(-2)?.tokens ?? 0;
  const agLast30Tokens = agDaily.slice(-30).reduce((sum, item) => sum + item.tokens, 0);

  return [
    {
      schemaVersion: 1, userId: 'e2e-user', deviceId: 'e2e-device', providerId: 'codex', syncedAt: baseTime, currency: 'USD',
      periods: {
        today: { tokens: codexTodayTokens, estimatedCostUsd: Number((codexTodayTokens / 1_000_000).toFixed(2)) },
        yesterday: { tokens: codexYesterdayTokens, estimatedCostUsd: Number((codexYesterdayTokens / 1_000_000).toFixed(2)) },
        last30Days: { tokens: codexLast30Tokens, estimatedCostUsd: Number((codexLast30Tokens / 1_000_000).toFixed(2)) },
      },
      daily: codexDaily,
    },
    {
      schemaVersion: 1, userId: 'e2e-user', deviceId: 'e2e-device', providerId: 'antigravity', syncedAt: baseTime, currency: 'USD',
      periods: {
        today: { tokens: agTodayTokens, estimatedCostUsd: 12 },
        yesterday: { tokens: agYesterdayTokens },
        last30Days: { tokens: agLast30Tokens, estimatedCostUsd: 192 },
      },
      daily: agDaily,
    },
  ];
}

export function createE2EServices(fixture: string | null): AppClientServices {
  // Synthetic browser acceptance state only; production uses the authenticated repository.
  const preferenceKey = 'e2e-provider-preferences';
  const listeners = new Set<(items: ProviderPreference[]) => void>();
  const readPreferences = (): ProviderPreference[] => {
    const value = sessionStorage.getItem(preferenceKey);
    return value ? (JSON.parse(value) as unknown[]).map(parseProviderPreference) : [];
  };
  const pushKey = 'e2e-push-subscription';
  const pushPublicKey = 'BFRdOgvw1mGS7riy-AmAm8sq3A3yTouaefCn1Nnv1YFJXopKLfRAzMX1AQGvq_xGiBUdoWCfuZjeOFq9lDn7aDo';
  const pushListeners = new Set<(items: PushSubscriptionRecord[]) => void>();
  const readPush = (): PushSubscriptionRecord | null => {
    const value = sessionStorage.getItem(pushKey);
    return value ? parsePushSubscriptionRecord(JSON.parse(value)) : null;
  };
  const updatePush = (row: PushSubscriptionRecord | null) => {
    if (row) sessionStorage.setItem(pushKey, JSON.stringify(row)); else sessionStorage.removeItem(pushKey);
    for (const notify of pushListeners) notify(row ? [row] : []);
  };
  return {
    backendProfile: { mode: 'self-hosted', label: 'E2E Firebase' },
    auth: {
      observe: (callback) => { queueMicrotask(() => callback({ uid: 'e2e-user', displayName: '測試帳號' })); return () => undefined; },
      signIn: async () => undefined,
      signOut: async () => undefined,
    },
    usage: { subscribe: (_uid, onValue) => { queueMicrotask(() => onValue(snapshots(fixture === 'stale'))); return () => undefined; } },
    history: { subscribe: (_uid, onValue) => { queueMicrotask(() => onValue(histories(fixture === 'dense180'))); return () => undefined; } },
    preferences: {
      subscribe: (_uid, onValue) => {
        listeners.add(onValue);
        queueMicrotask(() => { if (listeners.has(onValue)) onValue(readPreferences()); });
        return () => { listeners.delete(onValue); };
      },
      setPreference: async (uid, family, enabled) => {
        const previous = readPreferences();
        const current = previous.find((item) => item.family === family);
        const next = previous.filter((item) => item.family !== family);
        next.push(parseProviderPreference({...current, schemaVersion: 1, userId: uid, family, enabled, updatedAt: baseTime}));
        sessionStorage.setItem(preferenceKey, JSON.stringify(next));
        for (const notify of listeners) notify(next);
      },
      setNotificationPreference: async (uid, family, patch) => {
        const previous = readPreferences();
        const current = previous.find((item) => item.family === family);
        const next = previous.filter((item) => item.family !== family);
        const merged = { ...(current?.notifications ?? {}), ...patch };
        next.push(parseProviderPreference({
          ...current,
          schemaVersion: 1,
          userId: uid,
          family,
          enabled: current?.enabled ?? resolveFamilyEnabled(family, {}),
          updatedAt: baseTime,
          notifications: merged,
        }));
        sessionStorage.setItem(preferenceKey, JSON.stringify(next));
        for (const notify of listeners) notify(next);
      },
    },
    notifications: {
      getPermissionStatus: async () => sessionStorage.getItem('e2e-push-permission') === 'granted' ? 'granted' : 'default',
      requestPermission: async () => {sessionStorage.setItem('e2e-push-permission', 'granted'); return 'granted';},
      isSupported: () => true,
      subscribe: async (uid, producer) => {
        const row = parsePushSubscriptionRecord({schemaVersion: 1, userId: uid, browserId: 'e2e-browser', targetDeviceId: producer.deviceId,
          enrollmentEpoch: 1, applicationServerKey: producer.publicKey, endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-token',
          p256dh: pushPublicKey, auth: '8vyc8x-TXwGwYgjlAic24w', createdAt: baseTime, expiresAt: '2026-10-05T10:00:00.000Z'});
        updatePush(row); return row;
      },
      unsubscribe: async () => {updatePush(null);},
      getCurrentSubscription: async () => readPush(),
      requestTestPush: async () => {
        const row = readPush(); if (!row) throw new Error('Synthetic browser not enrolled');
        updatePush({...row, testRequestId: 'e2e-test-request', testRequestedAt: baseTime});
      },
      subscribeProducers: (_uid, onValue) => {
        let active = true;
        queueMicrotask(() => {if (active) onValue([{schemaVersion: 1, userId: 'e2e-user', deviceId: 'e2e-device', publicKey: pushPublicKey, updatedAt: baseTime}]);});
        return () => {active = false;};
      },
      subscribeSubscriptions: (_uid, onValue) => {
        pushListeners.add(onValue);
        queueMicrotask(() => {if (pushListeners.has(onValue)) {const row = readPush(); onValue(row ? [row] : []);}});
        return () => {pushListeners.delete(onValue);};
      },
    },
    connectivity: createBrowserConnectivity(),
    clock: { now: () => Date.parse('2026-09-05T10:00:10.000Z'), every: () => () => undefined },
    navigation: createBrowserNavigation(),
  };
}
