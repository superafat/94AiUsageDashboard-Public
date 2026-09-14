import { collection, collectionGroup, doc, onSnapshot, query, runTransaction, setDoc, where, writeBatch, type Firestore } from 'firebase/firestore';
import {
  KNOWN_PROVIDER_FAMILIES,
  parseProviderPreference,
  parseResetCommandReceipt,
  parseResetCommandRequestRecord,
  parseResetInventoryEnvelope,
  parseUsageHistorySnapshot,
  parseUsageSnapshot,
  resolveFamilyEnabled,
  type ProviderPreference,
  type ResetCommandReceipt,
  type ResetCommandRequestRecord,
  type ResetInventoryEnvelope,
  type UsageHistorySnapshot,
  type UsageSnapshot,
} from '@94ai/core';
import { historyDocPath, historyChunkPath, preferenceDocPath, resetInventoryDocPath, resetRequestDocPath, resetResultDocPath, usageDocPath } from './paths';
import { assembleUsageHistory, parseHistoryChunk, parseHistorySummary, splitHistoryForStorage, HISTORY_MAX_CHUNKS, type UsageHistoryChunk } from './history-storage';

export { historyDocPath, preferenceDocPath, resetInventoryDocPath, resetRequestDocPath, resetResultDocPath, usageDocPath } from './paths';

export async function writeUsageSnapshot(db: Firestore, uid: string, snapshot: UsageSnapshot): Promise<void> {
  const parsed = parseUsageSnapshot(snapshot);
  if (parsed.userId !== uid) throw new Error('auth UID does not match snapshot UID');
  await setDoc(doc(db, usageDocPath(uid, parsed.deviceId, parsed.providerId)), parsed);
}


export async function writeUsageHistory(db: Firestore, uid: string, snapshot: UsageHistorySnapshot): Promise<void> {
  const parsed = parseUsageHistorySnapshot(snapshot);
  if (parsed.userId !== uid) throw new Error('auth UID does not match history UID');
  const { summary, chunks } = splitHistoryForStorage(parsed);
  const batch = writeBatch(db);
  batch.set(doc(db, historyDocPath(uid, parsed.deviceId, parsed.providerId)), summary);
  for (const chunk of chunks) batch.set(doc(db, historyChunkPath(uid, parsed.deviceId, parsed.providerId, chunk.chunkId)), chunk);
  for (let i = chunks.length; i < HISTORY_MAX_CHUNKS; i++) batch.delete(doc(db, historyChunkPath(uid, parsed.deviceId, parsed.providerId, String(i))));
  await batch.commit();
}

export function subscribeUsageSnapshots(
  db: Firestore,
  uid: string,
  onValue: (items: UsageSnapshot[]) => void,
  onError?: (error: Error) => void,
): () => void {
  const snapshots = query(collectionGroup(db, 'providers'), where('userId', '==', uid));
  return onSnapshot(snapshots, (result) => {
    const items: UsageSnapshot[] = [];
    result.forEach((entry) => {
      try {
        items.push(parseUsageSnapshot(entry.data()));
      } catch {
        return;
      }
    });
    onValue(items);
  }, (error) => onError?.(error));
}


export function subscribeUsageHistory(
  db: Firestore,
  uid: string,
  onValue: (items: UsageHistorySnapshot[]) => void,
  onError?: (error: Error) => void,
): () => void {
  const summaries = query(collectionGroup(db, 'history'), where('userId', '==', uid));
  const chunkQuery = query(collectionGroup(db, 'historyChunks'), where('userId', '==', uid));
  let summaryValues: ReturnType<typeof parseHistorySummary>[] = [];
  let chunkValues: UsageHistoryChunk[] = [];
  let stopped = false;
  const lastGood = new Map<string, UsageHistorySnapshot>();
  const emit = () => {
    if (stopped) return;
    const active = new Set<string>();
    for (const summary of summaryValues) {
      const key = JSON.stringify([summary.userId, summary.deviceId, summary.providerId]);
      active.add(key);
      try { lastGood.set(key, assembleUsageHistory(summary, chunkValues.filter(c => c.userId === summary.userId && c.deviceId === summary.deviceId && c.providerId === summary.providerId))); }
      catch { /* Independent query callbacks may arrive in either order; never emit a mixed generation. */ }
    }
    for (const key of lastGood.keys()) if (!active.has(key)) lastGood.delete(key);
    onValue([...lastGood.values()]);
  };
  const stopSummaries = onSnapshot(summaries, result => {
    summaryValues = result.docs.flatMap(entry => {
      try { const value = parseHistorySummary(entry.data()); return value.userId === uid ? [value] : []; } catch { return []; }
    });
    emit();
  }, error => { if (!stopped) onError?.(error); });
  const stopChunks = onSnapshot(chunkQuery, result => {
    chunkValues = result.docs.flatMap(entry => {
      try { const value = parseHistoryChunk(entry.data()); return value.userId === uid ? [value] : []; } catch { return []; }
    });
    emit();
  }, error => { if (!stopped) onError?.(error); });
  return () => { stopped = true; stopSummaries(); stopChunks(); lastGood.clear(); };
}

export async function writeProviderPreference(
  db: Firestore,
  uid: string,
  preference: ProviderPreference,
): Promise<void> {
  const parsed = parseProviderPreference(preference);
  if (parsed.userId !== uid) throw new Error('auth UID does not match preference UID');
  await setDoc(doc(db, preferenceDocPath(uid, parsed.family)), parsed, { merge: true });
}

export async function updateNotificationPreferenceTransaction(
  db: Firestore,
  uid: string,
  family: string,
  patch: { lowQuota?: boolean; reset?: boolean },
): Promise<void> {
  const ref = doc(db, preferenceDocPath(uid, family));
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const existing = snap.exists() ? parseProviderPreference(snap.data()) : undefined;
    if (existing && existing.userId !== uid) {
      throw new Error('auth UID does not match preference UID');
    }
    const currentEnabled = existing?.enabled ?? resolveFamilyEnabled(family, {});
    const currentNotifications = existing?.notifications ?? {};
    const updated: ProviderPreference = {
      schemaVersion: 1,
      userId: uid,
      family,
      enabled: currentEnabled,
      updatedAt: new Date().toISOString(),
      notifications: {
        ...currentNotifications,
        ...patch,
      },
    };
    const parsed = parseProviderPreference(updated);
    if (parsed.userId !== uid) throw new Error('auth UID does not match preference UID');
    tx.set(ref, parsed, { merge: true });
  });
}

export function subscribeProviderPreferences(
  db: Firestore,
  uid: string,
  onValue: (preferences: ProviderPreference[]) => void,
  onError?: (error: Error) => void,
): () => void {
  const preferencesRef = collection(db, 'users', uid, 'preferences');
  let stopped = false;
  const unsubscribe = onSnapshot(
    preferencesRef,
    { includeMetadataChanges: true },
    (result) => {
      if (stopped || result.metadata?.fromCache || result.metadata?.hasPendingWrites) return;
      try {
        const preferences: ProviderPreference[] = [];
        const seenFamilies = new Set<string>();
        if (result.size > KNOWN_PROVIDER_FAMILIES.length) {
          throw new Error('preferences collection exceeds known families bound');
        }
        for (const entry of result.docs) {
          const raw = entry.data();
          const parsed = parseProviderPreference(raw);
          if (parsed.userId !== uid) {
            throw new Error('auth UID does not match preference UID');
          }
          if (entry.id !== parsed.family) {
            throw new Error('document ID does not match preference family');
          }
          if (seenFamilies.has(parsed.family)) {
            throw new Error(`duplicate preference family: ${parsed.family}`);
          }
          seenFamilies.add(parsed.family);
          preferences.push(parsed);
        }
        onValue(preferences);
      } catch (err) {
        if (stopped) return;
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    },
    (error) => {
      if (stopped) return;
      onError?.(error);
    },
  );
  return () => {
    stopped = true;
    unsubscribe();
  };
}

function resetTimestampMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (value && typeof value === 'object' && 'toMillis' in value && typeof (value as {toMillis?: unknown}).toMillis === 'function') {
    return (value as {toMillis(): number}).toMillis();
  }
  return Number.NaN;
}

function resetCloudInventoryEnvelope(value: unknown, now: number | Date): ResetInventoryEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('reset_inventory_cloud_invalid');
  const row = value as Record<string, unknown>;
  const envelope = parseResetInventoryEnvelope({
    version: row.version, type: row.type, publicKey: row.publicKey, signature: row.signature, inventory: row.inventory,
  }, now);
  const observed = resetTimestampMillis(row.observedAtTimestamp);
  const expires = resetTimestampMillis(row.expiresAtTimestamp);
  if (observed !== Date.parse(envelope.inventory.observedAt) || expires !== Date.parse(envelope.inventory.expiresAt)) {
    throw new Error('reset_inventory_timestamp_shadow_mismatch');
  }
  return envelope;
}

export async function writeResetCommandRequest(
  db: Firestore,
  uid: string,
  request: ResetCommandRequestRecord,
  now: number | Date = Date.now(),
): Promise<void> {
  const parsed = parseResetCommandRequestRecord(request, now);
  if (parsed.command.userId !== uid) {
    throw new Error('auth UID does not match request UID');
  }
  const ref = doc(db, resetRequestDocPath(uid, parsed.command.targetDeviceId));
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists()) {
      const existing = snap.data() as (Partial<ResetCommandRequestRecord> & {leaseExpiresAtTimestamp?: unknown}) | undefined;
      const shadowExpires = resetTimestampMillis(existing?.leaseExpiresAtTimestamp);
      const existingExpires = Number.isFinite(shadowExpires)
        ? shadowExpires
        : Date.parse(String(existing?.leaseExpiresAt ?? existing?.command?.expiresAt ?? ''));
      const clock = typeof now === 'number' ? now : now.getTime();
      const leaseExpired = Number.isFinite(existingExpires) && existingExpires <= clock;
      if (!leaseExpired) {
        const priorCommandId = existing?.command?.commandId;
        if (typeof priorCommandId === 'string' && priorCommandId) {
          const resultRef = doc(db, resetResultDocPath(uid, parsed.command.targetDeviceId, priorCommandId));
          const resultSnap = await tx.get(resultRef);
          if (!resultSnap.exists()) {
            throw new Error('active_request_lease_active');
          }
        } else {
          throw new Error('active_request_lease_active');
        }
      }
    }
    tx.set(ref, {
      ...parsed,
      requestedAtTimestamp: new Date(parsed.command.requestedAt),
      leaseExpiresAtTimestamp: new Date(parsed.leaseExpiresAt),
    });
  });
}

export function subscribeResetInventory(
  db: Firestore,
  uid: string,
  deviceId: string,
  onValue: (envelope: ResetInventoryEnvelope | undefined) => void,
  onError?: (error: Error) => void,
  now: number | Date | (() => number | Date) = Date.now,
): () => void {
  const ref = doc(db, resetInventoryDocPath(uid, deviceId));
  let stopped = false;
  const unsubscribe = onSnapshot(
    ref,
    { includeMetadataChanges: true },
    (snapshot) => {
      if (stopped || snapshot.metadata?.fromCache || snapshot.metadata?.hasPendingWrites) return;
      if (!snapshot.exists()) {
        onValue(undefined);
        return;
      }
      try {
        const data = snapshot.data();
        const currentClock = typeof now === 'function' ? now() : now;
        const envelope = resetCloudInventoryEnvelope(data, currentClock);
        if (envelope.inventory.userId !== uid || envelope.inventory.targetDeviceId !== deviceId) {
          throw new Error('reset_inventory_identity_mismatch');
        }
        onValue(envelope);
      } catch (err) {
        if (stopped) return;
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    },
    (error) => {
      if (stopped) return;
      onError?.(error);
    },
  );
  return () => {
    stopped = true;
    unsubscribe();
  };
}

export function subscribeResetResult(
  db: Firestore,
  uid: string,
  deviceId: string,
  commandId: string,
  onValue: (receipt: ResetCommandReceipt | undefined) => void,
  onError?: (error: Error) => void,
): () => void {
  const ref = doc(db, resetResultDocPath(uid, deviceId, commandId));
  let stopped = false;
  const unsubscribe = onSnapshot(
    ref,
    { includeMetadataChanges: true },
    (snapshot) => {
      if (stopped || snapshot.metadata?.fromCache || snapshot.metadata?.hasPendingWrites) return;
      if (!snapshot.exists()) {
        onValue(undefined);
        return;
      }
      try {
        const data = snapshot.data();
        const receipt = parseResetCommandReceipt(data);
        if (receipt.userId !== uid || receipt.targetDeviceId !== deviceId || receipt.commandId !== commandId) {
          throw new Error('reset_result_identity_mismatch');
        }
        onValue(receipt);
      } catch (err) {
        if (stopped) return;
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    },
    (error) => {
      if (stopped) return;
      onError?.(error);
    },
  );
  return () => {
    stopped = true;
    unsubscribe();
  };
}
