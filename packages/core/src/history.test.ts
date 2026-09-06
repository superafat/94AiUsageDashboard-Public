import { describe, expect, it } from 'vitest';
import { parseUsageHistorySnapshot, summarizeHistory, type UsageHistorySnapshot } from './history';

const daily = Array.from({ length: 10 }, (_, index) => ({
  date: `2026-09-${String(index + 1).padStart(2, '0')}`,
  tokens: (index + 1) * 100,
  ...(index >= 4 ? { estimatedCostUsd: index + 0.5 } : {}),
  finalized: index < 9,
}));

const snapshot: UsageHistorySnapshot = {
  schemaVersion: 1, userId: 'u1', deviceId: 'd1', providerId: 'codex',
  syncedAt: '2026-09-10T04:00:00.000Z', currency: 'USD',
  periods: { last30Days: { tokens: 5500, estimatedCostUsd: 45.5 } }, daily,
};

describe('usage history', () => {
  it('does not fabricate a 7-day cost when daily coverage is incomplete', () => {
    const summary = summarizeHistory(snapshot, '7d', new Date('2026-09-10T12:00:00+08:00'));
    expect(summary.tokens).toBe(4900);
    expect(summary.estimatedCostUsd).toBeUndefined();
    expect(summary.costComplete).toBe(false);
  });

  it('sums exact seven-day cost when every day is known, including zero-cost days', () => {
    const complete = structuredClone(snapshot);
    complete.daily = complete.daily.map((item) => ({ ...item, estimatedCostUsd: item.estimatedCostUsd ?? 0 }));
    const summary = summarizeHistory(complete, '7d', new Date('2026-09-10T12:00:00+08:00'));
    expect(summary.estimatedCostUsd).toBeCloseTo(42);
    expect(summary.costComplete).toBe(true);
  });

it('uses the source 30-day cost while keeping raw daily token totals', () => {
  const summary = summarizeHistory(snapshot, '30d', new Date('2026-09-10T12:00:00+08:00'));
  expect(summary.tokens).toBe(5500);
  expect(summary.estimatedCostUsd).toBe(45.5);
  expect(summary.costComplete).toBe(true);
});

it('rejects duplicate dates, oversized history, and secret-shaped fields', () => {
  expect(() => parseUsageHistorySnapshot({ ...snapshot, daily: [...daily, daily[0]] })).toThrow(/duplicate/i);
  expect(() => parseUsageHistorySnapshot({ ...snapshot, daily: Array.from({ length: 36 }, (_, i) => ({ date: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`, tokens: i, finalized: true })) })).toThrow(/35/);
  expect(() => parseUsageHistorySnapshot({ ...snapshot, accessToken: 'secret' })).toThrow(/unknown/i);
});

});
