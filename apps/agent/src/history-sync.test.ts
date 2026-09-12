import { describe, expect, it } from 'vitest';
import { summarizeHistory, type UsageHistorySnapshot } from '@94ai/core';
import { normalizeLegacyUsageHistory, type ProviderHistoryInput } from '@94ai/openusage';
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

  it('retains a rolling 180-day calendar horizon without inventing missing days', () => {
    // Reference date: 2026-09-12T10:00:00.000Z
    // 180 calendar days horizon ending on 2026-09-12: 2026-03-17 to 2026-09-12 (exactly 180 calendar days)
    // 2026-03-17 is 179 days before 2026-09-12 (day 180 of the window -> kept)
    // 2026-03-16 is 180 days before 2026-09-12 (day 181 of the window -> pruned)
    const sparseAcrossYear: UsageHistorySnapshot = {
      ...previous,
      syncedAt: '2026-09-12T10:00:00.000Z',
      daily: [
        { date: '2026-03-16', tokens: 10, estimatedCostUsd: 0.1, finalized: true }, // 181st day -> pruned
        { date: '2026-03-17', tokens: 20, estimatedCostUsd: 0.2, finalized: true }, // 180th day (boundary) -> kept
        { date: '2026-05-01', tokens: 30, estimatedCostUsd: 0.3, finalized: true }, // sparse -> kept
        { date: '2026-07-20', tokens: 40, estimatedCostUsd: 0.4, finalized: true }, // sparse -> kept
        { date: '2026-09-11', tokens: 50, estimatedCostUsd: 0.5, finalized: true }, // yesterday -> kept
      ],
    };
    const next = buildHistorySnapshot({
      providerId: 'codex',
      periods: { today: { tokens: 60 } },
      daily: [{ date: '2026-09-12', tokens: 60, finalized: false }],
    }, { userId: 'alice', deviceId: 'device-1', syncedAt: '2026-09-12T10:00:00.000Z' });

    const merged = mergeHistory(sparseAcrossYear, next);
    // Boundary check:
    expect(merged.daily.find((d) => d.date === '2026-03-16')).toBeUndefined();
    expect(merged.daily.find((d) => d.date === '2026-03-17')).toBeDefined();
    // Sparse check: exactly 5 retained entries, no fabricated zero-fill days
    expect(merged.daily.map((d) => d.date)).toEqual([
      '2026-03-17', '2026-05-01', '2026-07-20', '2026-09-11', '2026-09-12'
    ]);
  });

  it('keeps up to 180 consecutive daily rows in rolling horizon', () => {
    const dates180 = Array.from({ length: 180 }, (_, index) => {
      const d = new Date(Date.UTC(2026, 2, 17 + index, 12));
      return {
        date: d.toISOString().slice(0, 10),
        tokens: index + 1,
        finalized: index < 179,
      };
    });
    const many180: UsageHistorySnapshot = {
      ...previous,
      syncedAt: '2026-09-12T10:00:00.000Z',
      daily: dates180,
    };
    const next = buildHistorySnapshot({
      providerId: 'codex',
      periods: {},
      daily: [{ date: '2026-09-12', tokens: 999, finalized: false }],
    }, { userId: 'alice', deviceId: 'device-1', syncedAt: '2026-09-12T10:00:00.000Z' });
    const merged = mergeHistory(many180, next);
    expect(merged.daily).toHaveLength(180);
    expect(merged.daily[0]!.date).toBe('2026-03-17');
    expect(merged.daily.at(-1)!.date).toBe('2026-09-12');
  });



  it('rejects merging across users, devices or providers', () => {
    const next = buildHistorySnapshot(incoming, { userId: 'alice', deviceId: 'device-1', syncedAt: '2026-09-06T10:00:00.000Z' });
    expect(() => mergeHistory({ ...previous, userId: 'bob' }, next)).toThrow(/identity/i);
    expect(() => mergeHistory({ ...previous, deviceId: 'device-2' }, next)).toThrow(/identity/i);
    expect(() => mergeHistory({ ...previous, providerId: 'claude' }, next)).toThrow(/identity/i);
  });

  it('filters first sync so future rows and rows older than 180 days are dropped', () => {
    const firstSyncInput: ProviderHistoryInput = {
      providerId: 'codex',
      periods: {},
      daily: [
        { date: '2026-03-09', tokens: 10, finalized: true },  // 180 days ago -> must be dropped
        { date: '2026-03-10', tokens: 20, finalized: true },  // 179 days ago -> exact boundary, kept
        { date: '2026-09-05', tokens: 30, finalized: false }, // anchor day -> kept
        { date: '2026-09-20', tokens: 40, finalized: false }, // future row -> must be dropped
      ],
    };
    const next = buildHistorySnapshot(firstSyncInput, { userId: 'alice', deviceId: 'device-1', syncedAt: '2026-09-05T12:00:00.000Z' });
    const merged = mergeHistory(undefined, next);
    expect(merged.daily.map((d) => d.date)).toEqual(['2026-03-10', '2026-09-05']);
  });

  it('never shifts retention anchor from observed daily rows and drops incoming future row', () => {
    const prior: UsageHistorySnapshot = {
      ...previous,
      syncedAt: '2026-09-04T10:00:00.000Z',
      daily: [
        { date: '2026-03-10', tokens: 20, estimatedCostUsd: 0.2, finalized: true }, // exact boundary for anchor 2026-09-05
        { date: '2026-09-04', tokens: 50, estimatedCostUsd: 0.5, finalized: true },
      ],
    };
    // Incoming contains an illegitimate future row 2026-09-20
    const next = buildHistorySnapshot({
      providerId: 'codex',
      periods: {},
      daily: [
        { date: '2026-09-05', tokens: 60, finalized: false },
        { date: '2026-09-20', tokens: 999, finalized: false },
      ],
    }, { userId: 'alice', deviceId: 'device-1', syncedAt: '2026-09-05T12:00:00.000Z' });

    const merged = mergeHistory(prior, next);
    // Future row must be dropped
    expect(merged.daily.find((d) => d.date === '2026-09-20')).toBeUndefined();
    // Boundary row 2026-03-10 must NOT be dropped due to anchor shift
    expect(merged.daily.map((d) => d.date)).toEqual(['2026-03-10', '2026-09-04', '2026-09-05']);
  });

  it('anchors on local calendar components of syncedAt instead of UTC date string slicing (regression for UTC-negative local evening)', () => {
    // 2026-09-06T02:30:00.000Z is 2026-09-05 22:30:00 in America/New_York (UTC-4)
    // UTC date is 2026-09-06, but local date is 2026-09-05!
    const next = buildHistorySnapshot({
      providerId: 'codex',
      periods: {},
      daily: [
        { date: '2026-03-09', tokens: 10, finalized: true },  // 180 days ago relative to 2026-09-05 -> dropped
        { date: '2026-03-10', tokens: 20, finalized: true },  // 179 days ago relative to 2026-09-05 -> kept
        { date: '2026-09-05', tokens: 30, finalized: false }, // local today -> kept
        { date: '2026-09-06', tokens: 40, finalized: false }, // local tomorrow (future) -> dropped
      ],
    }, { userId: 'alice', deviceId: 'device-1', syncedAt: '2026-09-06T02:30:00.000Z' });

    // When processed with America/New_York timezone
    const merged = mergeHistory(undefined, next, 'America/New_York');
    expect(merged.daily.map((d) => d.date)).toEqual(['2026-03-10', '2026-09-05']);
    expect(merged.daily.some((d) => d.date === '2026-09-06')).toBe(false);
    expect(merged.daily.some((d) => d.date === '2026-03-09')).toBe(false);
  });

  describe('normalize -> build/merge -> summarize 30d lifecycle', () => {
    const ctx = { userId: 'alice', deviceId: 'device-1', syncedAt: '2026-09-06T12:00:00.000Z' };
    const collectorNow = new Date('2026-09-06T12:00:00.000Z');

    it('rejects future source so no future or stale 30d cost leaks into snapshot summary', () => {
      const futurePayload = [{
        providerId: 'codex',
        plan: 'Pro 20x',
        fetchedAt: '2026-09-10T12:00:00.000Z',
        lines: [
          { type: 'text', label: 'Today', value: '$25.00 · 25M tokens' },
          { type: 'text', label: 'Last 30 Days', value: '$999.00 · 500M tokens' },
          { type: 'barChart', label: 'Usage Trend', points: [
            { date: '2026-09-10', value: 25_000_000 },
          ] },
        ],
      }];
      const normalized = normalizeLegacyUsageHistory(futurePayload, collectorNow);
      expect(normalized).toEqual([]);
    });

    it('rejects >179-day stale source so no ancient 30d cost leaks into snapshot summary', () => {
      // Collector now: 2026-09-06. 180-day collector window: [2026-03-11, 2026-09-06].
      // Source fetched on 2026-01-01 (248 days ago).
      const ancientPayload = [{
        providerId: 'codex',
        plan: 'Pro 20x',
        fetchedAt: '2026-01-01T12:00:00.000Z',
        lines: [
          { type: 'text', label: 'Today', value: '$10.00 · 10M tokens' },
          { type: 'text', label: 'Last 30 Days', value: '$450.00 · 200M tokens' },
          { type: 'barChart', label: 'Usage Trend', points: [
            { date: '2025-12-30', value: 5_000_000 },
            { date: '2026-01-01', value: 10_000_000 },
          ] },
        ],
      }];
      const normalized = normalizeLegacyUsageHistory(ancientPayload, collectorNow);
      // All rows are older than collector 180-day window, so normalized is empty
      expect(normalized).toEqual([]);
    });

    it('summarizes all merged prior-only and incoming rows instead of trusting incoming last30Days.tokens', () => {
      const prior: UsageHistorySnapshot = {
        schemaVersion: 1, userId: 'alice', deviceId: 'device-1', providerId: 'codex',
        syncedAt: '2026-09-05T12:00:00.000Z', currency: 'USD', periods: {},
        daily: [
          { date: '2026-08-20', tokens: 100_000, estimatedCostUsd: 1, finalized: true },
        ],
      };
      const payload = [{
        providerId: 'codex',
        fetchedAt: '2026-09-06T12:00:00.000Z',
        lines: [
          { type: 'text', label: 'Last 30 Days', value: '$5.00 · 500K tokens' },
          { type: 'barChart', label: 'Usage Trend', points: [
            { date: '2026-09-05', value: 200_000 },
            { date: '2026-09-06', value: 300_000 },
          ] },
        ],
      }];
      const normalized = normalizeLegacyUsageHistory(payload, collectorNow);
      expect(normalized).toHaveLength(1);
      expect(normalized[0]!.periods.last30Days?.tokens).toBe(500_000);

      const next = buildHistorySnapshot(normalized[0]!, ctx);
      const merged = mergeHistory(prior, next);
      expect(merged.daily.map((row) => row.date)).toEqual(['2026-08-20', '2026-09-05', '2026-09-06']);

      const summary = summarizeHistory(merged, '30d', collectorNow);
      expect(summary.tokens).toBe(600_000);
      expect(summary.daysWithData).toBe(3);
      expect(summary.estimatedCostUsd).toBe(5);
      expect(summary.costComplete).toBe(true);
    });

    it('preserves valid in-window daily tokens for stale-within-horizon source while proving no stale 30d cost leakage', () => {
      // Collector now: 2026-09-06. 30-day window: [2026-08-08, 2026-09-06].
      // Stale source fetched on 2026-08-25 (12 days ago, well within 180d horizon).
      const staleWithinHorizon = [{
        providerId: 'codex',
        plan: 'Pro 20x',
        fetchedAt: '2026-08-25T12:00:00.000Z',
        lines: [
          { type: 'text', label: 'Today', value: '$15.00 · 15M tokens' },
          { type: 'text', label: 'Last 30 Days', value: '$500.00 · 300M tokens' },
          { type: 'barChart', label: 'Usage Trend', points: [
            { date: '2026-08-01', value: 1_000_000 }, // outside collector 30d, within 180d
            { date: '2026-08-20', value: 2_000_000 }, // inside collector 30d
            { date: '2026-08-25', value: 3_000_000 }, // inside collector 30d
          ] },
        ],
      }];
      const normalized = normalizeLegacyUsageHistory(staleWithinHorizon, collectorNow);
      expect(normalized).toHaveLength(1);
      const input = normalized[0]!;

      // 1. normalize step:
      // tokens inside collector [now-29, now] = 2M + 3M = 5M tokens
      expect(input.periods.last30Days?.tokens).toBe(5_000_000);
      // cost must NOT leak
      expect(input.periods.last30Days?.estimatedCostUsd).toBeUndefined();
      expect(input.periods.today).toBeUndefined();
      expect(input.periods.yesterday).toBeUndefined();

      // 2. build / merge step:
      const snapshot = buildHistorySnapshot(input, ctx);
      expect(snapshot.periods.last30Days?.tokens).toBe(5_000_000);
      expect(snapshot.periods.last30Days?.estimatedCostUsd).toBeUndefined();

      // 3. summarize 30d step:
      const summary = summarizeHistory(snapshot, '30d', collectorNow);
      expect(summary.tokens).toBe(5_000_000);
      // Cost must be undefined (costComplete = false), absolutely NO stale $500 cost leakage!
      expect(summary.estimatedCostUsd).toBeUndefined();
      expect(summary.costComplete).toBe(false);
    });
  });
});
