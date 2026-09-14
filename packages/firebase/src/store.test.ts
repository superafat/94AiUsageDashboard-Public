import { describe, expect, it, vi } from 'vitest';
import {
  preferenceDocPath,
  historyDocPath,
  usageDocPath,
  subscribeProviderPreferences,
  updateNotificationPreferenceTransaction,
  writeProviderPreference,
  writeUsageHistory,
  writeUsageSnapshot,
  writeResetCommandRequest,
  subscribeResetInventory,
  subscribeResetResult,
} from './store';
import type {
  ResetCommandRequestRecord,
  ResetExecutingReceipt,
  ResetInventoryEnvelope,
} from '@94ai/core';

const mockOnSnapshot = vi.fn();
const mockSetDoc = vi.fn();
const mockRunTransaction = vi.fn();

vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<typeof import('firebase/firestore')>('firebase/firestore');
  return {
    ...actual,
    collection: vi.fn(() => ({})),
    doc: vi.fn(() => ({})),
    onSnapshot: (...args: unknown[]) => mockOnSnapshot(...args),
    setDoc: (...args: unknown[]) => mockSetDoc(...args),
    runTransaction: (...args: unknown[]) => mockRunTransaction(...args),
  };
});

const snapshot = {
  schemaVersion: 1 as const,
  userId: 'alice',
  deviceId: 'device-1',
  providerId: 'codex',
  fetchedAt: '2026-09-05T10:00:00.000Z',
  syncedAt: '2026-09-05T10:00:05.000Z',
  expiresAt: '2026-09-05T10:05:00.000Z',
  stale: false,
  resources: { session: { kind: 'consumption' as const, unit: 'percent', remaining: 51 } },
};

describe('Firebase usage store', () => {
  it('builds a stable per-user device/provider path', () => {
    expect(usageDocPath('alice', 'device-1', 'codex')).toBe('users/alice/devices/device-1/providers/codex');
    expect(() => usageDocPath('alice/bob', 'device-1', 'codex')).toThrow(/segment/i);
  });

  it('rejects writes where auth UID differs from snapshot UID before network access', async () => {
    await expect(writeUsageSnapshot({} as never, 'bob', snapshot)).rejects.toThrow(/uid/i);
  });

  it('builds a stable per-user device/provider history path', () => {
    expect(historyDocPath('alice', 'device-1', 'codex')).toBe('users/alice/devices/device-1/history/codex');
    expect(() => historyDocPath('alice', 'device/1', 'codex')).toThrow(/segment/i);
  });

  it('rejects history writes where auth UID differs before network access', async () => {
    const history = {
      schemaVersion: 1 as const,
      userId: 'alice', deviceId: 'device-1', providerId: 'codex',
      syncedAt: '2026-09-06T00:00:00.000Z', currency: 'USD' as const,
      periods: { today: { tokens: 100, estimatedCostUsd: 1 } },
      daily: [{ date: '2026-09-06', tokens: 100, estimatedCostUsd: 1, finalized: false }],
    };
    await expect(writeUsageHistory({} as never, 'bob', history)).rejects.toThrow(/uid/i);
  });

  it('builds a stable per-user preference path', () => {
    expect(preferenceDocPath('alice', 'cursor')).toBe('users/alice/preferences/cursor');
    expect(() => preferenceDocPath('alice/bob', 'cursor')).toThrow(/segment/i);
  });

  it('rejects preference writes where auth UID differs before network access', async () => {
    const pref = {
      schemaVersion: 1 as const,
      userId: 'alice',
      family: 'cursor',
      enabled: true,
      updatedAt: '2026-09-10T10:00:00.000Z',
    };
    await expect(writeProviderPreference({} as never, 'bob', pref)).rejects.toThrow(/uid/i);
  });

  it('subscribeProviderPreferences calls onError on malformed preference instead of swallowing into empty success', () => {
    let snapshotHandler: ((snapshot: unknown) => void) | undefined;
    const fakeDb = {} as never;

    const onValue = vi.fn();
    const onError = vi.fn();

    mockOnSnapshot.mockImplementation((_query: unknown, _options: unknown, onNext: unknown) => {
      snapshotHandler = onNext as (snapshot: unknown) => void;
      return () => undefined;
    });

    subscribeProviderPreferences(fakeDb, 'alice', onValue, onError);
    expect(snapshotHandler).toBeDefined();

    // Trigger with malformed document
    snapshotHandler!({
      size: 1,
      docs: [
        {
          id: 'codex',
          data: () => ({
            schemaVersion: 1,
            userId: 'alice',
            family: 'codex',
            enabled: 'false', // invalid string
            updatedAt: '2026-09-10T10:00:00.000Z',
          }),
        },
      ],
      forEach: (fn: (doc: unknown) => void) => {
        fn({
          id: 'codex',
          data: () => ({
            schemaVersion: 1,
            userId: 'alice',
            family: 'codex',
            enabled: 'false',
            updatedAt: '2026-09-10T10:00:00.000Z',
          }),
        });
      },
    });

    expect(onError).toHaveBeenCalled();
    expect(onValue).not.toHaveBeenCalled();
  });

  it('subscribeProviderPreferences suppresses late callbacks after unsubscribe', () => {
    let snapshotHandler: ((snapshot: unknown) => void) | undefined;
    const fakeDb = {} as never;
    const onValue = vi.fn();

    mockOnSnapshot.mockImplementation((_query: unknown, _options: unknown, onNext: unknown) => {
      snapshotHandler = onNext as (snapshot: unknown) => void;
      return () => undefined;
    });

    const unsub = subscribeProviderPreferences(fakeDb, 'alice', onValue);
    unsub();

    // Late callback arrives after unsubscribe
    snapshotHandler!({
      size: 0,
      docs: [],
      forEach: () => undefined,
    });

    expect(onValue).not.toHaveBeenCalled();
  });

  it('writeProviderPreference passes merge option to preserve notifications', async () => {
    const fakeDb = {} as never;
    let setDocOptions: unknown;
    mockSetDoc.mockImplementation(async (_ref: unknown, _data: unknown, options: unknown) => {
      setDocOptions = options;
    });

    await writeProviderPreference(fakeDb, 'alice', {
      schemaVersion: 1,
      userId: 'alice',
      family: 'codex',
      enabled: false,
      updatedAt: '2026-09-10T10:00:00.000Z',
    });
    expect(setDocOptions).toEqual({ merge: true });
  });

  it('updateNotificationPreferenceTransaction updates single flag while preserving existing counterpart and enabled', async () => {
    const fakeDb = {} as never;
    let savedData: unknown;
    let savedOptions: unknown;

    mockRunTransaction.mockImplementation(async (_db: unknown, updateFunction: (tx: unknown) => Promise<unknown>) => {
      const fakeTx = {
        get: vi.fn(async () => ({
          exists: () => true,
          data: () => ({
            schemaVersion: 1,
            userId: 'alice',
            family: 'codex',
            enabled: false,
            updatedAt: '2026-09-10T10:00:00.000Z',
            notifications: {
              lowQuota: true,
              reset: true,
            },
          }),
        })),
        set: vi.fn((_ref: unknown, data: unknown, options: unknown) => {
          savedData = data;
          savedOptions = options;
        }),
      };
      return updateFunction(fakeTx);
    });

    await updateNotificationPreferenceTransaction(fakeDb, 'alice', 'codex', { lowQuota: false });
    expect(savedOptions).toEqual({ merge: true });
    expect(savedData).toMatchObject({
      schemaVersion: 1,
      userId: 'alice',
      family: 'codex',
      enabled: false,
      notifications: {
        lowQuota: false,
        reset: true,
      },
    });
  });

  it('updateNotificationPreferenceTransaction applies default enabled when doc is absent', async () => {
    const fakeDb = {} as never;
    let savedData: unknown;

    mockRunTransaction.mockImplementation(async (_db: unknown, updateFunction: (tx: unknown) => Promise<unknown>) => {
      const fakeTx = {
        get: vi.fn(async () => ({
          exists: () => false,
          data: () => undefined,
        })),
        set: vi.fn((_ref: unknown, data: unknown) => {
          savedData = data;
        }),
      };
      return updateFunction(fakeTx);
    });

    await updateNotificationPreferenceTransaction(fakeDb, 'alice', 'codex', { reset: true });
    expect(savedData).toMatchObject({
      schemaVersion: 1,
      userId: 'alice',
      family: 'codex',
      enabled: true, // codex defaults to enabled
      notifications: {
        reset: true,
      },
    });
  });
});

it('waits for server-confirmed preferences instead of treating an empty cache as defaults', () => {
  const onValue = vi.fn();
  let handler!: (snapshot: unknown) => void;
  mockOnSnapshot.mockImplementation((_query: unknown, optionsOrNext: unknown, onNext: unknown) => {
    handler = (typeof optionsOrNext === 'function' ? optionsOrNext : onNext) as typeof handler;
    return () => undefined;
  });
  const stop = subscribeProviderPreferences({} as never, 'alice', onValue);
  handler({size: 0, docs: [], metadata: {fromCache: true, hasPendingWrites: false}});
  expect(onValue).not.toHaveBeenCalled();
  handler({size: 0, docs: [], metadata: {fromCache: false, hasPendingWrites: false}});
  expect(onValue).toHaveBeenCalledWith([]);
  expect(mockOnSnapshot.mock.calls.at(-1)?.[1]).toEqual({includeMetadataChanges: true});
  stop();
});

describe('Reset command Web SDK store operations', () => {
  const publicKey = btoa(String.fromCharCode(4, ...new Array(64).fill(0))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const signature = btoa(String.fromCharCode(...new Array(64).fill(1))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const testNow = Date.parse('2026-09-12T12:00:00.000Z');

  const sampleRequest: ResetCommandRequestRecord = {
    version: 1,
    browserId: 'browser-1',
    producerPublicKey: publicKey,
    leaseExpiresAt: '2026-09-12T12:09:00.000Z',
    command: {
      version: 1,
      backendId: 'codex',
      userId: 'alice',
      targetDeviceId: 'mac-1',
      accountId: 'acc-1',
      commandId: 'cmd-1',
      idempotencyKey: 'idem-cmd-1',
      creditId: 'credit-1',
      requestedAt: '2026-09-12T11:59:00.000Z',
      expiresAt: '2026-09-12T12:09:00.000Z',
    },
  };

  const sampleInventory: ResetInventoryEnvelope = {
    version: 1,
    type: 'inventory',
    publicKey,
    signature,
    inventory: {
      version: 1,
      backendId: 'codex',
      userId: 'alice',
      targetDeviceId: 'mac-1',
      accountId: 'acc-1',
      observedAt: '2026-09-12T11:58:00.000Z',
      expiresAt: '2026-09-12T12:03:00.000Z',
      availableCount: 1,
      credits: [{ creditId: 'credit-1', expiresAt: null, status: 'available', resetType: 'codexRateLimits' }],
    },
  };

  const cloudInventory = (value: ResetInventoryEnvelope) => ({
    ...value,
    observedAtTimestamp: new Date(value.inventory.observedAt),
    expiresAtTimestamp: new Date(value.inventory.expiresAt),
  });

  const sampleReceipt: ResetExecutingReceipt = {
    version: 1,
    type: 'executing',
    publicKey,
    signature,
    backendId: 'codex',
    userId: 'alice',
    targetDeviceId: 'mac-1',
    accountId: 'acc-1',
    commandId: 'cmd-1',
    idempotencyKey: 'idem-cmd-1',
    creditId: 'credit-1',
    executedAt: '2026-09-12T12:00:05.000Z',
  };

  it('rejects writeResetCommandRequest if auth UID does not match', async () => {
    await expect(writeResetCommandRequest({} as never, 'bob', sampleRequest, testNow)).rejects.toThrow(/uid/i);
  });

  it('atomically writes fixed request slot when empty', async () => {
    let savedRequest: unknown;
    mockRunTransaction.mockImplementation(async (_db: unknown, updateFn: (tx: unknown) => Promise<void>) => {
      const fakeTx = {
        get: vi.fn().mockResolvedValue({ exists: () => false }),
        set: vi.fn((_ref: unknown, data: unknown) => {
          savedRequest = data;
        }),
      };
      await updateFn(fakeTx);
    });

    await writeResetCommandRequest({} as never, 'alice', sampleRequest, testNow);
    expect(savedRequest).toMatchObject(sampleRequest);
    expect((savedRequest as { requestedAtTimestamp: Date }).requestedAtTimestamp.toISOString()).toBe(sampleRequest.command.requestedAt);
    expect((savedRequest as { leaseExpiresAtTimestamp: Date }).leaseExpiresAtTimestamp.toISOString()).toBe(sampleRequest.leaseExpiresAt);
  });

  it('rejects writeResetCommandRequest when an active lease exists and no prior result exists', async () => {
    mockRunTransaction.mockImplementation(async (_db: unknown, updateFn: (tx: unknown) => Promise<void>) => {
      const fakeTx = {
        get: vi.fn().mockImplementation(() => {
          // request doc exists with future lease, result does not exist
          return Promise.resolve({
            exists: () => false,
            data: () => ({
              leaseExpiresAt: '2026-09-12T12:09:00.000Z',
              command: { commandId: 'cmd-existing', expiresAt: '2026-09-12T12:09:00.000Z' },
            }),
          });
        }),
        set: vi.fn(),
      };
      // For the first call (requestRef), return exists = true
      fakeTx.get = vi.fn()
        .mockResolvedValueOnce({
          exists: () => true,
          data: () => ({
            leaseExpiresAt: '2026-09-12T12:09:00.000Z',
            command: { commandId: 'cmd-existing', expiresAt: '2026-09-12T12:09:00.000Z' },
          }),
        })
        .mockResolvedValueOnce({
          exists: () => false, // result doc does not exist
        });
      await updateFn(fakeTx);
    });

    await expect(writeResetCommandRequest({} as never, 'alice', sampleRequest, testNow)).rejects.toThrow(/lease_active/i);
  });

  it('allows writeResetCommandRequest when prior result exists', async () => {
    let savedRequest: unknown;
    mockRunTransaction.mockImplementation(async (_db: unknown, updateFn: (tx: unknown) => Promise<void>) => {
      const fakeTx = {
        get: vi.fn()
          .mockResolvedValueOnce({
            exists: () => true,
            data: () => ({
              leaseExpiresAt: '2026-09-12T12:09:00.000Z',
              command: { commandId: 'cmd-prior', expiresAt: '2026-09-12T12:09:00.000Z' },
            }),
          })
          .mockResolvedValueOnce({
            exists: () => true, // result doc exists!
          }),
        set: vi.fn((_ref: unknown, data: unknown) => {
          savedRequest = data;
        }),
      };
      await updateFn(fakeTx);
    });

    await writeResetCommandRequest({} as never, 'alice', sampleRequest, testNow);
    expect(savedRequest).toMatchObject(sampleRequest);
    expect((savedRequest as { leaseExpiresAtTimestamp: Date }).leaseExpiresAtTimestamp.toISOString()).toBe(sampleRequest.leaseExpiresAt);
  });

  it('subscribeResetInventory ignores cache/pending writes and emits server-confirmed envelope', () => {
    const onValue = vi.fn();
    const onError = vi.fn();
    let handler!: (snapshot: unknown) => void;
    mockOnSnapshot.mockImplementation((_ref: unknown, _opts: unknown, onNext: unknown) => {
      handler = onNext as typeof handler;
      return () => undefined;
    });

    const stop = subscribeResetInventory({} as never, 'alice', 'mac-1', onValue, onError, testNow);

    // Suppress cache
    handler({ exists: () => true, data: () => cloudInventory(sampleInventory), metadata: { fromCache: true, hasPendingWrites: false } });
    expect(onValue).not.toHaveBeenCalled();

    // Suppress pending writes
    handler({ exists: () => true, data: () => cloudInventory(sampleInventory), metadata: { fromCache: false, hasPendingWrites: true } });
    expect(onValue).not.toHaveBeenCalled();

    // Server-confirmed
    handler({ exists: () => true, data: () => cloudInventory(sampleInventory), metadata: { fromCache: false, hasPendingWrites: false } });
    expect(onValue).toHaveBeenCalledWith(sampleInventory);

    // Document missing emits undefined
    handler({ exists: () => false, data: () => undefined, metadata: { fromCache: false, hasPendingWrites: false } });
    expect(onValue).toHaveBeenCalledWith(undefined);

    stop();
  });

  it('subscribeResetInventory rejects a server snapshot whose timestamp shadow disagrees with the signed ISO value', () => {
    const onValue = vi.fn();
    const onError = vi.fn();
    let handler!: (snapshot: unknown) => void;
    mockOnSnapshot.mockImplementation((_ref: unknown, _opts: unknown, onNext: unknown) => {
      handler = onNext as typeof handler;
      return () => undefined;
    });
    const stop = subscribeResetInventory({} as never, 'alice', 'mac-1', onValue, onError, testNow);
    handler({
      exists: () => true,
      data: () => ({ ...cloudInventory(sampleInventory), observedAtTimestamp: new Date('2026-09-12T11:57:00.000Z') }),
      metadata: { fromCache: false, hasPendingWrites: false },
    });
    expect(onValue).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'reset_inventory_timestamp_shadow_mismatch' }));
    stop();
  });

  it('subscribeResetInventory evaluates freshness against the callback-time clock, not subscription-time', () => {
    const onValue = vi.fn();
    const onError = vi.fn();
    let handler!: (snapshot: unknown) => void;
    let clock = testNow;
    mockOnSnapshot.mockImplementation((_ref: unknown, _opts: unknown, onNext: unknown) => {
      handler = onNext as typeof handler;
      return () => undefined;
    });

    const stop = subscribeResetInventory({} as never, 'alice', 'mac-1', onValue, onError, () => clock);
    clock += 2 * 60_000;
    const freshLater = {
      ...sampleInventory,
      inventory: {
        ...sampleInventory.inventory,
        observedAt: new Date(clock - 30_000).toISOString(),
        expiresAt: new Date(clock + 4 * 60_000).toISOString(),
      },
    };
    handler({ exists: () => true, data: () => cloudInventory(freshLater), metadata: { fromCache: false, hasPendingWrites: false } });
    expect(onError).not.toHaveBeenCalled();
    expect(onValue).toHaveBeenCalledWith(freshLater);
    stop();
  });

  it('subscribeResetResult ignores cache/pending writes and emits server-confirmed receipt', () => {
    const onValue = vi.fn();
    const onError = vi.fn();
    let handler!: (snapshot: unknown) => void;
    mockOnSnapshot.mockImplementation((_ref: unknown, _opts: unknown, onNext: unknown) => {
      handler = onNext as typeof handler;
      return () => undefined;
    });

    const stop = subscribeResetResult({} as never, 'alice', 'mac-1', 'cmd-1', onValue, onError);

    // Suppress cache
    handler({ exists: () => true, data: () => sampleReceipt, metadata: { fromCache: true, hasPendingWrites: false } });
    expect(onValue).not.toHaveBeenCalled();

    // Server-confirmed
    handler({ exists: () => true, data: () => sampleReceipt, metadata: { fromCache: false, hasPendingWrites: false } });
    expect(onValue).toHaveBeenCalledWith(sampleReceipt);

    // Document missing emits undefined
    handler({ exists: () => false, data: () => undefined, metadata: { fromCache: false, hasPendingWrites: false } });
    expect(onValue).toHaveBeenCalledWith(undefined);

    stop();
  });
});
