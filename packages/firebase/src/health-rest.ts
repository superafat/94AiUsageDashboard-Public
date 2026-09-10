import { parseDeviceHealthSnapshot, type DeviceHealthSnapshot } from '@94ai/core';
import { healthDocPath } from './paths';
import { composeSignal, type FetchLike } from './rest';

type FirestoreValue = Record<string, unknown>;

function encodeValue(value: unknown): FirestoreValue {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('health contains non-finite number');
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (value && typeof value === 'object') return { mapValue: { fields: encodeMap(value as Record<string, unknown>) } };
  throw new Error('health contains unsupported value');
}

function encodeMap(value: Record<string, unknown>): Record<string, FirestoreValue> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, encodeValue(item)]));
}

function documentUrl(projectId: string, path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${encoded}`;
}

export async function writeDeviceHealthRest(
  projectId: string,
  idToken: string,
  snapshot: DeviceHealthSnapshot,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<void> {
  const parsed = parseDeviceHealthSnapshot(snapshot);
  const url = documentUrl(projectId, healthDocPath(parsed.userId, parsed.deviceId));
  const { signal: effectiveSignal, cleanup } = composeSignal(signal, 15_000);
  try {
    const response = await fetchImpl(url, {
      method: 'PATCH',
      signal: effectiveSignal,
      headers: { authorization: `Bearer ${idToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ fields: encodeMap(parsed as unknown as Record<string, unknown>) }),
    });
    if (!response.ok) throw new Error(`Firestore health write failed (${response.status})`);
  } finally {
    cleanup();
  }
}
