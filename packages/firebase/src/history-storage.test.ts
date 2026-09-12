import { describe, expect, it } from 'vitest';
import type { UsageHistorySnapshot } from '@94ai/core';
import { assembleUsageHistory, parseHistoryChunk, splitHistoryForStorage, HISTORY_MAX_CHUNKS } from './history-storage';
import { historyChunkPath } from './paths';

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
  it('splits and assembles full 180-day dense histories into bounded chunks', () => {
    const dense180: UsageHistorySnapshot = {
      ...history,
      daily: Array.from({ length: 180 }, (_, i) => ({
        date: new Date(Date.UTC(2026, 2, 16 + i)).toISOString().slice(0, 10),
        tokens: i * 100,
        finalized: i < 179,
        estimatedCostUsd: i / 10,
      })),
    };
    const stored = splitHistoryForStorage(dense180);
    // 180 days with chunk size 5 = exactly 36 chunks
    expect(stored.chunks).toHaveLength(36);
    expect(stored.summary.chunkCount).toBe(36);
    expect(stored.summary.dayCount).toBe(180);
    expect(stored.chunks[35]!.chunkId).toBe('35');
    expect(assembleUsageHistory(stored.summary, stored.chunks)).toEqual(dense180);
  });

  it('splits and assembles sparse 180-day histories without fabricating missing chunks or days', () => {
    const sparseDates = ['2026-03-16', '2026-04-01', '2026-06-15', '2026-08-01', '2026-09-01', '2026-09-12'];
    const sparseHistory: UsageHistorySnapshot = {
      ...history,
      daily: sparseDates.map((date, idx) => ({ date, tokens: (idx + 1) * 1000, finalized: true })),
    };
    const stored = splitHistoryForStorage(sparseHistory);
    // 6 sparse dates with chunk size 5 = 2 chunks
    expect(stored.chunks).toHaveLength(2);
    expect(stored.summary.chunkCount).toBe(2);
    expect(stored.summary.dayCount).toBe(6);
    expect(assembleUsageHistory(stored.summary, stored.chunks)).toEqual(sparseHistory);
  });

  it('backward compatibility: existing 35-day / 7-chunk documents still parse and assemble unchanged', () => {
    const legacy35: UsageHistorySnapshot = {
      ...history,
      daily: Array.from({ length: 35 }, (_, i) => ({
        date: new Date(Date.UTC(2026, 7, 3 + i)).toISOString().slice(0, 10),
        tokens: i * 10,
        finalized: true,
        estimatedCostUsd: i / 10,
      })),
    };
    const stored = splitHistoryForStorage(legacy35);
    expect(stored.chunks).toHaveLength(7);
    expect(stored.summary.dayCount).toBe(35);
    expect(stored.summary.chunkCount).toBe(7);
    expect(stored.chunks.map((c) => c.chunkId)).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    expect(assembleUsageHistory(stored.summary, stored.chunks)).toEqual(legacy35);
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

  it('strictly bounds chunk namespace to 0..35 (exactly 36 chunks derived from 180 days / 5)', () => {
    expect(HISTORY_MAX_CHUNKS).toBe(36);
    const validChunk = splitHistoryForStorage(history).chunks[0]!;
    // Boundary ID 35 accepted
    const chunk35 = parseHistoryChunk({ ...validChunk, chunkId: '35' });
    expect(chunk35.chunkId).toBe('35');
    expect(historyChunkPath('alice', 'dev1', 'codex', '35')).toContain('/historyChunks/35');

    // Legacy IDs 0..6 accepted
    for (let i = 0; i <= 6; i++) {
      expect(parseHistoryChunk({ ...validChunk, chunkId: String(i) }).chunkId).toBe(String(i));
      expect(historyChunkPath('alice', 'dev1', 'codex', String(i))).toContain(`/historyChunks/${i}`);
    }

    // ID 36 and above rejected
    expect(() => parseHistoryChunk({ ...validChunk, chunkId: '36' })).toThrow(/history chunk ID invalid/);
    expect(() => parseHistoryChunk({ ...validChunk, chunkId: '39' })).toThrow(/history chunk ID invalid/);
    expect(() => parseHistoryChunk({ ...validChunk, chunkId: '40' })).toThrow(/history chunk ID invalid/);
    expect(() => historyChunkPath('alice', 'dev1', 'codex', '36')).toThrow(/history chunk must be between 0 and 35/);
    expect(() => historyChunkPath('alice', 'dev1', 'codex', '39')).toThrow(/history chunk must be between 0 and 35/);
  });
});
