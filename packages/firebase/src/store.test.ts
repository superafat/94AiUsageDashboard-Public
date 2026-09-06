import { describe, expect, it } from 'vitest';
import { historyDocPath, usageDocPath, writeUsageHistory, writeUsageSnapshot } from './store';

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

});
