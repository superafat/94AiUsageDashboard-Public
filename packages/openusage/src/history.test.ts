import { describe, expect, it } from 'vitest';
import { normalizeLegacyUsageHistory, readLegacyUsageHistory } from './history';

const fixture = [{
  providerId: 'codex', plan: 'Pro 20x', fetchedAt: '2026-09-06T01:00:00.000Z', lines: [
    { type: 'text', label: 'Today', value: '$17.65 · 23.8M tokens' },
    { type: 'text', label: 'Yesterday', value: '$2.89 · 992.7K tokens' },
    { type: 'text', label: 'Last 30 Days', value: '$17,395.39 · 30.7B tokens' },
    { type: 'barChart', label: 'Usage Trend', points: [
      { label: '9月4日', value: 784691779, valueLabel: '784.7M tokens' },
      { label: '9月5日', value: 992731, valueLabel: '992.7K tokens' },
      { label: '9月6日', value: 23756409, valueLabel: '23.8M tokens' },
    ] },
  ],
}];

describe('OpenUsage legacy history adapter', () => {
  it('keeps raw trend token values and parses documented USD summaries', () => {
    const history = normalizeLegacyUsageHistory(fixture, new Date('2026-09-06T12:00:00+08:00'))[0]!;
    expect(history.providerId).toBe('codex');
    expect(history.daily.map((item) => item.tokens)).toEqual([784691779, 992731, 23756409]);
    expect(history.periods.today?.estimatedCostUsd).toBe(17.65);
    expect(history.periods.yesterday?.estimatedCostUsd).toBe(2.89);
    expect(history.periods.last30Days?.estimatedCostUsd).toBe(17395.39);
  });

  it('maps chart position to calendar dates instead of localized labels', () => {
    const history = normalizeLegacyUsageHistory(fixture, new Date('2026-09-06T12:00:00+08:00'))[0]!;
    expect(history.daily.map((item) => item.date)).toEqual(['2026-09-04', '2026-09-05', '2026-09-06']);
    expect(history.daily.at(-1)?.finalized).toBe(false);
    expect(history.daily.at(-2)?.finalized).toBe(true);
  });

  it('omits malformed cost without losing healthy token history', () => {
    const broken = structuredClone(fixture);
    broken[0]!.lines[0] = { type: 'text', label: 'Today', value: 'cost unavailable' };
    const history = normalizeLegacyUsageHistory(broken, new Date('2026-09-06T12:00:00+08:00'))[0]!;
    expect(history.periods.today?.estimatedCostUsd).toBeUndefined();
    expect(history.periods.today?.tokens).toBe(23756409);
  });

  it('omits providers with no usable history instead of fabricating zeros', () => {
    expect(normalizeLegacyUsageHistory([{ providerId: 'copilot', lines: [] }], new Date())).toEqual([]);
  });

  it('preserves real calendar dates and date gaps without trend compression', () => {
    const withGaps = [{
      providerId: 'codex', plan: 'Pro 20x', fetchedAt: '2026-09-04T01:00:00.000Z', lines: [
        { type: 'text', label: 'Today', value: '$10.00 · 10M tokens' },
        { type: 'barChart', label: 'Usage Trend', points: [
          { label: '9月1日', value: 1000 },
          { label: '9月4日', value: 4000 },
        ] },
      ],
    }];
    const history = normalizeLegacyUsageHistory(withGaps, new Date('2026-09-04T12:00:00+08:00'))[0]!;
    expect(history.daily.map((item) => item.date)).toEqual(['2026-09-01', '2026-09-04']);
    expect(history.daily.map((item) => item.tokens)).toEqual([1000, 4000]);
  });

  it('ignores trend points with impossible or invalid calendar dates', () => {
    const invalidDates = [{
      providerId: 'codex', plan: 'Pro 20x', fetchedAt: '2026-09-06T01:00:00.000Z', lines: [
        { type: 'barChart', label: 'Usage Trend', points: [
          { label: '2月31日', value: 123 },
          { label: '9月31日', value: 456 },
          { label: '9月6日', value: 789 },
        ] },
      ],
    }];
    const history = normalizeLegacyUsageHistory(invalidDates, new Date('2026-09-06T12:00:00+08:00'))[0]!;
    expect(history.daily.map((item) => item.date)).toEqual(['2026-09-06']);
    expect(history.daily[0]?.tokens).toBe(789);
  });

  it('prevents stale source periods.today from being relabeled as the collector current day', () => {
    const staleSource = [{
      providerId: 'codex', plan: 'Pro 20x', fetchedAt: '2026-09-04T01:00:00.000Z', lines: [
        { type: 'text', label: 'Today', value: '$17.65 · 23.8M tokens' },
        { type: 'text', label: 'Yesterday', value: '$2.89 · 992.7K tokens' },
        { type: 'barChart', label: 'Usage Trend', points: [
          { label: '9月2日', value: 100000 },
          { label: '9月3日', value: 200000 },
          { label: '9月4日', value: 23800000 },
        ] },
      ],
    }];
    // Collector runs on 2026-09-06, but source was fetched on 2026-09-04
    const history = normalizeLegacyUsageHistory(staleSource, new Date('2026-09-06T12:00:00+08:00'))[0]!;
    // Dates must remain Sep 2, 3, 4, not shifted to Sep 4, 5, 6
    expect(history.daily.map((item) => item.date)).toEqual(['2026-09-02', '2026-09-03', '2026-09-04']);
    // All 3 days are in the past relative to 2026-09-06, so all are finalized
    expect(history.daily.every((item) => item.finalized)).toBe(true);
    // periods.today must NOT be populated because source has no data for 2026-09-06
    expect(history.periods.today).toBeUndefined();
    // The cost from source's Today line ($17.65) must be attached to the actual source date (2026-09-04)
    const sep4 = history.daily.find((item) => item.date === '2026-09-04');
    expect(sep4?.estimatedCostUsd).toBe(17.65);
  });

  it('resolves cross-year history points across year boundaries for February referencing Dec/Nov and Jan boundary', () => {
    const crossYearData = [{
      providerId: 'codex', plan: 'Pro 20x', fetchedAt: '2026-02-02T01:00:00.000Z', lines: [
        { type: 'text', label: 'Today', value: '$5.00 · 5M tokens' },
        { type: 'barChart', label: 'Usage Trend', points: [
          { label: '11月28日', value: 100 },
          { label: '12月30日', value: 200 },
          { label: '1月15日', value: 300 },
          { label: '2月2日', value: 400 },
        ] },
      ],
    }];
    const history = normalizeLegacyUsageHistory(crossYearData, new Date('2026-02-02T12:00:00+08:00'))[0]!;
    expect(history.daily.map((item) => item.date)).toEqual([
      '2025-11-28',
      '2025-12-30',
      '2026-01-15',
      '2026-02-02',
    ]);
  });

  it('handles cross-year history in English and slash formats without inventing future dates', () => {
    const crossYearFormats = [{
      providerId: 'codex', plan: 'Pro 20x', fetchedAt: '2026-02-02T01:00:00.000Z', lines: [
        { type: 'barChart', label: 'Usage Trend', points: [
          { label: 'Nov 28', value: 100 },
          { label: '12/30', value: 200 },
          { label: 'Jan 15', value: 300 },
          { label: '2/2', value: 400 },
          // Implausible future points that must NOT be invented
          { label: '2月15日', value: 500 },
          { label: 'May 20', value: 600 },
        ] },
      ],
    }];
    const history = normalizeLegacyUsageHistory(crossYearFormats, new Date('2026-02-02T12:00:00+08:00'))[0]!;
    expect(history.daily.map((item) => item.date)).toEqual([
      '2025-11-28',
      '2025-12-30',
      '2026-01-15',
      '2026-02-02',
    ]);
    expect(history.daily.some((item) => item.date.startsWith('2026-02-15') || item.date.startsWith('2026-05'))).toBe(false);
  });

  it('preserves previous-year points inside 180-day horizon and rejects points outside exact horizon', () => {
    const data = [{
      providerId: 'codex', plan: 'Pro 20x', fetchedAt: '2026-02-12T01:00:00.000Z', lines: [
        { type: 'text', label: 'Today', value: '$10.00 · 10M tokens' },
        { type: 'barChart', label: 'Usage Trend', points: [
          { label: '8月16日', value: 160 }, // 180 days ago relative to 2026-02-12 -> outside exact horizon (anchor + 179 days)
          { label: '8月17日', value: 170 }, // 179 days ago -> inside exact horizon boundary
          { label: '9月1日', value: 910 },  // 164 days ago -> inside 180-day horizon
          { label: '2月12日', value: 212 }, // anchor day
        ] },
      ],
    }];
    const history = normalizeLegacyUsageHistory(data, new Date('2026-02-12T12:00:00+08:00'))[0]!;
    expect(history.daily.map((item) => item.date)).toEqual([
      '2025-08-17',
      '2025-09-01',
      '2026-02-12',
    ]);
    expect(history.daily.some((item) => item.date === '2025-08-16')).toBe(false);
  });

  it('reads only the fixed loopback legacy endpoint', async () => {
    let requested = '';
    const fakeFetch = async (input: string | URL) => {
      requested = String(input);
      return new Response(JSON.stringify(fixture), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const result = await readLegacyUsageHistory(fakeFetch, new Date('2026-09-06T12:00:00+08:00'));
    expect(requested).toBe('http://127.0.0.1:6736/v1/usage');
    expect(result).toHaveLength(1);
  });

  it('rejects same-year stale labels older than 179 days (e.g. anchor 2026-12-31 and label 1月1日)', () => {
    const staleData = [{
      providerId: 'codex', plan: 'Pro 20x', fetchedAt: '2026-12-31T12:00:00.000Z', lines: [
        { type: 'text', label: 'Today', value: '$10.00 · 10M tokens' },
        { type: 'barChart', label: 'Usage Trend', points: [
          { label: '1月1日', value: 100 }, // 364 days ago -> must be rejected
          { label: '7月4日', value: 180 }, // 180 days ago -> must be rejected
          { label: '7月5日', value: 179 }, // 179 days ago -> exact boundary, must be retained
          { label: '12月31日', value: 200 }, // anchor day -> must be retained
        ] },
      ],
    }];
    const history = normalizeLegacyUsageHistory(staleData, new Date('2026-12-31T12:00:00.000Z'))[0]!;
    expect(history.daily.map((item) => item.date)).toEqual(['2026-07-05', '2026-12-31']);
    expect(history.daily.some((item) => item.date === '2026-01-01')).toBe(false);
    expect(history.daily.some((item) => item.date === '2026-07-04')).toBe(false);
  });

  it('rejects explicit old and future dates in point.date, ISO label, and explicit English year', () => {
    const mixedDates = [{
      providerId: 'codex', plan: 'Pro 20x', fetchedAt: '2026-09-06T12:00:00.000Z', lines: [
        { type: 'barChart', label: 'Usage Trend', points: [
          { date: '2020-01-01', value: 10 },
          { date: '2026-09-20', value: 20 },
          { label: '2020-01-01', value: 30 },
          { label: '2026-09-20', value: 40 },
          { label: '5 Sep 2020', value: 50 },
          { label: '5 Sep 2030', value: 60 },
          { date: '2026-09-04', value: 70 },
          { label: '2026-09-05', value: 80 },
          { label: '6 Sep 2026', value: 90 },
        ] },
      ],
    }];
    const history = normalizeLegacyUsageHistory(mixedDates, new Date('2026-09-06T12:00:00.000Z'))[0]!;
    expect(history.daily.map((item) => item.date)).toEqual(['2026-09-04', '2026-09-05', '2026-09-06']);
  });

  it('proves calendar ordinal window semantics independent of 23/25-hour DST day crossings', () => {
    // 2026-11-05 anchor in US DST fall-back period
    const dstData = [{
      providerId: 'codex', plan: 'Pro 20x', fetchedAt: '2026-11-05T12:00:00.000Z', lines: [
        { type: 'barChart', label: 'Usage Trend', points: [
          { label: '5月9日', value: 180 },  // 180 calendar days ago -> excluded
          { label: '5月10日', value: 179 }, // 179 calendar days ago -> exact boundary, retained
          { label: '11月5日', value: 500 }, // anchor day -> retained
        ] },
      ],
    }];
    const history = normalizeLegacyUsageHistory(dstData, new Date('2026-11-05T12:00:00.000Z'))[0]!;
    expect(history.daily.map((item) => item.date)).toEqual(['2026-05-10', '2026-11-05']);
    expect(history.daily.some((item) => item.date === '2026-05-09')).toBe(false);
  });

  it('sparse 180-day regression: excludes old rows outside 30 calendar days from last30Days while preserving provider cost and pairing with in-window tokens', () => {
    const sparse180 = [{
      providerId: 'codex', plan: 'Pro 20x', fetchedAt: '2026-09-05T12:00:00.000Z', lines: [
        { type: 'text', label: 'Today', value: '$10.00 · 10K tokens' },
        { type: 'text', label: 'Last 30 Days', value: '$50.00 · 50K tokens' },
        { type: 'barChart', label: 'Usage Trend', points: [
          { label: '4月1日', value: 40000 },  // 157 days ago -> outside 30 days, within 180 days
          { label: '8月5日', value: 30000 },  // 31 days ago (2026-08-05) -> outside 30 days [2026-08-07, 2026-09-05]
          { label: '8月10日', value: 20000 }, // 26 days ago (2026-08-10) -> inside 30 days
          { label: '9月5日', value: 10000 },  // anchor day (2026-09-05) -> inside 30 days
        ] },
      ],
    }];
    const history = normalizeLegacyUsageHistory(sparse180, new Date('2026-09-05T12:00:00.000Z'))[0]!;
    // All 4 rows are within 180 days
    expect(history.daily.map((item) => item.date)).toEqual(['2026-04-01', '2026-08-05', '2026-08-10', '2026-09-05']);
    // last30Days must count ONLY rows in [2026-08-07, 2026-09-05] -> 20000 + 10000 = 30000 tokens (NOT 100000!)
    expect(history.periods.last30Days?.tokens).toBe(30000);
    // Preserves provider-supplied Last 30 Days cost ($50.00) paired with truthful in-window tokens
    expect(history.periods.last30Days?.estimatedCostUsd).toBe(50.00);
    // Does not invent per-day costs for older rows
    expect(history.daily.find((d) => d.date === '2026-04-01')?.estimatedCostUsd).toBeUndefined();
    expect(history.daily.find((d) => d.date === '2026-08-05')?.estimatedCostUsd).toBeUndefined();
  });

  it('rejects provider fetchedAt later than collector now', () => {
    const futureSource = [{
      providerId: 'codex',
      plan: 'Pro 20x',
      fetchedAt: '2026-09-07T12:00:00.000Z',
      lines: [
        { type: 'text', label: 'Today', value: '$10.00 · 10M tokens' },
        { type: 'text', label: 'Last 30 Days', value: '$100.00 · 100M tokens' },
        { type: 'barChart', label: 'Usage Trend', points: [{ label: '9月7日', value: 10000000 }] },
      ],
    }];
    const now = new Date('2026-09-06T12:00:00.000Z');
    expect(normalizeLegacyUsageHistory(futureSource, now)).toEqual([]);
  });

  it('rejects source calendar dates outside collector 180-day window even if within stale source window', () => {
    // Collector now is 2026-09-06. 180-day collector window is [2026-03-11, 2026-09-06].
    // Stale source fetched on 2026-05-01 (128 days ago).
    // A point dated 2026-01-15 is within 180 days of 2026-05-01, but OUTSIDE collector 180-day window (234 days ago).
    const staleSource = [{
      providerId: 'codex',
      plan: 'Pro 20x',
      fetchedAt: '2026-05-01T12:00:00.000Z',
      lines: [
        { type: 'barChart', label: 'Usage Trend', points: [
          { date: '2026-01-15', value: 100 },
          { date: '2026-04-20', value: 200 },
        ] },
      ],
    }];
    const now = new Date('2026-09-06T12:00:00.000Z');
    const history = normalizeLegacyUsageHistory(staleSource, now);
    expect(history).toHaveLength(1);
    expect(history[0]!.daily.map((d) => d.date)).toEqual(['2026-04-20']);
  });

  it('computes last30Days tokens in collector [now-29, now] and only reuses last30Days cost when source local date equals collector local date', () => {
    // Collector now: 2026-09-06. Collector 30d window: [2026-08-08, 2026-09-06].
    // Stale source fetched on 2026-08-20 (17 days ago).
    // Points: 2026-07-25 (outside collector 30d, but inside source 30d [2026-07-22, 2026-08-20]),
    //         2026-08-15 (inside collector 30d and source 30d).
    const staleSource = [{
      providerId: 'codex',
      plan: 'Pro 20x',
      fetchedAt: '2026-08-20T12:00:00.000Z',
      lines: [
        { type: 'text', label: 'Last 30 Days', value: '$88.00 · 80M tokens' },
        { type: 'barChart', label: 'Usage Trend', points: [
          { date: '2026-07-25', value: 50000 },
          { date: '2026-08-15', value: 30000 },
        ] },
      ],
    }];
    const now = new Date('2026-09-06T12:00:00.000Z');
    const history = normalizeLegacyUsageHistory(staleSource, now)[0]!;
    // last30Days tokens must ONLY count collector [now-29, now], which includes only 2026-08-15 (30000)
    expect(history.periods.last30Days?.tokens).toBe(30000);
    // last30Days cost must NOT be reused because source local date (2026-08-20) !== collector local date (2026-09-06)
    expect(history.periods.last30Days?.estimatedCostUsd).toBeUndefined();
  });
});
