import {
  KNOWN_PROVIDER_FAMILIES,
  parseProviderPreference,
  parseResetCommandReceipt,
  parseResetCommandRequestRecord,
  parseResetInventoryEnvelope,
  parseUsageSnapshot,
  type ProviderPreference,
  type ResetCommandReceipt,
  type ResetCommandRequestRecord,
  type ResetExecutingReceipt,
  type ResetInventoryEnvelope,
  type ResetTerminalReceipt,
  type UsageHistorySnapshot,
  type UsageSnapshot,
} from '@94ai/core';
import { historyDocPath, historyChunkPath, resetInventoryDocPath, resetRequestDocPath, resetResultDocPath, usageDocPath } from './paths';
import { assembleUsageHistory, parseHistorySummary, splitHistoryForStorage, HISTORY_MAX_CHUNKS } from './history-storage';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type FirestoreValue = Record<string, unknown>;

export function encodeValue(value: unknown): FirestoreValue {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Firestore REST cannot encode non-finite numbers');
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('Firestore REST cannot encode non-finite or invalid Date');
    return { timestampValue: value.toISOString() };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (value && typeof value === 'object') {
    return { mapValue: { fields: encodeMap(value as Record<string, unknown>) } };
  }
  throw new Error('Firestore REST cannot encode unsupported value');
}

export function encodeMap(value: Record<string, unknown>): Record<string, FirestoreValue> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, encodeValue(item)]),
  );
}

export function decodeValue(value: FirestoreValue): unknown {
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('timestampValue' in value) {
    if (typeof value.timestampValue !== 'string') throw new Error('Firestore REST returned invalid timestampValue');
    const raw = value.timestampValue;
    const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?Z$/.exec(raw);
    if (!match) throw new Error('Firestore REST returned invalid timestampValue');
    const date = new Date(raw);
    if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() + 1 !== Number(match[2]) || date.getUTCDate() !== Number(match[3])) {
      throw new Error('Firestore REST returned invalid timestampValue');
    }
    return date;
  }
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

export function decodeMap(fields: Record<string, FirestoreValue>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
}

export function restDocumentUrl(projectId: string, documentPath: string): string {
  const encoded = documentPath.split('/').map(encodeURIComponent).join('/');
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${encoded}`;
}

export function composeSignal(signal?: AbortSignal, timeoutMs = 15_000): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      controller.abort(new Error(`Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  }

  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      const onAbort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      return {
        signal: controller.signal,
        cleanup: () => {
          if (timer) clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
        },
      };
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

export async function writeUsageSnapshotRest(
  projectId: string,
  idToken: string,
  snapshot: UsageSnapshot,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<void> {
  const parsed = parseUsageSnapshot(snapshot);
  const url = restDocumentUrl(projectId, usageDocPath(parsed.userId, parsed.deviceId, parsed.providerId));
  const { signal: effectiveSignal, cleanup } = composeSignal(signal, 15_000);
  try {
    const response = await fetchImpl(url, {
      method: 'PATCH',
      signal: effectiveSignal,
      headers: {
        authorization: `Bearer ${idToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ fields: encodeMap(parsed as unknown as Record<string, unknown>) }),
    });
    if (!response.ok) throw new Error(`Firestore write failed (${response.status})`);
  } finally {
    cleanup();
  }
}

export async function writeUsageHistoryRest(
  projectId: string,
  idToken: string,
  snapshot: UsageHistorySnapshot,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
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

  const { signal: effectiveSignal, cleanup } = composeSignal(signal, 15_000);
  try {
    const response = await fetchImpl(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents:commit`, {
      method: 'POST',
      signal: effectiveSignal,
      headers: { authorization: `Bearer ${idToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ writes }),
    });
    if (!response.ok) throw new Error(`Firestore history write failed (${response.status})`);
  } finally {
    cleanup();
  }
}

export async function readUsageHistoryRest(
  projectId: string,
  idToken: string,
  uid: string,
  deviceId: string,
  providerId: string,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<UsageHistorySnapshot | undefined> {
  const url = restDocumentUrl(projectId, historyDocPath(uid, deviceId, providerId));
  const { signal: effectiveSignal, cleanup } = composeSignal(signal, 15_000);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: effectiveSignal,
      headers: { authorization: `Bearer ${idToken}`, accept: 'application/json' },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Firestore history read failed (${response.status})`);
    const payload = await response.json() as { fields?: Record<string, FirestoreValue> };
    if (!payload.fields) throw new Error('Firestore history document is missing fields');
    const summary = parseHistorySummary(decodeMap(payload.fields));
    if (summary.userId !== uid || summary.deviceId !== deviceId || summary.providerId !== providerId) throw new Error('history identity mismatch');
    if (!('storageVersion' in summary)) return summary;
    if (summary.chunkCount === 0) return assembleUsageHistory(summary, []);
    const chunksResponse = await fetchImpl(`${url}/historyChunks?pageSize=${HISTORY_MAX_CHUNKS}`, {
      method: 'GET',
      signal: effectiveSignal,
      headers: { authorization: `Bearer ${idToken}`, accept: 'application/json' },
    });
    if (!chunksResponse.ok) throw new Error(`Firestore history chunks read failed (${chunksResponse.status})`);
    const page = await chunksResponse.json() as { documents?: Array<{ fields?: Record<string, FirestoreValue> }>; nextPageToken?: string };
    if (page.nextPageToken) throw new Error('history chunks exceed bounds');
    return assembleUsageHistory(summary, (page.documents ?? []).map(d => decodeMap(d.fields ?? {})));
  } finally {
    cleanup();
  }
}

export async function readProviderPreferencesRest(
  projectId: string,
  idToken: string,
  uid: string,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<ProviderPreference[]> {
  const url = restDocumentUrl(projectId, `users/${encodeURIComponent(uid)}/preferences`);
  const { signal: effectiveSignal, cleanup } = composeSignal(signal);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: effectiveSignal,
      headers: {
        authorization: `Bearer ${idToken}`,
        accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Firestore preferences read failed (${response.status})`);
    }
    const payload = (await response.json()) as {
      documents?: Array<{
        name?: string;
        fields?: Record<string, FirestoreValue>;
      }>;
      nextPageToken?: string;
    };
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some((key) => !['documents', 'nextPageToken'].includes(key))) {
      throw new Error('invalid Firestore preferences payload');
    }
    if (payload.nextPageToken !== undefined && (typeof payload.nextPageToken !== 'string' || payload.nextPageToken.length > 0)) {
      throw new Error('preferences response incomplete or exceeds bounds');
    }
    const docs = Object.hasOwn(payload, 'documents') ? payload.documents : [];
    if (!Array.isArray(docs)) {
      throw new Error('invalid Firestore preferences documents');
    }
    if (docs.length > KNOWN_PROVIDER_FAMILIES.length) {
      throw new Error('preferences collection exceeds known families bound');
    }

    const expectedPrefix = `projects/${projectId}/databases/(default)/documents/users/${uid}/preferences/`;
    const seenFamilies = new Set<string>();
    const preferences: ProviderPreference[] = [];

    for (const doc of docs) {
      if (!doc || typeof doc !== 'object' || !doc.fields || typeof doc.fields !== 'object') {
        throw new Error('invalid Firestore preference document structure');
      }
      if (typeof doc.name !== 'string' || !doc.name.startsWith(expectedPrefix)) {
        throw new Error('preference document resource name mismatch');
      }
      const docFamily = doc.name.slice(expectedPrefix.length);
      const parsed = parseProviderPreference(decodeMap(doc.fields));
      if (parsed.userId !== uid) {
        throw new Error('preference UID does not match requested UID');
      }
      if (parsed.family !== docFamily) {
        throw new Error('preference document ID does not match family');
      }
      if (seenFamilies.has(parsed.family)) {
        throw new Error(`duplicate preference family: ${parsed.family}`);
      }
      seenFamilies.add(parsed.family);
      preferences.push(parsed);
    }
    return preferences;
  } finally {
    cleanup();
  }
}

function requireResetTimestampShadow(value: unknown, expectedIso: string, label: string): void {
  if (!(value instanceof Date) || value.getTime() !== Date.parse(expectedIso)) {
    throw new Error(`${label} timestamp shadow mismatch`);
  }
}

function resetRequestFromCloud(value: Record<string, unknown>, now: number | Date): ResetCommandRequestRecord {
  // Cloud reads must preserve an expired request so the runtime can reject it and refresh inventory.
  // Use the request's own requestedAt only as a structural-validation clock; runResetCommandSync
  // re-validates freshness against the trusted current clock before any action.
  const commandRow = value.command && typeof value.command === 'object' && !Array.isArray(value.command)
    ? value.command as Record<string, unknown>
    : undefined;
  const requestedAtMs = typeof commandRow?.requestedAt === 'string' ? Date.parse(commandRow.requestedAt) : Number.NaN;
  const structuralClock = Number.isFinite(requestedAtMs) ? requestedAtMs : now;
  const parsed = parseResetCommandRequestRecord({
    version: value.version, browserId: value.browserId, producerPublicKey: value.producerPublicKey,
    leaseExpiresAt: value.leaseExpiresAt, command: value.command,
  }, structuralClock);
  requireResetTimestampShadow(value.requestedAtTimestamp, parsed.command.requestedAt, 'request requestedAt');
  requireResetTimestampShadow(value.leaseExpiresAtTimestamp, parsed.leaseExpiresAt, 'request leaseExpiresAt');
  return parsed;
}

function resetInventoryFromCloud(value: Record<string, unknown>, now: number | Date): ResetInventoryEnvelope {
  const parsed = parseResetInventoryEnvelope({
    version: value.version, type: value.type, publicKey: value.publicKey, signature: value.signature, inventory: value.inventory,
  }, now);
  requireResetTimestampShadow(value.observedAtTimestamp, parsed.inventory.observedAt, 'inventory observedAt');
  requireResetTimestampShadow(value.expiresAtTimestamp, parsed.inventory.expiresAt, 'inventory expiresAt');
  return parsed;
}

export async function readResetCommandRequestRest(
  projectId: string,
  idToken: string,
  uid: string,
  deviceId: string,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
  now: number | Date = Date.now(),
): Promise<ResetCommandRequestRecord | undefined> {
  const relativePath = resetRequestDocPath(uid, deviceId);
  const url = restDocumentUrl(projectId, relativePath);
  const { signal: effectiveSignal, cleanup } = composeSignal(signal, 15_000);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: effectiveSignal,
      headers: { authorization: `Bearer ${idToken}`, accept: 'application/json' },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Firestore request read failed (${response.status})`);
    const payload = (await response.json()) as { name?: string; fields?: Record<string, FirestoreValue> };
    if (!payload.fields) throw new Error('Firestore request document is missing fields');
    const expectedName = `projects/${projectId}/databases/(default)/documents/${relativePath}`;
    if (payload.name !== expectedName) throw new Error('request document path mismatch');
    const decoded = decodeMap(payload.fields);
    const parsed = resetRequestFromCloud(decoded, now);
    if (parsed.command.userId !== uid || parsed.command.targetDeviceId !== deviceId) {
      throw new Error('request identity mismatch');
    }
    return parsed;
  } finally {
    cleanup();
  }
}

export async function readResetInventoryRest(
  projectId: string,
  idToken: string,
  uid: string,
  deviceId: string,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
  now: number | Date = Date.now(),
): Promise<ResetInventoryEnvelope | undefined> {
  const relativePath = resetInventoryDocPath(uid, deviceId);
  const url = restDocumentUrl(projectId, relativePath);
  const { signal: effectiveSignal, cleanup } = composeSignal(signal, 15_000);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: effectiveSignal,
      headers: { authorization: `Bearer ${idToken}`, accept: 'application/json' },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Firestore inventory read failed (${response.status})`);
    const payload = (await response.json()) as { name?: string; fields?: Record<string, FirestoreValue> };
    if (!payload.fields) throw new Error('Firestore inventory document is missing fields');
    const expectedName = `projects/${projectId}/databases/(default)/documents/${relativePath}`;
    if (payload.name !== expectedName) throw new Error('inventory document path mismatch');
    const decoded = decodeMap(payload.fields);
    const parsed = resetInventoryFromCloud(decoded, now);
    if (parsed.inventory.userId !== uid || parsed.inventory.targetDeviceId !== deviceId) {
      throw new Error('inventory identity mismatch');
    }
    return parsed;
  } finally {
    cleanup();
  }
}

export async function deleteResetInventoryRest(
  projectId: string,
  idToken: string,
  uid: string,
  deviceId: string,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<void> {
  const relativePath = resetInventoryDocPath(uid, deviceId);
  const url = restDocumentUrl(projectId, relativePath);
  const { signal: effectiveSignal, cleanup } = composeSignal(signal, 15_000);
  try {
    const response = await fetchImpl(url, {
      method: 'DELETE',
      signal: effectiveSignal,
      headers: { authorization: `Bearer ${idToken}` },
    });
    if (!response.ok && response.status !== 404) throw new Error(`Firestore inventory delete failed (${response.status})`);
  } finally {
    cleanup();
  }
}

export async function writeResetInventoryRest(
  projectId: string,
  idToken: string,
  envelope: ResetInventoryEnvelope,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
  expectedUid?: string,
  now: number | Date = Date.now(),
): Promise<void> {
  const parsed = parseResetInventoryEnvelope(envelope, now);
  if (expectedUid && parsed.inventory.userId !== expectedUid) {
    throw new Error('auth UID does not match inventory UID');
  }
  const relativePath = resetInventoryDocPath(parsed.inventory.userId, parsed.inventory.targetDeviceId);
  const url = restDocumentUrl(projectId, relativePath);
  const { signal: effectiveSignal, cleanup } = composeSignal(signal, 15_000);
  try {
    const response = await fetchImpl(url, {
      method: 'PATCH',
      signal: effectiveSignal,
      headers: {
        authorization: `Bearer ${idToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ fields: encodeMap({
        ...(parsed as unknown as Record<string, unknown>),
        observedAtTimestamp: new Date(parsed.inventory.observedAt),
        expiresAtTimestamp: new Date(parsed.inventory.expiresAt),
      }) }),
    });
    if (!response.ok) throw new Error(`Firestore inventory write failed (${response.status})`);
  } finally {
    cleanup();
  }
}

export async function writeResetResultRest(
  projectId: string,
  idToken: string,
  receipt: ResetCommandReceipt,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
  expectedUid?: string,
): Promise<void> {
  const parsed = parseResetCommandReceipt(receipt);
  if (expectedUid && parsed.userId !== expectedUid) {
    throw new Error('auth UID does not match receipt UID');
  }
  const relativePath = resetResultDocPath(parsed.userId, parsed.targetDeviceId, parsed.commandId);
  const url = restDocumentUrl(projectId, relativePath);
  const { signal: effectiveSignal, cleanup } = composeSignal(signal, 15_000);
  try {
    const response = await fetchImpl(url, {
      method: 'PATCH',
      signal: effectiveSignal,
      headers: {
        authorization: `Bearer ${idToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ fields: encodeMap(parsed as unknown as Record<string, unknown>) }),
    });
    if (!response.ok) throw new Error(`Firestore result write failed (${response.status})`);
  } finally {
    cleanup();
  }
}

function sameResetReceiptIdentity(a: ResetCommandReceipt, b: ResetCommandReceipt): boolean {
  return a.publicKey === b.publicKey &&
    a.backendId === b.backendId &&
    a.userId === b.userId &&
    a.targetDeviceId === b.targetDeviceId &&
    a.accountId === b.accountId &&
    a.commandId === b.commandId &&
    a.idempotencyKey === b.idempotencyKey &&
    a.creditId === b.creditId &&
    a.executedAt === b.executedAt;
}

function sameResetReceiptSemantics(a: ResetCommandReceipt, b: ResetCommandReceipt): boolean {
  if (a.type !== b.type || !sameResetReceiptIdentity(a, b)) return false;
  if (a.type === 'executing' && b.type === 'executing') return true;
  if (a.type !== 'terminal' || b.type !== 'terminal') return false;
  return JSON.stringify(a.result) === JSON.stringify(b.result);
}

async function writeResetReceiptIdempotent(
  projectId: string,
  idToken: string,
  receipt: ResetCommandReceipt,
  fetchImpl: FetchLike,
  signal: AbortSignal | undefined,
  expectedUid: string | undefined,
): Promise<void> {
  const parsed = parseResetCommandReceipt(receipt);
  const existing = await readResetResultRest(
    projectId, idToken, parsed.userId, parsed.targetDeviceId, parsed.commandId, fetchImpl, signal,
  );
  if (existing) {
    if (sameResetReceiptSemantics(existing, parsed)) return;
    if (!(existing.type === 'executing' && parsed.type === 'terminal' && sameResetReceiptIdentity(existing, parsed))) {
      throw new Error('reset_result_conflict');
    }
  }
  await writeResetResultRest(projectId, idToken, parsed, fetchImpl, signal, expectedUid);
}

export async function writeResetExecutingResultRest(
  projectId: string,
  idToken: string,
  receipt: ResetExecutingReceipt,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
  expectedUid?: string,
): Promise<void> {
  if (receipt.type !== 'executing') throw new Error('invalid_receipt_type');
  return writeResetReceiptIdempotent(projectId, idToken, receipt, fetchImpl, signal, expectedUid);
}

export async function writeResetTerminalResultRest(
  projectId: string,
  idToken: string,
  receipt: ResetTerminalReceipt,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
  expectedUid?: string,
): Promise<void> {
  if (receipt.type !== 'terminal') throw new Error('invalid_receipt_type');
  return writeResetReceiptIdempotent(projectId, idToken, receipt, fetchImpl, signal, expectedUid);
}

export async function readResetResultRest(
  projectId: string,
  idToken: string,
  uid: string,
  deviceId: string,
  commandId: string,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<ResetCommandReceipt | undefined> {
  const relativePath = resetResultDocPath(uid, deviceId, commandId);
  const url = restDocumentUrl(projectId, relativePath);
  const { signal: effectiveSignal, cleanup } = composeSignal(signal, 15_000);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: effectiveSignal,
      headers: { authorization: `Bearer ${idToken}`, accept: 'application/json' },
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Firestore result read failed (${response.status})`);
    const payload = (await response.json()) as { name?: string; fields?: Record<string, FirestoreValue> };
    if (!payload.fields) throw new Error('Firestore result document is missing fields');
    const expectedName = `projects/${projectId}/databases/(default)/documents/${relativePath}`;
    if (payload.name !== expectedName) throw new Error('result document path mismatch');
    const decoded = decodeMap(payload.fields);
    const parsed = parseResetCommandReceipt(decoded);
    if (parsed.userId !== uid || parsed.targetDeviceId !== deviceId || parsed.commandId !== commandId) {
      throw new Error('result identity mismatch');
    }
    return parsed;
  } finally {
    cleanup();
  }
}
