import {
  parseUsageHistorySnapshot,
  HISTORY_HORIZON_DAYS,
  toLocalDateKey,
  isWithinCalendarWindow,
  type UsageHistorySnapshot,
} from '@94ai/core';
import type { ProviderHistoryInput } from '@94ai/openusage';

export interface HistorySyncContext {
  userId: string;
  deviceId: string;
  syncedAt: string;
}

export function buildHistorySnapshot(input: ProviderHistoryInput, ctx: HistorySyncContext): UsageHistorySnapshot {
  return parseUsageHistorySnapshot({
    schemaVersion: 1,
    userId: ctx.userId,
    deviceId: ctx.deviceId,
    providerId: input.providerId,
    syncedAt: ctx.syncedAt,
    currency: 'USD',
    periods: input.periods,
    daily: input.daily,
  });
}

function sameIdentity(a: UsageHistorySnapshot, b: UsageHistorySnapshot): boolean {
  return a.userId === b.userId && a.deviceId === b.deviceId && a.providerId === b.providerId;
}

export function mergeHistory(
  previous: UsageHistorySnapshot | undefined,
  incoming: UsageHistorySnapshot,
  timeZone?: string,
): UsageHistorySnapshot {
  if (previous && !sameIdentity(previous, incoming)) {
    throw new Error('history identity mismatch');
  }

  const mergedByDate = new Map(previous ? previous.daily.map((item) => [item.date, item]) : []);
  for (const item of incoming.daily) {
    const prior = mergedByDate.get(item.date);
    mergedByDate.set(item.date, {
      ...item,
      ...(item.estimatedCostUsd === undefined && prior?.estimatedCostUsd !== undefined
        ? { estimatedCostUsd: prior.estimatedCostUsd }
        : {}),
      finalized: item.finalized || Boolean(prior?.finalized),
    });
  }

  // Anchor ONLY from trusted sync timestamp converted to local calendar date; never from daily rows
  const anchorDateKey = toLocalDateKey(incoming.syncedAt, timeZone);

  // Filter all rows to [anchor-179, anchor], preserving sparse rows
  const daily = [...mergedByDate.values()]
    .filter((item) => isWithinCalendarWindow(item.date, anchorDateKey, HISTORY_HORIZON_DAYS))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-HISTORY_HORIZON_DAYS);

  return parseUsageHistorySnapshot({
    ...incoming,
    daily,
  });
}
