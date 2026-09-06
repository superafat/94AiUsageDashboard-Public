import type { DailyUsageAggregate, UsagePeriodAggregate } from '@94ai/core';

export interface ProviderHistoryInput {
  providerId: string;
  plan?: string;
  sourceFetchedAt?: string;
  periods: { today?: UsagePeriodAggregate; yesterday?: UsagePeriodAggregate; last30Days?: UsagePeriodAggregate };
  daily: DailyUsageAggregate[];
}

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
const HISTORY_URL = 'http://127.0.0.1:6736/v1/usage';
const MAX_RESPONSE_BYTES = 2_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateKeyBefore(now: Date, daysAgo: number): string {
  return localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 12));
}
function parseUsd(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^\s*\$([\d,]+(?:\.\d+)?)/.exec(value);
  if (!match) return undefined;
  const parsed = Number(match[1]!.replaceAll(',', ''));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function findLine(lines: unknown[], type: string, label: string): Record<string, unknown> | undefined {
  return lines.find((line) => isRecord(line) && line.type === type && line.label === label) as Record<string, unknown> | undefined;
}

function tokenTrend(lines: unknown[], now: Date): DailyUsageAggregate[] {
  const trend = findLine(lines, 'barChart', 'Usage Trend');
  if (!trend || !Array.isArray(trend.points)) return [];
  const values = trend.points.flatMap((point) => isRecord(point) && typeof point.value === 'number' && Number.isFinite(point.value) && point.value >= 0 ? [point.value] : []);
  const offset = Math.max(0, values.length - 35);
  return values.slice(offset).map((tokens, index, kept) => {
    const daysAgo = kept.length - 1 - index;
    return {
      date: dateKeyBefore(now, daysAgo),
      tokens,
      ...(tokens === 0 ? { estimatedCostUsd: 0 } : {}),
      finalized: daysAgo > 0,
    };
  });
}

function withPeriodCost(period: UsagePeriodAggregate | undefined, value: unknown): UsagePeriodAggregate | undefined {
  if (!period) return undefined;
  const estimatedCostUsd = parseUsd(value);
  return { ...period, ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }) };
}
export function normalizeLegacyUsageHistory(input: unknown, now: Date): ProviderHistoryInput[] {
  if (!Array.isArray(input)) throw new Error('invalid OpenUsage legacy usage payload');
  const result: ProviderHistoryInput[] = [];
  for (const provider of input) {
    if (!isRecord(provider) || typeof provider.providerId !== 'string' || !Array.isArray(provider.lines)) continue;
    const daily = tokenTrend(provider.lines, now);
    if (!daily.length) continue;
    const today = daily.at(-1);
    const yesterday = daily.at(-2);
    const last30 = daily.slice(-30);
    const todayLine = findLine(provider.lines, 'text', 'Today');
    const yesterdayLine = findLine(provider.lines, 'text', 'Yesterday');
    const last30Line = findLine(provider.lines, 'text', 'Last 30 Days');
    const periods = {
      ...(today ? { today: withPeriodCost({ tokens: today.tokens }, todayLine?.value)! } : {}),
      ...(yesterday ? { yesterday: withPeriodCost({ tokens: yesterday.tokens }, yesterdayLine?.value)! } : {}),
      ...(last30.length ? { last30Days: withPeriodCost({ tokens: last30.reduce((sum, item) => sum + item.tokens, 0) }, last30Line?.value)! } : {}),
    };
    const costToday = periods.today?.estimatedCostUsd;
    const costYesterday = periods.yesterday?.estimatedCostUsd;
    const enriched = daily.map((item) => item.date === today?.date && costToday !== undefined
      ? { ...item, estimatedCostUsd: costToday }
      : item.date === yesterday?.date && costYesterday !== undefined ? { ...item, estimatedCostUsd: costYesterday } : item);
    result.push({
      providerId: provider.providerId,
      ...(typeof provider.plan === 'string' ? { plan: provider.plan } : {}),
      ...(typeof provider.fetchedAt === 'string' ? { sourceFetchedAt: provider.fetchedAt } : {}),
      periods,
      daily: enriched,
    });
  }
  return result;
}
export async function readLegacyUsageHistory(fetcher: Fetcher = fetch, now = new Date()): Promise<ProviderHistoryInput[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetcher(HISTORY_URL, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`OpenUsage history request failed with HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error('OpenUsage history response too large');
    return normalizeLegacyUsageHistory(JSON.parse(text) as unknown, now);
  } finally {
    clearTimeout(timeout);
  }
}
