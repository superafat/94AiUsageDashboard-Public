import { describe, expect, it } from 'vitest';
import type { UsageHistorySnapshot } from '@94ai/core';
import { assembleUsageHistory, parseHistoryChunk, splitHistoryForStorage } from './history-storage';

const history: UsageHistorySnapshot = {
  schemaVersion: 1, userId: 'alice', deviceId: 'device-1', providerId: 'codex',
  syncedAt: '2026-09-06T10:00:00.000Z', currency: 'USD',
  periods: { today: { tokens: 10, estimatedCostUsd: 1 } },
  daily: Array.from({ length: 31 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 7, 7 + index)).toISOString().slice(0, 10),
    tokens: 10 + index,
    ...(index >= 29 ? { estimatedCostUsd: index / 10 } : {}),
    finalized: index < 30,
  })),
};

describe('history Firestore storage', () => {
  it('splits 31 days into stable chunks of at most five while keeping summary daily empty', () => {
    const stored = splitHistoryForStorage(history);
    expect(stored.summary.daily).toEqual([]);
    expect(stored.chunks.length).toBeGreaterThanOrEqual(7);
    expect(stored.chunks.every((chunk) => chunk.daily.length >= 1 && chunk.daily.length <= 5)).toBe(true);
    expect(stored.chunks.flatMap((chunk) => chunk.daily)).toHaveLength(31);
  });

  it('assembles the same canonical history without exposing storage chunks to the domain', () => {
    const stored = splitHistoryForStorage(history);
    expect(assembleUsageHistory(stored.summary, stored.chunks)).toEqual(history);
  });

  it('rejects extra secret-shaped fields inside a chunk daily row', () => {
    const chunk = splitHistoryForStorage(history).chunks[0]!;
    expect(() => parseHistoryChunk({ ...chunk, daily: [{ ...chunk.daily[0], prompt: 'private' }] })).toThrow(/unknown daily field/i);
    expect(() => parseHistoryChunk({ ...chunk, token: 'secret' })).toThrow(/unknown history chunk field/i);
  });
  it('handles the maximum 35 dates and rejects oversized canonical histories', () => {
    const maximum = { ...history, daily: Array.from({ length: 35 }, (_, i) => ({ date: new Date(Date.UTC(2026, 7, 3 + i)).toISOString().slice(0,10), tokens: i, finalized: true, estimatedCostUsd: i / 10 })) };
    const stored = splitHistoryForStorage(maximum);
    expect(stored.chunks).toHaveLength(7);
    expect(assembleUsageHistory(stored.summary, stored.chunks)).toEqual(maximum);
    expect(() => splitHistoryForStorage({ ...maximum, daily: [...maximum.daily, { date: '2026-09-07', tokens: 0, finalized: false }] })).toThrow(/at most 35/);
  });

  it('never combines a new summary with stale, incomplete or foreign chunks', () => {
    const stored = splitHistoryForStorage(history);
    expect(() => assembleUsageHistory(stored.summary, stored.chunks.slice(1))).toThrow(/incomplete/);
    expect(() => assembleUsageHistory(stored.summary, stored.chunks.map(c => ({ ...c, syncedAt: '2000-01-01T00:00:00.000Z' })))).toThrow(/incomplete/);
    expect(() => assembleUsageHistory(stored.summary, stored.chunks.map(c => ({ ...c, userId: 'bob' })))).toThrow(/incomplete/);
    expect(() => assembleUsageHistory(stored.summary, [...stored.chunks, stored.chunks[0]!])).toThrow(/duplicate/);
  });

  it('reads legacy unchunked histories and accepts an empty new history', () => {
    expect(assembleUsageHistory(history, [])).toEqual(history);
    const empty = { ...history, daily: [] };
    const stored = splitHistoryForStorage(empty);
    expect(stored.chunks).toHaveLength(0);
    expect(assembleUsageHistory(stored.summary, stored.chunks)).toEqual(empty);
  });

});
