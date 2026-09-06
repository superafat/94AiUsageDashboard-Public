import { collectionGroup, doc, onSnapshot, query, setDoc, where, writeBatch, type Firestore } from 'firebase/firestore';
import { parseUsageHistorySnapshot, parseUsageSnapshot, type UsageHistorySnapshot, type UsageSnapshot } from '@94ai/core';
import { historyDocPath, historyChunkPath, usageDocPath } from './paths';
import { assembleUsageHistory, parseHistoryChunk, parseHistorySummary, splitHistoryForStorage, HISTORY_MAX_CHUNKS, type UsageHistoryChunk } from './history-storage';

export { historyDocPath, usageDocPath } from './paths';

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
