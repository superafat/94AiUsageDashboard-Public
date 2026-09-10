import { describe, expect, it, vi } from 'vitest';
import { preferenceDocPath, historyDocPath, usageDocPath, subscribeProviderPreferences, writeProviderPreference, writeUsageHistory, writeUsageSnapshot } from './store';

const mockOnSnapshot = vi.fn();
const mockSetDoc = vi.fn();

vi.mock('firebase/firestore', async () => {
  const actual = await vi.importActual<typeof import('firebase/firestore')>('firebase/firestore');
  return {
    ...actual,
    collection: vi.fn(() => ({})),
    doc: vi.fn(() => ({})),
    onSnapshot: (...args: unknown[]) => mockOnSnapshot(...args),
    setDoc: (...args: unknown[]) => mockSetDoc(...args),
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
