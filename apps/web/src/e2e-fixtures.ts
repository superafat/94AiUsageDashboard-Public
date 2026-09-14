import type { AppClientServices, ResetCommandService, ResetPairingPin } from '@94ai/client';
import {
  parseProviderPreference,
  parsePushSubscriptionRecord,
  resolveFamilyEnabled,
  type PushSubscriptionRecord,
  type ProviderPreference,
  type PushProducerRecord,
  type ResetInventoryEnvelope,
  type ResetCreditItem,
  type UsageHistorySnapshot,
  type UsageSnapshot,
} from '@94ai/core';
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
    ...(fixture?.startsWith('reset-') ? { resetCommands: createE2EResetCommands(fixture, pushPublicKey) } : {}),
    connectivity: createBrowserConnectivity(),
    clock: { now: () => Date.parse('2026-09-05T10:00:10.000Z'), every: () => () => undefined },
    navigation: createBrowserNavigation(),
  };
}

function createE2EResetCommands(fixture: string, defaultPublicKey: string): ResetCommandService {
  const isMulti = fixture === 'reset-multi-device';
  const isUnverified = fixture === 'reset-unverified';
  const isUncertain = fixture === 'reset-uncertain';
  const isNoEffect = fixture === 'reset-no-effect';

  const producers: PushProducerRecord[] = isMulti
    ? [
        { schemaVersion: 1, userId: 'e2e-user', deviceId: 'mac-primary', publicKey: defaultPublicKey, updatedAt: baseTime },
        { schemaVersion: 1, userId: 'e2e-user', deviceId: 'mac-secondary', publicKey: defaultPublicKey, updatedAt: baseTime },
      ]
    : [
        { schemaVersion: 1, userId: 'e2e-user', deviceId: 'mac-test', publicKey: defaultPublicKey, updatedAt: baseTime },
      ];

  const pairingKey = (deviceId: string) => `e2e-reset-paired-${deviceId}`;

  const getPin = (uid: string, deviceId: string): ResetPairingPin | null => {
    if (isUnverified) {
      return { backendId: 'e2e-backend', userId: uid, deviceId, publicKey: defaultPublicKey, browserId: 'e2e-browser' };
    }
    const paired = sessionStorage.getItem(pairingKey(deviceId));
    if (!paired) return null;
    return { backendId: 'e2e-backend', userId: uid, deviceId, publicKey: defaultPublicKey, browserId: 'e2e-browser' };
  };

  return {
    subscribeProducers: (_uid, onValue) => {
      queueMicrotask(() => onValue(producers));
      return () => undefined;
    },
    getPairing: (uid, deviceId) => getPin(uid, deviceId),
    pair: (uid, producer) => {
      sessionStorage.setItem(pairingKey(producer.deviceId), '1');
      return { backendId: 'e2e-backend', userId: uid, deviceId: producer.deviceId, publicKey: producer.publicKey, browserId: 'e2e-browser' };
    },
    verifyInventory: async (uid, producer, envelope) => {
      const credit = envelope.inventory.credits?.[0];
      if (!credit) return { status: 'unavailable' };
      return {
        status: 'ready',
        pin: getPin(uid, producer.deviceId)!,
        producer,
        envelope,
        credit,
      };
    },
    subscribeInventory: (uid, producer, onValue) => {
      if (isUnverified) {
        queueMicrotask(() => onValue({ status: 'unverified' }));
        return () => undefined;
      }
      const pin = getPin(uid, producer.deviceId);
      if (!pin) {
        queueMicrotask(() => onValue({ status: 'unpaired' }));
        return () => undefined;
      }
      const credit: ResetCreditItem = {
        creditId: 'c1',
        expiresAt: '2026-10-05T10:00:00.000Z',
        status: 'available',
        resetType: 'codexRateLimits',
      };
      const envelope: ResetInventoryEnvelope = {
        version: 1,
        type: 'inventory',
        publicKey: producer.publicKey,
        signature: 'e2e-synthetic-signature-64bytes-base64url-filler-filler-filler-filler',
        inventory: {
          version: 1,
          backendId: 'e2e-backend',
          userId: uid,
          targetDeviceId: producer.deviceId,
          accountId: 'acc-e2e',
          observedAt: baseTime,
          expiresAt: '2026-10-05T10:00:00.000Z',
          availableCount: 1,
          credits: [credit],
        },
      };
      queueMicrotask(() => onValue({
        status: 'ready',
        pin,
        producer,
        envelope,
        credit,
      }));
      return () => undefined;
    },
    dispatch: async (value) => {
      if (value.status !== 'ready') throw new Error('inventory_not_ready');
      return {
        version: 1,
        browserId: 'e2e-browser',
        producerPublicKey: value.pin.publicKey,
        leaseExpiresAt: '2026-10-05T10:05:00.000Z',
        command: {
          version: 1,
          commandId: 'cmd-e2e',
          idempotencyKey: 'idem-e2e',
          creditId: value.credit.creditId,
          accountId: value.envelope.inventory.accountId,
          targetDeviceId: value.pin.deviceId,
          userId: value.pin.userId,
          backendId: value.pin.backendId,
          requestedAt: baseTime,
          expiresAt: '2026-10-05T10:05:00.000Z',
        },
      };
    },
    verifyReceipt: async (_uid, _producer, request, receipt) => ({
      status: receipt.type,
      request,
      receipt,
    }),
    watchResult: (uid, producer, request, onValue) => {
      let t1: ReturnType<typeof setTimeout> | undefined;
      let t2: ReturnType<typeof setTimeout> | undefined;

      if (isUncertain) {
        onValue({ status: 'waiting', request });
        t1 = setTimeout(() => {
          onValue({ status: 'uncertain', request });
        }, 150);
      } else if (isNoEffect) {
        onValue({ status: 'waiting', request });
        t1 = setTimeout(() => {
          onValue({
            status: 'executing',
            request,
            receipt: {
              version: 1,
              type: 'executing',
              publicKey: producer.publicKey,
              signature: 'e2e-synthetic-signature-64bytes-base64url-filler-filler-filler-filler',
              backendId: request.command.backendId,
              userId: uid,
              targetDeviceId: producer.deviceId,
              accountId: request.command.accountId,
              commandId: request.command.commandId,
              idempotencyKey: request.command.idempotencyKey,
              creditId: request.command.creditId,
              executedAt: baseTime,
            },
          });
        }, 200);
        t2 = setTimeout(() => {
          onValue({
            status: 'terminal',
            request,
            receipt: {
              version: 1,
              type: 'terminal',
              publicKey: producer.publicKey,
              signature: 'e2e-synthetic-signature-64bytes-base64url-filler-filler-filler-filler',
              backendId: request.command.backendId,
              userId: uid,
              targetDeviceId: producer.deviceId,
              accountId: request.command.accountId,
              commandId: request.command.commandId,
              idempotencyKey: request.command.idempotencyKey,
              creditId: request.command.creditId,
              executedAt: baseTime,
              result: {
                version: 1,
                commandId: request.command.commandId,
                idempotencyKey: request.command.idempotencyKey,
                creditId: request.command.creditId,
                accountId: request.command.accountId,
                targetDeviceId: producer.deviceId,
                userId: uid,
                backendId: request.command.backendId,
                state: 'success',
                code: 'nothingToReset',
                executedAt: baseTime,
                completedAt: baseTime,
              },
            },
          });
        }, 400);
      } else {
        // default / reset-ready
        onValue({ status: 'waiting', request });
        t1 = setTimeout(() => {
          onValue({
            status: 'executing',
            request,
            receipt: {
              version: 1,
              type: 'executing',
              publicKey: producer.publicKey,
              signature: 'e2e-synthetic-signature-64bytes-base64url-filler-filler-filler-filler',
              backendId: request.command.backendId,
              userId: uid,
              targetDeviceId: producer.deviceId,
              accountId: request.command.accountId,
              commandId: request.command.commandId,
              idempotencyKey: request.command.idempotencyKey,
              creditId: request.command.creditId,
              executedAt: baseTime,
            },
          });
        }, 200);
        t2 = setTimeout(() => {
          onValue({
            status: 'terminal',
            request,
            receipt: {
              version: 1,
              type: 'terminal',
              publicKey: producer.publicKey,
              signature: 'e2e-synthetic-signature-64bytes-base64url-filler-filler-filler-filler',
              backendId: request.command.backendId,
              userId: uid,
              targetDeviceId: producer.deviceId,
              accountId: request.command.accountId,
              commandId: request.command.commandId,
              idempotencyKey: request.command.idempotencyKey,
              creditId: request.command.creditId,
              executedAt: baseTime,
              result: {
                version: 1,
                commandId: request.command.commandId,
                idempotencyKey: request.command.idempotencyKey,
                creditId: request.command.creditId,
                accountId: request.command.accountId,
                targetDeviceId: producer.deviceId,
                userId: uid,
                backendId: request.command.backendId,
                state: 'success',
                code: 'reset',
                executedAt: baseTime,
                completedAt: baseTime,
              },
            },
          });
        }, 400);
      }

      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
      };
    },
  };
}
