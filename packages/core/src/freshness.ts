import type { UsageSnapshot } from './schema';

export const REMOTE_SYNC_STALE_AFTER_MS = 7 * 60 * 1000;
export const SOURCE_STALE_AFTER_MS = 12 * 60 * 1000;

export function isSnapshotFresh(snapshot: UsageSnapshot, now: number | Date = Date.now()): boolean {
  return !isSnapshotStale(snapshot, now);
}

export function isSnapshotStale(snapshot: UsageSnapshot, now: number | Date = Date.now()): boolean {
  const currentTime = typeof now === 'number' ? now : now.getTime();
  if (!Number.isFinite(currentTime)) return true;
  if (snapshot.stale) return true;

  const fetchedAt = Date.parse(snapshot.fetchedAt);
  const syncedAt = Date.parse(snapshot.syncedAt);
  const expiresAt = Date.parse(snapshot.expiresAt);

  if (!Number.isFinite(fetchedAt) || !Number.isFinite(syncedAt) || !Number.isFinite(expiresAt)) {
    return true;
  }

  // Future fetched/synced times
  if (fetchedAt > currentTime || syncedAt > currentTime) {
    return true;
  }

  // Expired expiresAt (at or before now)
  if (expiresAt <= currentTime) {
    return true;
  }

  // Invalid ordering: fetchedAt must not be after syncedAt; expiresAt must not be before fetchedAt
  if (fetchedAt > syncedAt || expiresAt < fetchedAt) {
    return true;
  }

  // Age limits
  if (syncedAt + REMOTE_SYNC_STALE_AFTER_MS <= currentTime) {
    return true;
  }
  if (fetchedAt + SOURCE_STALE_AFTER_MS <= currentTime) {
    return true;
  }

  return false;
}
