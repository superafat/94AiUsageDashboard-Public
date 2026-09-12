import { describe, expect, it } from 'vitest';
import {
  parseUsageHistorySnapshot,
  summarizeHistory,
  toLocalDateKey,
  dateKeyToUtcOrdinal,
  shiftDateKey,
  isWithinCalendarWindow,
  type UsageHistorySnapshot,
} from './history';

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
  expect(() => parseUsageHistorySnapshot({ ...snapshot, daily: Array.from({ length: 36 }, (_, i) => ({ date: new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10), tokens: i, finalized: true })) })).not.toThrow();
  expect(() => parseUsageHistorySnapshot({ ...snapshot, accessToken: 'secret' })).toThrow(/unknown/i);
});


it('accepts up to 180 real daily rows and rejects 181 rows', () => {
  const dense180 = Array.from({ length: 180 }, (_, index) => {
    const d = new Date(Date.UTC(2026, 2, 14 + index));
    return { date: d.toISOString().slice(0, 10), tokens: (index + 1) * 100, finalized: true };
  });
  const valid180 = parseUsageHistorySnapshot({ ...snapshot, daily: dense180 });
  expect(valid180.daily).toHaveLength(180);

  const oversized181 = [
    ...dense180,
    { date: new Date(Date.UTC(2026, 2, 14 + 180)).toISOString().slice(0, 10), tokens: 999, finalized: false },
  ];
  expect(() => parseUsageHistorySnapshot({ ...snapshot, daily: oversized181 })).toThrow(/180/);
});

it('preserves sparse dates without fabricating missing dates', () => {
  const sparseDates = ['2026-03-20', '2026-05-10', '2026-07-04', '2026-08-15', '2026-09-10'];
  const sparseDaily = sparseDates.map((date, idx) => ({ date, tokens: (idx + 1) * 500, finalized: true }));
  const parsed = parseUsageHistorySnapshot({ ...snapshot, daily: sparseDaily });
  expect(parsed.daily).toHaveLength(5);
  expect(parsed.daily.map((d) => d.date)).toEqual(sparseDates);
});

it('summarizes 90d and 180d periods using real available rows only', () => {
  const days180 = Array.from({ length: 180 }, (_, index) => {
    const d = new Date(Date.UTC(2026, 2, 15 + index, 12));
    return {
      date: d.toISOString().slice(0, 10),
      tokens: 1000,
      estimatedCostUsd: 1,
      finalized: index < 179,
    };
  });
  const full180Snapshot: UsageHistorySnapshot = {
    ...snapshot,
    syncedAt: '2026-09-10T12:00:00.000Z',
    daily: days180,
  };
  const now = new Date('2026-09-10T12:00:00.000Z');
  const summary90 = summarizeHistory(full180Snapshot, '90d', now);
  expect(summary90.tokens).toBe(90 * 1000);
  expect(summary90.daysWithData).toBe(90);
  expect(summary90.estimatedCostUsd).toBe(90);
  expect(summary90.costComplete).toBe(true);

  const summary180 = summarizeHistory(full180Snapshot, '180d', now);
  expect(summary180.tokens).toBe(180 * 1000);
  expect(summary180.daysWithData).toBe(180);
  expect(summary180.estimatedCostUsd).toBe(180);
  expect(summary180.costComplete).toBe(true);
});

  it('summarizes 90d and 180d truthfully as incomplete cost when history is sparse or partial', () => {
    const partialSnapshot: UsageHistorySnapshot = {
      ...snapshot,
      daily: [
        { date: '2026-08-01', tokens: 5000, estimatedCostUsd: 5, finalized: true },
        { date: '2026-09-10', tokens: 2000, finalized: false },
      ],
    };
    const now = new Date('2026-09-10T12:00:00.000Z');
    const summary90 = summarizeHistory(partialSnapshot, '90d', now);
    expect(summary90.tokens).toBe(7000);
    expect(summary90.daysWithData).toBe(2);
    expect(summary90.costComplete).toBe(false);
    expect(summary90.estimatedCostUsd).toBeUndefined();
  });

  it('does not reuse stale period aggregates on the next local calendar day', () => {
    const staleSnapshot: UsageHistorySnapshot = {
      ...snapshot,
      syncedAt: '2026-09-05T10:00:00.000Z',
      periods: {
        today: { tokens: 999_000, estimatedCostUsd: 99 },
        last30Days: { tokens: 888_000, estimatedCostUsd: 88 },
      },
      daily: [
        { date: '2026-09-05', tokens: 10_000, estimatedCostUsd: 1, finalized: true },
      ],
    };
    const nextDay = new Date('2026-09-06T12:00:00.000Z');

    const today = summarizeHistory(staleSnapshot, '1d', nextDay);
    expect(today.tokens).toBe(0);
    expect(today.daysWithData).toBe(0);
    expect(today.estimatedCostUsd).toBeUndefined();
    expect(today.costComplete).toBe(false);

    const last30 = summarizeHistory(staleSnapshot, '30d', nextDay);
    expect(last30.tokens).toBe(10_000);
    expect(last30.daysWithData).toBe(1);
    expect(last30.estimatedCostUsd).toBeUndefined();
    expect(last30.costComplete).toBe(false);
  });

  it('keeps same-day period cost eligibility while 30d tokens come from actual daily rows', () => {
    const sameDaySnapshot: UsageHistorySnapshot = {
      ...snapshot,
      syncedAt: '2026-09-05T10:00:00.000Z',
      periods: {
        today: { tokens: 999_000, estimatedCostUsd: 99 },
        last30Days: { tokens: 888_000, estimatedCostUsd: 88 },
      },
      daily: [
        { date: '2026-09-04', tokens: 20_000, finalized: true },
        { date: '2026-09-05', tokens: 10_000, estimatedCostUsd: 1, finalized: false },
      ],
    };
    const sameDay = new Date('2026-09-05T12:00:00.000Z');

    const today = summarizeHistory(sameDaySnapshot, '1d', sameDay);
    expect(today.tokens).toBe(10_000);
    expect(today.estimatedCostUsd).toBe(99);
    expect(today.costComplete).toBe(true);

    const last30 = summarizeHistory(sameDaySnapshot, '30d', sameDay);
    expect(last30.tokens).toBe(30_000);
    expect(last30.estimatedCostUsd).toBe(88);
    expect(last30.costComplete).toBe(true);
  });

  it('computes canonical calendar day windows and ordinals independent of local DST', () => {
    expect(toLocalDateKey(new Date('2026-09-05T12:00:00Z'))).toBeDefined();
    expect(dateKeyToUtcOrdinal('2026-09-05')).toBeDefined();
    expect(toLocalDateKey('2026-09-06T02:00:00.000Z', 'America/New_York')).toBe('2026-09-05');
    expect(toLocalDateKey('2026-09-06T02:00:00.000Z', 'UTC')).toBe('2026-09-06');

    expect(shiftDateKey('2026-09-05', -179)).toBe('2026-03-10');
    expect(shiftDateKey('2026-09-05', -29)).toBe('2026-08-07');
    expect(shiftDateKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDateKey('2024-03-01', -1)).toBe('2024-02-29'); // Leap year

    // 180-day window ending on 2026-09-05: [2026-03-10, 2026-09-05]
    expect(isWithinCalendarWindow('2026-09-05', '2026-09-05', 180)).toBe(true);  // today
    expect(isWithinCalendarWindow('2026-03-10', '2026-09-05', 180)).toBe(true);  // exact 179 days ago
    expect(isWithinCalendarWindow('2026-03-09', '2026-09-05', 180)).toBe(false); // 180 days ago
    expect(isWithinCalendarWindow('2026-09-06', '2026-09-05', 180)).toBe(false); // future date
    expect(isWithinCalendarWindow('2020-01-01', '2026-09-05', 180)).toBe(false); // ancient date
    expect(isWithinCalendarWindow('invalid', '2026-09-05', 180)).toBe(false);

    // 30-day window ending on 2026-09-05: [2026-08-07, 2026-09-05]
    expect(isWithinCalendarWindow('2026-09-05', '2026-09-05', 30)).toBe(true);
    expect(isWithinCalendarWindow('2026-08-07', '2026-09-05', 30)).toBe(true);
    expect(isWithinCalendarWindow('2026-08-06', '2026-09-05', 30)).toBe(false);
  });
});
