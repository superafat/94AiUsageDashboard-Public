import {
  isValidCalendarDate,
  HISTORY_HORIZON_DAYS,
  toLocalDateKey,
  shiftDateKey,
  isWithinCalendarWindow,
  type DailyUsageAggregate,
  type UsagePeriodAggregate,
} from '@94ai/core';

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

function resolveHistoricalDate(
  month: number,
  day: number,
  refDate: Date,
  collectorNowDateKey: string,
  explicitYear?: number,
): string | undefined {
  const sourceAnchorKey = toLocalDateKey(refDate);

  if (explicitYear !== undefined) {
    if (!isValidCalendarDate(explicitYear, month, day)) return undefined;
    const explicitKey = `${explicitYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (explicitKey > sourceAnchorKey) return undefined;
    return isWithinCalendarWindow(explicitKey, collectorNowDateKey, HISTORY_HORIZON_DAYS) ? explicitKey : undefined;
  }

  const refYear = refDate.getFullYear();

  if (isValidCalendarDate(refYear, month, day)) {
    const currentKey = `${refYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (currentKey <= sourceAnchorKey && isWithinCalendarWindow(currentKey, collectorNowDateKey, HISTORY_HORIZON_DAYS)) {
      return currentKey;
    }
  }

  const prevYear = refYear - 1;
  if (isValidCalendarDate(prevYear, month, day)) {
    const prevKey = `${prevYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (prevKey <= sourceAnchorKey && isWithinCalendarWindow(prevKey, collectorNowDateKey, HISTORY_HORIZON_DAYS)) {
      return prevKey;
    }
  }

  return undefined;
}

function parsePointDate(point: Record<string, unknown>, refDate: Date, collectorNowDateKey: string): string | undefined {
  const sourceAnchorKey = toLocalDateKey(refDate);

  if (typeof point.date === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(point.date);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      if (isValidCalendarDate(year, month, day)) {
        const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (key > sourceAnchorKey) return undefined;
        return isWithinCalendarWindow(key, collectorNowDateKey, HISTORY_HORIZON_DAYS) ? key : undefined;
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
      const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (key > sourceAnchorKey) return undefined;
      return isWithinCalendarWindow(key, collectorNowDateKey, HISTORY_HORIZON_DAYS) ? key : undefined;
    }
    return undefined;
  }

  // Chinese format: M月D日
  const zhMatch = /^(\d{1,2})月(\d{1,2})日?$/.exec(label);
  if (zhMatch) {
    const month = Number(zhMatch[1]);
    const day = Number(zhMatch[2]);
    return resolveHistoricalDate(month, day, refDate, collectorNowDateKey);
  }

  // English format: "Sep 5" or "5 Sep" with optional year
  const enMonthDayMatch = /^([a-zA-Z]+)[.\s]+(\d{1,2})(?:st|nd|rd|th)?(?:[,\s]+(\d{4}))?$/.exec(label);
  if (enMonthDayMatch) {
    const monthKey = enMonthDayMatch[1]!.toLowerCase();
    const month = MONTH_NAMES[monthKey];
    if (!month) return undefined;
    const day = Number(enMonthDayMatch[2]);
    const explicitYear = enMonthDayMatch[3] ? Number(enMonthDayMatch[3]) : undefined;
    return resolveHistoricalDate(month, day, refDate, collectorNowDateKey, explicitYear);
  }

  // English format: "5 Sep 2026"
  const enDayMonthMatch = /^(\d{1,2})[.\s]+([a-zA-Z]+)(?:[,\s]+(\d{4}))?$/.exec(label);
  if (enDayMonthMatch) {
    const monthKey = enDayMonthMatch[2]!.toLowerCase();
    const month = MONTH_NAMES[monthKey];
    if (!month) return undefined;
    const day = Number(enDayMonthMatch[1]);
    const explicitYear = enDayMonthMatch[3] ? Number(enDayMonthMatch[3]) : undefined;
    return resolveHistoricalDate(month, day, refDate, collectorNowDateKey, explicitYear);
  }

  // M/D format
  const slashMatch = /^(\d{1,2})\/(\d{1,2})$/.exec(label);
  if (slashMatch) {
    const month = Number(slashMatch[1]);
    const day = Number(slashMatch[2]);
    return resolveHistoricalDate(month, day, refDate, collectorNowDateKey);
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
  const nowDateKey = toLocalDateKey(now);
  const byDate = new Map<string, number>();

  for (const point of trend.points) {
    if (!isRecord(point) || typeof point.value !== 'number' || !Number.isFinite(point.value) || point.value < 0) continue;
    const dateKey = parsePointDate(point, refDate, nowDateKey);
    if (!dateKey) continue;
    byDate.set(dateKey, point.value);
  }

  if (byDate.size === 0) return [];
  const sortedDates = [...byDate.keys()].sort().slice(-HISTORY_HORIZON_DAYS);
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
  const nowDateKey = toLocalDateKey(now);
  const yesterdayDateKey = shiftDateKey(nowDateKey, -1);

  for (const provider of input) {
    if (!isRecord(provider) || typeof provider.providerId !== 'string' || !Array.isArray(provider.lines)) continue;

    if (typeof provider.fetchedAt === 'string') {
      const parsedTime = Date.parse(provider.fetchedAt);
      if (!Number.isFinite(parsedTime) || parsedTime > now.getTime() || toLocalDateKey(new Date(parsedTime)) > nowDateKey) {
        continue;
      }
    }

    const sourceFetchedDate = typeof provider.fetchedAt === 'string' && Number.isFinite(Date.parse(provider.fetchedAt))
      ? new Date(provider.fetchedAt)
      : now;
    const sourceDateKey = toLocalDateKey(sourceFetchedDate);
    const sourceYesterdayKey = shiftDateKey(sourceDateKey, -1);

    const daily = tokenTrend(provider.lines, sourceFetchedDate, now);
    const inWindowDaily = daily.filter((item) => isWithinCalendarWindow(item.date, nowDateKey, HISTORY_HORIZON_DAYS));
    if (!inWindowDaily.length) continue;

    const todayLine = findLine(provider.lines, 'text', 'Today');
    const yesterdayLine = findLine(provider.lines, 'text', 'Yesterday');
    const last30Line = findLine(provider.lines, 'text', 'Last 30 Days');

    const costFromTodayLine = parseUsd(todayLine?.value);
    const costFromYesterdayLine = parseUsd(yesterdayLine?.value);

    // Enriched daily attaches costs to the source's actual dates, not shifting to collector-now
    const enriched = inWindowDaily.map((item) => {
      if (item.date === sourceDateKey && costFromTodayLine !== undefined) {
        return { ...item, estimatedCostUsd: costFromTodayLine };
      }
      if (item.date === sourceYesterdayKey && costFromYesterdayLine !== undefined) {
        return { ...item, estimatedCostUsd: costFromYesterdayLine };
      }
      return item;
    });

    const isSourceCurrent = sourceDateKey === nowDateKey;
    const todayItem = enriched.find((item) => item.date === nowDateKey);
    const yesterdayItem = enriched.find((item) => item.date === yesterdayDateKey);
    const last30 = enriched.filter((item) => isWithinCalendarWindow(item.date, nowDateKey, 30));
    const last30Cost = isSourceCurrent ? last30Line?.value : undefined;

    const periods = {
      ...(isSourceCurrent && todayItem ? { today: withPeriodCost({ tokens: todayItem.tokens }, todayLine?.value)! } : {}),
      ...(isSourceCurrent && yesterdayItem ? { yesterday: withPeriodCost({ tokens: yesterdayItem.tokens }, yesterdayLine?.value)! } : {}),
      ...(last30.length ? { last30Days: withPeriodCost({ tokens: last30.reduce((sum, item) => sum + item.tokens, 0) }, last30Cost)! } : {}),
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
