import { describe, expect, it } from 'vitest';
import type { UsageHistorySnapshot } from '@94ai/core';
import type { ProviderHistoryInput } from '@94ai/openusage';
import { buildHistorySnapshot, mergeHistory } from './history-sync';

const previous: UsageHistorySnapshot = {
  schemaVersion: 1, userId: 'alice', deviceId: 'device-1', providerId: 'codex',
  syncedAt: '2026-09-05T10:00:00.000Z', currency: 'USD',
  periods: { yesterday: { tokens: 100, estimatedCostUsd: 1.25 } },
  daily: [
    { date: '2026-09-04', tokens: 50, estimatedCostUsd: 0.5, finalized: true },
    { date: '2026-09-05', tokens: 100, estimatedCostUsd: 1.25, finalized: true },
  ],
};

const incoming: ProviderHistoryInput = {
  providerId: 'codex',
  periods: { today: { tokens: 200, estimatedCostUsd: 2.5 }, yesterday: { tokens: 120 }, last30Days: { tokens: 370, estimatedCostUsd: 9 } },
  daily: [
    { date: '2026-09-05', tokens: 120, finalized: true },
    { date: '2026-09-06', tokens: 200, estimatedCostUsd: 2.5, finalized: false },
  ],
};

describe('history sync merge', () => {
  it('uses fresh tokens while preserving last-good daily cost coverage', () => {
    const next = buildHistorySnapshot(incoming, { userId: 'alice', deviceId: 'device-1', syncedAt: '2026-09-06T10:00:00.000Z' });
    const merged = mergeHistory(previous, next);
    expect(merged.daily.find((item) => item.date === '2026-09-05')).toMatchObject({ tokens: 120, estimatedCostUsd: 1.25, finalized: true });
    expect(merged.daily.find((item) => item.date === '2026-09-06')).toMatchObject({ tokens: 200, estimatedCostUsd: 2.5, finalized: false });
  });

  it('keeps at most the newest 35 local dates', () => {
    const many: UsageHistorySnapshot = {
      ...previous,
      daily: Array.from({ length: 36 }, (_, index) => ({
        date: `2026-${String(Math.floor(index / 28) + 7).padStart(2, '0')}-${String((index % 28) + 1).padStart(2, '0')}`,
        tokens: index,
        estimatedCostUsd: index,
        finalized: true,
      })),
    };
    const merged = mergeHistory(many, buildHistorySnapshot(incoming, { userId: 'alice', deviceId: 'device-1', syncedAt: '2026-09-06T10:00:00.000Z' }));
    expect(merged.daily).toHaveLength(35);
    expect(merged.daily[0]!.date < merged.daily.at(-1)!.date).toBe(true);
  });

  it('rejects merging across users, devices or providers', () => {
    const next = buildHistorySnapshot(incoming, { userId: 'alice', deviceId: 'device-1', syncedAt: '2026-09-06T10:00:00.000Z' });
    expect(() => mergeHistory({ ...previous, userId: 'bob' }, next)).toThrow(/identity/i);
    expect(() => mergeHistory({ ...previous, deviceId: 'device-2' }, next)).toThrow(/identity/i);
    expect(() => mergeHistory({ ...previous, providerId: 'claude' }, next)).toThrow(/identity/i);
  });
});
