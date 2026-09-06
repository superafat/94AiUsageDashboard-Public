import { parseUsageSnapshot, type UsageHistorySnapshot, type UsageSnapshot } from '@94ai/core';
import { historyDocPath, historyChunkPath, usageDocPath } from './paths';
import { assembleUsageHistory, parseHistorySummary, splitHistoryForStorage, HISTORY_MAX_CHUNKS } from './history-storage';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type FirestoreValue = Record<string, unknown>;

function encodeValue(value: unknown): FirestoreValue {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Firestore REST cannot encode non-finite numbers');
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (value && typeof value === 'object') return { mapValue: { fields: encodeMap(value as Record<string, unknown>) } };
  throw new Error('Firestore REST cannot encode unsupported value');
}

function encodeMap(value: Record<string, unknown>): Record<string, FirestoreValue> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, encodeValue(item)]),
  );
}



function decodeValue(value: FirestoreValue): unknown {
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('arrayValue' in value) {
    const raw = value.arrayValue as { values?: FirestoreValue[] };
    return (raw.values ?? []).map(decodeValue);
  }
  if ('mapValue' in value) {
    const raw = value.mapValue as { fields?: Record<string, FirestoreValue> };
    return decodeMap(raw.fields ?? {});
  }
  throw new Error('Firestore REST returned unsupported value');
}

function decodeMap(fields: Record<string, FirestoreValue>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
}

function restDocumentUrl(projectId: string, documentPath: string): string {
  const encoded = documentPath.split('/').map(encodeURIComponent).join('/');
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${encoded}`;
}

export async function writeUsageSnapshotRest(
  projectId: string,
  idToken: string,
  snapshot: UsageSnapshot,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const parsed = parseUsageSnapshot(snapshot);
  const url = restDocumentUrl(projectId, usageDocPath(parsed.userId, parsed.deviceId, parsed.providerId));
  const response = await fetchImpl(url, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${idToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ fields: encodeMap(parsed as unknown as Record<string, unknown>) }),
  });
  if (!response.ok) throw new Error(`Firestore write failed (${response.status})`);
}


export async function writeUsageHistoryRest(
  projectId: string,
  idToken: string,
  snapshot: UsageHistorySnapshot,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const { summary, chunks } = splitHistoryForStorage(snapshot);
  const database = `projects/${projectId}/databases/(default)`;
  const name = (path: string) => `${database}/documents/${path}`;
  const writes: Array<Record<string, unknown>> = [{ update: {
    name: name(historyDocPath(summary.userId, summary.deviceId, summary.providerId)),
    fields: encodeMap(summary as unknown as Record<string, unknown>),
  } }];
  for (const chunk of chunks) writes.push({ update: {
    name: name(historyChunkPath(chunk.userId, chunk.deviceId, chunk.providerId, chunk.chunkId)),
    fields: encodeMap(chunk as unknown as Record<string, unknown>),
  } });
  for (let i = chunks.length; i < HISTORY_MAX_CHUNKS; i++) writes.push({ delete: name(historyChunkPath(summary.userId, summary.deviceId, summary.providerId, String(i))) });
  const response = await fetchImpl(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:commit`, {
    method: 'POST', signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${idToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ writes }),
  });
  if (!response.ok) throw new Error(`Firestore history write failed (${response.status})`);
}

export async function readUsageHistoryRest(
  projectId: string,
  idToken: string,
  uid: string,
  deviceId: string,
  providerId: string,
  fetchImpl: FetchLike = fetch,
): Promise<UsageHistorySnapshot | undefined> {
  const url = restDocumentUrl(projectId, historyDocPath(uid, deviceId, providerId));
  const response = await fetchImpl(url, { method: 'GET', headers: { authorization: `Bearer ${idToken}`, accept: 'application/json' } });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Firestore history read failed (${response.status})`);
  const payload = await response.json() as { fields?: Record<string, FirestoreValue> };
  if (!payload.fields) throw new Error('Firestore history document is missing fields');
  const summary = parseHistorySummary(decodeMap(payload.fields));
  if (summary.userId !== uid || summary.deviceId !== deviceId || summary.providerId !== providerId) throw new Error('history identity mismatch');
  if (!('storageVersion' in summary)) return summary;
  if (summary.chunkCount === 0) return assembleUsageHistory(summary, []);
  const chunksResponse = await fetchImpl(`${url}/historyChunks?pageSize=7`, {
    method: 'GET', signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${idToken}`, accept: 'application/json' },
  });
  if (!chunksResponse.ok) throw new Error(`Firestore history chunks read failed (${chunksResponse.status})`);
  const page = await chunksResponse.json() as { documents?: Array<{ fields?: Record<string, FirestoreValue> }>; nextPageToken?: string };
  if (page.nextPageToken) throw new Error('history chunks exceed bounds');
  return assembleUsageHistory(summary, (page.documents ?? []).map(d => decodeMap(d.fields ?? {})));
}
