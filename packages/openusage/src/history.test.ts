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
          { label: 'Sep 20', value: 600 },
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
    expect(history.daily.some((item) => item.date.startsWith('2026-02-15') || item.date.startsWith('2026-09'))).toBe(false);
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
});
