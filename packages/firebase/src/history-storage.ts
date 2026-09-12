import { parseUsageHistorySnapshot, HISTORY_HORIZON_DAYS, type DailyUsageAggregate, type UsageHistorySnapshot } from '@94ai/core';

export const HISTORY_CHUNK_SIZE = 5;
export const HISTORY_MAX_CHUNKS = Math.ceil(HISTORY_HORIZON_DAYS / HISTORY_CHUNK_SIZE);
export interface UsageHistorySummary extends UsageHistorySnapshot {
  storageVersion: 2;
  chunkCount: number;
  dayCount: number;
}
export interface UsageHistoryChunk {
  schemaVersion: 1;
  userId: string;
  deviceId: string;
  providerId: string;
  syncedAt: string;
  chunkId: string;
  daily: DailyUsageAggregate[];
}
const CHUNK_FIELDS = new Set(['schemaVersion', 'userId', 'deviceId', 'providerId', 'syncedAt', 'chunkId', 'daily']);
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('history storage must be an object');
  return value as Record<string, unknown>;
}
export function parseHistoryChunk(value: unknown): UsageHistoryChunk {
  const input = record(value);
  for (const key of Object.keys(input)) if (!CHUNK_FIELDS.has(key)) throw new Error(`unknown history chunk field: ${key}`);
  if (typeof input.chunkId !== 'string' || !/^(?:[0-9]|[12][0-9]|3[0-5])$/.test(input.chunkId)) throw new Error('history chunk ID invalid');
  if (!Array.isArray(input.daily) || input.daily.length < 1 || input.daily.length > HISTORY_CHUNK_SIZE) throw new Error('history chunk size invalid');
  const parsed = parseUsageHistorySnapshot({ schemaVersion: input.schemaVersion, userId: input.userId, deviceId: input.deviceId,
    providerId: input.providerId, syncedAt: input.syncedAt, currency: 'USD', periods: {}, daily: input.daily });
  return { schemaVersion: 1, userId: parsed.userId, deviceId: parsed.deviceId, providerId: parsed.providerId,
    syncedAt: parsed.syncedAt, chunkId: input.chunkId, daily: parsed.daily };
}
export function parseHistorySummary(value: unknown): UsageHistorySnapshot | UsageHistorySummary {
  const input = record(value);
  if (!('storageVersion' in input)) return parseUsageHistorySnapshot(input);
  const { storageVersion, chunkCount, dayCount, ...canonical } = input;
  if (storageVersion !== 2 || typeof dayCount !== 'number' || !Number.isInteger(dayCount) || dayCount < 0 || dayCount > HISTORY_HORIZON_DAYS
    || chunkCount !== Math.ceil(dayCount / HISTORY_CHUNK_SIZE)) throw new Error('history storage manifest invalid');
  const parsed = parseUsageHistorySnapshot(canonical);
  if (parsed.daily.length) throw new Error('chunked history summary must have empty daily');
  return { ...parsed, storageVersion: 2, dayCount, chunkCount: chunkCount as number };
}
export function splitHistoryForStorage(value: UsageHistorySnapshot): { summary: UsageHistorySummary; chunks: UsageHistoryChunk[] } {
  const parsed = parseUsageHistorySnapshot(value);
  const chunks: UsageHistoryChunk[] = [];
  for (let start = 0; start < parsed.daily.length; start += HISTORY_CHUNK_SIZE) {
    chunks.push({ schemaVersion: 1, userId: parsed.userId, deviceId: parsed.deviceId, providerId: parsed.providerId,
      syncedAt: parsed.syncedAt, chunkId: String(chunks.length), daily: parsed.daily.slice(start, start + HISTORY_CHUNK_SIZE) });
  }
  return { summary: { ...parsed, daily: [], storageVersion: 2, chunkCount: chunks.length, dayCount: parsed.daily.length }, chunks };
}
export function assembleUsageHistory(value: unknown, chunkValues: unknown[]): UsageHistorySnapshot {
  const summary = parseHistorySummary(value);
  if (!('storageVersion' in summary)) return summary;
  const chunks = chunkValues.map(parseHistoryChunk).filter(chunk => chunk.userId === summary.userId
    && chunk.deviceId === summary.deviceId && chunk.providerId === summary.providerId && chunk.syncedAt === summary.syncedAt);
  if (new Set(chunks.map(c => c.chunkId)).size !== chunks.length) throw new Error('duplicate history chunk');
  const daily: DailyUsageAggregate[] = [];
  for (let i = 0; i < summary.chunkCount; i++) {
    const chunk = chunks.find(c => c.chunkId === String(i));
    if (!chunk) throw new Error('history generation incomplete');
    const expected = Math.min(HISTORY_CHUNK_SIZE, summary.dayCount - i * HISTORY_CHUNK_SIZE);
    if (chunk.daily.length !== expected) throw new Error('history generation incomplete');
    daily.push(...chunk.daily);
  }
  if (chunks.length !== summary.chunkCount || daily.length !== summary.dayCount) throw new Error('history generation incomplete');
  return parseUsageHistorySnapshot({ schemaVersion: summary.schemaVersion, userId: summary.userId, deviceId: summary.deviceId,
    providerId: summary.providerId, syncedAt: summary.syncedAt, currency: summary.currency, periods: summary.periods, daily });
}
