import { isValidCalendarDate, type DailyUsageAggregate, type UsagePeriodAggregate } from '@94ai/core';

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

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const MAX_BACKWARD_HISTORY_DAYS = 120;

function resolveHistoricalDate(
  month: number,
  day: number,
  refDate: Date,
  explicitYear?: number,
): string | undefined {
  if (explicitYear !== undefined) {
    if (!isValidCalendarDate(explicitYear, month, day)) return undefined;
    return `${explicitYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  const refYear = refDate.getFullYear();
  const refDateKey = localDateKey(refDate);

  if (isValidCalendarDate(refYear, month, day)) {
    const currentKey = `${refYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (currentKey <= refDateKey) {
      return currentKey;
    }
  }

  const prevYear = refYear - 1;
  if (isValidCalendarDate(prevYear, month, day)) {
    const prevKey = `${prevYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const refNoon = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate(), 12).getTime();
    const prevNoon = new Date(prevYear, month - 1, day, 12).getTime();
    const daysAgo = (refNoon - prevNoon) / (24 * 60 * 60 * 1000);
    if (daysAgo >= 0 && daysAgo <= MAX_BACKWARD_HISTORY_DAYS) {
      return prevKey;
    }
  }

  return undefined;
}

function parsePointDate(point: Record<string, unknown>, refDate: Date): string | undefined {
  if (typeof point.date === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(point.date);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      if (isValidCalendarDate(year, month, day)) {
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }
  }

  if (typeof point.label !== 'string') return undefined;
  const label = point.label.trim();

  // YYYY-MM-DD
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(label);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (isValidCalendarDate(year, month, day)) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return undefined;
  }

  // Chinese format: M月D日
  const zhMatch = /^(\d{1,2})月(\d{1,2})日?$/.exec(label);
  if (zhMatch) {
    const month = Number(zhMatch[1]);
    const day = Number(zhMatch[2]);
    return resolveHistoricalDate(month, day, refDate);
  }

  // English format: "Sep 5" or "5 Sep" with optional year
  const enMonthDayMatch = /^([a-zA-Z]+)[.\s]+(\d{1,2})(?:st|nd|rd|th)?(?:[,\s]+(\d{4}))?$/.exec(label);
  if (enMonthDayMatch) {
    const monthKey = enMonthDayMatch[1]!.toLowerCase();
    const month = MONTH_NAMES[monthKey];
    if (!month) return undefined;
    const day = Number(enMonthDayMatch[2]);
    const explicitYear = enMonthDayMatch[3] ? Number(enMonthDayMatch[3]) : undefined;
    return resolveHistoricalDate(month, day, refDate, explicitYear);
  }

  // English format: "5 Sep 2026"
  const enDayMonthMatch = /^(\d{1,2})[.\s]+([a-zA-Z]+)(?:[,\s]+(\d{4}))?$/.exec(label);
  if (enDayMonthMatch) {
    const monthKey = enDayMonthMatch[2]!.toLowerCase();
    const month = MONTH_NAMES[monthKey];
    if (!month) return undefined;
    const day = Number(enDayMonthMatch[1]);
    const explicitYear = enDayMonthMatch[3] ? Number(enDayMonthMatch[3]) : undefined;
    return resolveHistoricalDate(month, day, refDate, explicitYear);
  }

  // M/D format
  const slashMatch = /^(\d{1,2})\/(\d{1,2})$/.exec(label);
  if (slashMatch) {
    const month = Number(slashMatch[1]);
    const day = Number(slashMatch[2]);
    return resolveHistoricalDate(month, day, refDate);
  }

  return undefined;
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

function tokenTrend(lines: unknown[], refDate: Date, now: Date): DailyUsageAggregate[] {
  const trend = findLine(lines, 'barChart', 'Usage Trend');
  if (!trend || !Array.isArray(trend.points)) return [];
  const nowDateKey = localDateKey(now);
  const byDate = new Map<string, number>();

  for (const point of trend.points) {
    if (!isRecord(point) || typeof point.value !== 'number' || !Number.isFinite(point.value) || point.value < 0) continue;
    const dateKey = parsePointDate(point, refDate);
    if (!dateKey) continue;
    byDate.set(dateKey, point.value);
  }

  if (byDate.size === 0) return [];
  const sortedDates = [...byDate.keys()].sort().slice(-35);
  return sortedDates.map((date) => {
    const tokens = byDate.get(date)!;
    return {
      date,
      tokens,
      ...(tokens === 0 ? { estimatedCostUsd: 0 } : {}),
      finalized: date < nowDateKey,
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
  const nowDateKey = localDateKey(now);
  const yesterdayDateKey = dateKeyBefore(now, 1);

  for (const provider of input) {
    if (!isRecord(provider) || typeof provider.providerId !== 'string' || !Array.isArray(provider.lines)) continue;

    const sourceFetchedDate = typeof provider.fetchedAt === 'string' && Number.isFinite(Date.parse(provider.fetchedAt))
      ? new Date(provider.fetchedAt)
      : now;
    const sourceDateKey = localDateKey(sourceFetchedDate);
    const sourceYesterdayKey = dateKeyBefore(sourceFetchedDate, 1);

    const daily = tokenTrend(provider.lines, sourceFetchedDate, now);
    if (!daily.length) continue;

    const todayLine = findLine(provider.lines, 'text', 'Today');
    const yesterdayLine = findLine(provider.lines, 'text', 'Yesterday');
    const last30Line = findLine(provider.lines, 'text', 'Last 30 Days');

    const costFromTodayLine = parseUsd(todayLine?.value);
    const costFromYesterdayLine = parseUsd(yesterdayLine?.value);

    // Enriched daily attaches costs to the source's actual dates, not shifting to collector-now
    const enriched = daily.map((item) => {
      if (item.date === sourceDateKey && costFromTodayLine !== undefined) {
        return { ...item, estimatedCostUsd: costFromTodayLine };
      }
      if (item.date === sourceYesterdayKey && costFromYesterdayLine !== undefined) {
        return { ...item, estimatedCostUsd: costFromYesterdayLine };
      }
      return item;
    });

    const todayItem = enriched.find((item) => item.date === nowDateKey);
    const yesterdayItem = enriched.find((item) => item.date === yesterdayDateKey);
    const last30 = enriched.slice(-30);

    // Prevent stale source periods.today from being relabeled as collector-now
    const isSourceCurrent = sourceDateKey === nowDateKey;
    const periods = {
      ...(isSourceCurrent && todayItem ? { today: withPeriodCost({ tokens: todayItem.tokens }, todayLine?.value)! } : {}),
      ...(isSourceCurrent && yesterdayItem ? { yesterday: withPeriodCost({ tokens: yesterdayItem.tokens }, yesterdayLine?.value)! } : {}),
      ...(last30.length ? { last30Days: withPeriodCost({ tokens: last30.reduce((sum, item) => sum + item.tokens, 0) }, last30Line?.value)! } : {}),
    };

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
