import type { AppClientServices } from '@94ai/client';
import { parseProviderPreference, type ProviderPreference, type UsageHistorySnapshot, type UsageSnapshot } from '@94ai/core';
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


function histories(): UsageHistorySnapshot[] {
  const makeDaily = (scale: number, withCosts: boolean) => Array.from({ length: 31 }, (_, index) => {
    const date = new Date(2026, 7, 6 + index, 12);
    const tokens = (index + 1) * scale;
    return { date: `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`, tokens,
      ...(withCosts ? { estimatedCostUsd: Number((tokens / 1_000_000).toFixed(2)) } : {}), finalized: index < 30 };
  });
  return [
    { schemaVersion: 1, userId: 'e2e-user', deviceId: 'e2e-device', providerId: 'codex', syncedAt: baseTime, currency: 'USD',
      periods: { today: { tokens: 31_000_000, estimatedCostUsd: 31 }, yesterday: { tokens: 30_000_000, estimatedCostUsd: 30 }, last30Days: { tokens: 495_000_000, estimatedCostUsd: 495 } }, daily: makeDaily(1_000_000, true) },
    { schemaVersion: 1, userId: 'e2e-user', deviceId: 'e2e-device', providerId: 'antigravity', syncedAt: baseTime, currency: 'USD',
      periods: { today: { tokens: 15_500_000, estimatedCostUsd: 12 }, yesterday: { tokens: 15_000_000 }, last30Days: { tokens: 247_500_000, estimatedCostUsd: 192 } }, daily: makeDaily(500_000, false) },
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
  return {
    backendProfile: { mode: 'self-hosted', label: 'E2E Firebase' },
    auth: {
      observe: (callback) => { queueMicrotask(() => callback({ uid: 'e2e-user', displayName: '測試帳號' })); return () => undefined; },
      signIn: async () => undefined,
      signOut: async () => undefined,
    },
    usage: { subscribe: (_uid, onValue) => { queueMicrotask(() => onValue(snapshots(fixture === 'stale'))); return () => undefined; } },
    history: { subscribe: (_uid, onValue) => { queueMicrotask(() => onValue(histories())); return () => undefined; } },
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
    },
    connectivity: createBrowserConnectivity(),
    clock: { now: () => Date.parse('2026-09-05T10:00:10.000Z'), every: () => () => undefined },
    navigation: createBrowserNavigation(),
  };
}
