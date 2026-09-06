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
