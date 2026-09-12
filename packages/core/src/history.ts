import { isValidCalendarDate } from './schema';

export type UsagePeriod = '1d' | '7d' | '30d' | '90d' | '180d';
export const HISTORY_HORIZON_DAYS = 180;

export interface DailyUsageAggregate {
  date: string;
  tokens: number;
  estimatedCostUsd?: number;
  finalized: boolean;
}

export interface UsagePeriodAggregate {
  tokens: number;
  estimatedCostUsd?: number;
}

export interface UsageHistorySnapshot {
  schemaVersion: 1;
  userId: string;
  deviceId: string;
  providerId: string;
  syncedAt: string;
  currency: 'USD';
  periods: { today?: UsagePeriodAggregate; yesterday?: UsagePeriodAggregate; last30Days?: UsagePeriodAggregate };
  daily: DailyUsageAggregate[];
}

export interface UsagePeriodSummary extends UsagePeriodAggregate {
  costComplete: boolean;
  daysWithData: number;
}
const HISTORY_FIELDS = new Set(['schemaVersion', 'userId', 'deviceId', 'providerId', 'syncedAt', 'currency', 'periods', 'daily']);
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function nonNegative(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative`);
  return value;
}

function parsePeriod(value: unknown, label: string): UsagePeriodAggregate | undefined {
  if (value === undefined) return undefined;
  const input = object(value, label);
  for (const key of Object.keys(input)) if (!['tokens', 'estimatedCostUsd'].includes(key)) throw new Error(`unknown ${label} field: ${key}`);
  return { tokens: nonNegative(input.tokens, `${label}.tokens`), ...(input.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: nonNegative(input.estimatedCostUsd, `${label}.estimatedCostUsd`) }) };
}
function parseDaily(value: unknown, index: number): DailyUsageAggregate {
  const input = object(value, `daily[${index}]`);
  for (const key of Object.keys(input)) if (!['date', 'tokens', 'estimatedCostUsd', 'finalized'].includes(key)) throw new Error(`unknown daily field: ${key}`);
  const date = nonEmptyString(input.date, `daily[${index}].date`);
  if (!DATE_KEY.test(date)) throw new Error(`daily[${index}].date must be YYYY-MM-DD`);
  if (typeof input.finalized !== 'boolean') throw new Error(`daily[${index}].finalized must be boolean`);
  return {
    date,
    tokens: nonNegative(input.tokens, `daily[${index}].tokens`),
    ...(input.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: nonNegative(input.estimatedCostUsd, `daily[${index}].estimatedCostUsd`) }),
    finalized: input.finalized,
  };
}

export function parseUsageHistorySnapshot(value: unknown): UsageHistorySnapshot {
  const input = object(value, 'history');
  for (const key of Object.keys(input)) if (!HISTORY_FIELDS.has(key)) throw new Error(`unknown history field: ${key}`);
  if (input.schemaVersion !== 1) throw new Error('history schemaVersion must be 1');
  if (input.currency !== 'USD') throw new Error('history currency must be USD');
  if (typeof input.syncedAt !== 'string' || !Number.isFinite(Date.parse(input.syncedAt))) throw new Error('history syncedAt must be ISO timestamp');
  if (!Array.isArray(input.daily)) throw new Error('history daily must be an array');
  if (input.daily.length > HISTORY_HORIZON_DAYS) throw new Error(`history daily must contain at most ${HISTORY_HORIZON_DAYS} days`);
  const daily = input.daily.map(parseDaily);
  if (new Set(daily.map((item) => item.date)).size !== daily.length) throw new Error('history contains duplicate daily dates');
  const periodsInput = object(input.periods, 'history.periods');
  for (const key of Object.keys(periodsInput)) if (!['today', 'yesterday', 'last30Days'].includes(key)) throw new Error(`unknown history period: ${key}`);
  return {
    schemaVersion: 1,
    userId: nonEmptyString(input.userId, 'history.userId'),
    deviceId: nonEmptyString(input.deviceId, 'history.deviceId'),
    providerId: nonEmptyString(input.providerId, 'history.providerId'),
    syncedAt: input.syncedAt,
    currency: 'USD',
    periods: {
      ...(periodsInput.today === undefined ? {} : { today: parsePeriod(periodsInput.today, 'history.periods.today')! }),
      ...(periodsInput.yesterday === undefined ? {} : { yesterday: parsePeriod(periodsInput.yesterday, 'history.periods.yesterday')! }),
      ...(periodsInput.last30Days === undefined ? {} : { last30Days: parsePeriod(periodsInput.last30Days, 'history.periods.last30Days')! }),
    },
    daily: [...daily].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export function toLocalDateKey(dateOrIso: Date | string | number, timeZone?: string): string {
  const date = typeof dateOrIso === 'object' && dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid date');
  if (timeZone) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function dateKeyToUtcOrdinal(dateKey: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidCalendarDate(year, month, day)) return undefined;
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function calendarDayDifference(fromKey: string, toKey: string): number | undefined {
  const fromOrd = dateKeyToUtcOrdinal(fromKey);
  const toOrd = dateKeyToUtcOrdinal(toKey);
  if (fromOrd === undefined || toOrd === undefined) return undefined;
  return toOrd - fromOrd;
}

export function shiftDateKey(dateKey: string, daysDelta: number): string {
  const ord = dateKeyToUtcOrdinal(dateKey);
  if (ord === undefined) throw new Error(`Invalid date key: ${dateKey}`);
  return new Date((ord + daysDelta) * 86_400_000).toISOString().slice(0, 10);
}

export function isWithinCalendarWindow(candidateKey: string, anchorKey: string, windowDays: number = HISTORY_HORIZON_DAYS): boolean {
  const diff = calendarDayDifference(candidateKey, anchorKey);
  if (diff === undefined) return false;
  return diff >= 0 && diff <= (windowDays - 1);
}

function localDateKey(date: Date): string {
  return toLocalDateKey(date);
}
function recentDateKeys(now: Date, count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - index, 12, 0, 0, 0);
    return localDateKey(date);
  });
}

export function summarizeHistory(snapshot: UsageHistorySnapshot, period: UsagePeriod, now: Date): UsagePeriodSummary {
  const nowDateKey = localDateKey(now);
  const periodSourceIsCurrent = toLocalDateKey(snapshot.syncedAt) === nowDateKey;

  if (period === '1d') {
    const today = snapshot.daily.find((item) => item.date === nowDateKey);
    const source = periodSourceIsCurrent ? snapshot.periods.today : undefined;
    const tokens = today?.tokens ?? source?.tokens ?? 0;
    const estimatedCostUsd = source?.estimatedCostUsd ?? today?.estimatedCostUsd;
    return { tokens, ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }), costComplete: estimatedCostUsd !== undefined, daysWithData: today || source ? 1 : 0 };
  }
  if (period === '30d') {
    const source = periodSourceIsCurrent ? snapshot.periods.last30Days : undefined;
    const keys = new Set(recentDateKeys(now, 30));
    const daily = snapshot.daily.filter((item) => keys.has(item.date));
    const tokens = daily.reduce((sum, item) => sum + item.tokens, 0);
    const estimatedCostUsd = source?.estimatedCostUsd;
    return { tokens, ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }), costComplete: estimatedCostUsd !== undefined, daysWithData: daily.length };
  }

  const count = period === '7d' ? 7 : period === '90d' ? 90 : 180;
  const keys = new Set(recentDateKeys(now, count));
  const daily = snapshot.daily.filter((item) => keys.has(item.date));
  const byDate = new Map(daily.map((item) => [item.date, item]));
  const selected = recentDateKeys(now, count).map((key) => byDate.get(key));
  const tokens = daily.reduce((sum, item) => sum + item.tokens, 0);
  const complete = selected.every((item) => item !== undefined && (item.estimatedCostUsd !== undefined || item.tokens === 0));
  const estimatedCostUsd = complete ? selected.reduce((sum, item) => sum + (item?.estimatedCostUsd ?? 0), 0) : undefined;
  return { tokens, ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }), costComplete: complete, daysWithData: daily.length };
}
