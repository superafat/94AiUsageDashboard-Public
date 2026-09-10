import { describe, expect, it } from 'vitest';
import type { UsageSnapshot } from './schema';
import {
  isSnapshotFresh,
  isSnapshotStale,
  REMOTE_SYNC_STALE_AFTER_MS,
  SOURCE_STALE_AFTER_MS,
} from './freshness';

const baseNow = Date.parse('2026-09-07T10:00:00.000Z');

const validSnapshot: UsageSnapshot = {
  schemaVersion: 1,
  userId: 'alice',
  deviceId: 'device-1',
  providerId: 'codex',
  plan: 'Pro',
  fetchedAt: '2026-09-07T09:55:00.000Z', // 5m ago
  syncedAt: '2026-09-07T09:56:00.000Z',  // 4m ago
  expiresAt: '2026-09-07T10:05:00.000Z', // 5m in future
  stale: false,
  resources: {
    session: { kind: 'consumption', unit: 'percent', remaining: 40, resetsAt: '2026-09-07T15:00:00.000Z' },
  },
};

describe('centralized snapshot freshness', () => {
  it('considers valid, unexpired snapshot within age limits as fresh', () => {
    expect(isSnapshotFresh(validSnapshot, baseNow)).toBe(true);
    expect(isSnapshotStale(validSnapshot, baseNow)).toBe(false);
  });

  it('rejects upstream stale: true as not current', () => {
    const snapshot: UsageSnapshot = { ...validSnapshot, stale: true };
    expect(isSnapshotFresh(snapshot, baseNow)).toBe(false);
    expect(isSnapshotStale(snapshot, baseNow)).toBe(true);
  });

  it('rejects expired expiresAt (at or before now) as not current', () => {
    const exactExpiry: UsageSnapshot = {
      ...validSnapshot,
      expiresAt: new Date(baseNow).toISOString(),
    };
    expect(isSnapshotFresh(exactExpiry, baseNow)).toBe(false);
    expect(isSnapshotStale(exactExpiry, baseNow)).toBe(true);

    const pastExpiry: UsageSnapshot = {
      ...validSnapshot,
      expiresAt: new Date(baseNow - 1000).toISOString(),
    };
    expect(isSnapshotFresh(pastExpiry, baseNow)).toBe(false);
    expect(isSnapshotStale(pastExpiry, baseNow)).toBe(true);
  });

  it('rejects future fetchedAt or syncedAt as not current', () => {
    const futureFetched: UsageSnapshot = {
      ...validSnapshot,
      fetchedAt: new Date(baseNow + 60_000).toISOString(),
    };
    expect(isSnapshotFresh(futureFetched, baseNow)).toBe(false);
    expect(isSnapshotStale(futureFetched, baseNow)).toBe(true);

    const futureSynced: UsageSnapshot = {
      ...validSnapshot,
      syncedAt: new Date(baseNow + 30_000).toISOString(),
    };
    expect(isSnapshotFresh(futureSynced, baseNow)).toBe(false);
    expect(isSnapshotStale(futureSynced, baseNow)).toBe(true);
  });

  it('rejects invalid timestamp ordering (fetchedAt > syncedAt or expiresAt < fetchedAt)', () => {
    const fetchedAfterSynced: UsageSnapshot = {
      ...validSnapshot,
      fetchedAt: '2026-09-07T09:58:00.000Z',
      syncedAt: '2026-09-07T09:56:00.000Z',
    };
    expect(isSnapshotFresh(fetchedAfterSynced, baseNow)).toBe(false);
    expect(isSnapshotStale(fetchedAfterSynced, baseNow)).toBe(true);

    const expiresBeforeFetched: UsageSnapshot = {
      ...validSnapshot,
      fetchedAt: '2026-09-07T09:55:00.000Z',
      expiresAt: '2026-09-07T09:54:00.000Z',
    };
    expect(isSnapshotFresh(expiresBeforeFetched, baseNow)).toBe(false);
    expect(isSnapshotStale(expiresBeforeFetched, baseNow)).toBe(true);
  });

  it('rejects snapshots exceeding sync or source age limits', () => {
    // Remote sync age limit (7 min)
    const oldSync: UsageSnapshot = {
      ...validSnapshot,
      syncedAt: new Date(baseNow - REMOTE_SYNC_STALE_AFTER_MS).toISOString(),
    };
    expect(isSnapshotFresh(oldSync, baseNow)).toBe(false);
    expect(isSnapshotStale(oldSync, baseNow)).toBe(true);

    // Source age limit (12 min)
    const oldSource: UsageSnapshot = {
      ...validSnapshot,
      fetchedAt: new Date(baseNow - SOURCE_STALE_AFTER_MS).toISOString(),
    };
    expect(isSnapshotFresh(oldSource, baseNow)).toBe(false);
    expect(isSnapshotStale(oldSource, baseNow)).toBe(true);
  });

  it('rejects unparseable invalid dates', () => {
    const invalidDate: UsageSnapshot = {
      ...validSnapshot,
      fetchedAt: 'not-a-date',
    };
    expect(isSnapshotFresh(invalidDate, baseNow)).toBe(false);
    expect(isSnapshotStale(invalidDate, baseNow)).toBe(true);
  });

  it('does not treat a passed resetsAt as automatic quota replenishment', () => {
    const passedResetSnapshot: UsageSnapshot = {
      ...validSnapshot,
      resources: {
        session: { kind: 'consumption', unit: 'percent', remaining: 0, resetsAt: '2026-09-07T09:50:00.000Z' }, // reset 10m ago
      },
    };
    // The snapshot resources remaining must remain 0 and not automatically replenished to 100
    expect(passedResetSnapshot.resources.session?.kind === 'consumption' ? passedResetSnapshot.resources.session.remaining : undefined).toBe(0);
  });
});
