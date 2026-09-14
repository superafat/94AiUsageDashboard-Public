import { describe, expect, it } from 'vitest';
import {
  decodeValue,
  deleteResetInventoryRest,
  encodeMap,
  encodeValue,
  readProviderPreferencesRest,
  readResetCommandRequestRest,
  readResetInventoryRest,
  readResetResultRest,
  readUsageHistoryRest,
  writeResetExecutingResultRest,
  writeResetInventoryRest,
  writeResetResultRest,
  writeResetTerminalResultRest,
  writeUsageHistoryRest,
  writeUsageSnapshotRest,
} from './rest';
import type {
  ResetCommandRequestRecord,
  ResetExecutingReceipt,
  ResetInventoryEnvelope,
  ResetTerminalReceipt,
} from '@94ai/core';

const snapshot = {
  schemaVersion: 1 as const, userId: 'alice', deviceId: 'device-1', providerId: 'codex',
  fetchedAt: '2026-09-05T10:00:00.000Z', syncedAt: '2026-09-05T10:00:05.000Z',
  expiresAt: '2026-09-05T10:05:00.000Z', stale: false,
  resources: { weekly: { kind: 'consumption' as const, unit: 'percent', remaining: 48 } },
};

describe('writeUsageSnapshotRest', () => {
  it('writes a canonical snapshot with a Firebase ID token through Firestore REST', async () => {
    let seen: { url?: string; auth?: string; body?: string } = {};
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization');
      seen = { url: String(input), ...(auth ? { auth } : {}), body: String(init?.body ?? '') };
      return new Response('{}', { status: 200 });
    };
    await writeUsageSnapshotRest('demo', 'firebase-id-token', snapshot, fakeFetch);
    expect(seen.url).toContain('/projects/demo/databases/(default)/documents/users/alice/devices/device-1/providers/codex');
    expect(seen.auth).toBe('Bearer firebase-id-token');
    expect(seen.body).toContain('schemaVersion');
    expect(seen.body).toContain('weekly');
  });

  it('atomically commits and reads a full canonical history with a user token', async () => {
    const history = {
      schemaVersion: 1 as const, userId: 'alice', deviceId: 'device-1', providerId: 'codex',
      syncedAt: '2026-09-06T00:00:00.000Z', currency: 'USD' as const,
      periods: { today: { tokens: 100, estimatedCostUsd: 1.5 } },
      daily: Array.from({ length: 35 }, (_, i) => ({ date: new Date(Date.UTC(2026, 7, 3 + i)).toISOString().slice(0,10), tokens: i + 100, estimatedCostUsd: i / 10, finalized: i < 34 })),
    };
    type Write = { update?: { name: string; fields: Record<string, unknown> }; delete?: string };
    const documents = new Map<string, { name: string; fields: Record<string, unknown> }>();
    let requests = 0;
    const fakeWrite = async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toMatch(/documents:commit$/);
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer firebase-id-token');
      const payload = JSON.parse(String(init?.body)) as { writes: Write[] };
      expect(payload.writes).toHaveLength(37);
      for (const write of payload.writes) {
        if (write.update) documents.set(write.update.name, write.update);
        if (write.delete) documents.delete(write.delete);
      }
      requests++;
      return new Response('{}', { status: 200 });
    };
    await writeUsageHistoryRest('demo', 'firebase-id-token', history, fakeWrite);
    expect(requests).toBe(1);
    expect(documents.size).toBe(8);
    const fakeRead = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/historyChunks')) return new Response(JSON.stringify({ documents: [...documents.values()].filter(d => d.name.includes('/historyChunks/')) }), { status: 200 });
      const name = decodeURIComponent(url.pathname.slice('/v1/'.length));
      return new Response(JSON.stringify(documents.get(name)), { status: 200 });
    };
    await expect(readUsageHistoryRest('demo', 'firebase-id-token', 'alice', 'device-1', 'codex', fakeRead)).resolves.toEqual(history);
  });

  it('reads a 180-day history (36 chunks) via REST using appropriate pageSize query limit', async () => {
    const history180 = {
      schemaVersion: 1 as const, userId: 'alice', deviceId: 'device-1', providerId: 'codex',
      syncedAt: '2026-09-12T00:00:00.000Z', currency: 'USD' as const,
      periods: { today: { tokens: 100, estimatedCostUsd: 1.5 } },
      daily: Array.from({ length: 180 }, (_, i) => ({
        date: new Date(Date.UTC(2026, 2, 16 + i)).toISOString().slice(0, 10),
        tokens: i + 100,
        estimatedCostUsd: i / 10,
        finalized: i < 179,
      })),
    };
    type Write = { update?: { name: string; fields: Record<string, unknown> }; delete?: string };
    const documents = new Map<string, { name: string; fields: Record<string, unknown> }>();
    const fakeWrite = async (_input: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { writes: Write[] };
      for (const write of payload.writes) {
        if (write.update) documents.set(write.update.name, write.update);
        if (write.delete) documents.delete(write.delete);
      }
      return new Response('{}', { status: 200 });
    };
    await writeUsageHistoryRest('demo', 'firebase-id-token', history180, fakeWrite);

    const fakeRead = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/historyChunks')) {
        const pageSize = Number(url.searchParams.get('pageSize') ?? '10');
        const chunkDocs = [...documents.values()].filter((d) => d.name.includes('/historyChunks/')).slice(0, pageSize);
        return new Response(JSON.stringify({ documents: chunkDocs }), { status: 200 });
      }
      const name = decodeURIComponent(url.pathname.slice('/v1/'.length));
      return new Response(JSON.stringify(documents.get(name)), { status: 200 });
    };

    await expect(readUsageHistoryRest('demo', 'firebase-id-token', 'alice', 'device-1', 'codex', fakeRead)).resolves.toEqual(history180);
  });

  it('returns undefined when no previous history document exists', async () => {
    const fakeRead = async () => new Response('{}', { status: 404 });
    await expect(readUsageHistoryRest('demo', 'firebase-id-token', 'alice', 'device-1', 'codex', fakeRead)).resolves.toBeUndefined();
  });

  it('honors caller AbortSignal and aborts in-flight fetch in writeUsageSnapshotRest', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const fakeFetch = async (_input: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_, reject) => {
        if (init?.signal) {
          init.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    };

    const writePromise = writeUsageSnapshotRest('demo', 'firebase-id-token', snapshot, fakeFetch, controller.signal);
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(false);

    controller.abort();
    await expect(writePromise).rejects.toThrow();
    expect(observedSignal?.aborted).toBe(true);
  });

  it('honors caller AbortSignal in writeUsageHistoryRest and passes to fetch', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const fakeFetch = async (_input: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_, reject) => {
        if (init?.signal) {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }
      });
    };

    const history = {
      schemaVersion: 1 as const, userId: 'alice', deviceId: 'device-1', providerId: 'codex',
      syncedAt: '2026-09-06T00:00:00.000Z', currency: 'USD' as const,
      periods: {},
      daily: [],
    };

    const writePromise = writeUsageHistoryRest('demo', 'firebase-id-token', history, fakeFetch, controller.signal);
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(false);
    controller.abort();
    await expect(writePromise).rejects.toThrow();
    expect(observedSignal?.aborted).toBe(true);
  });

  it('reads provider preferences via REST', async () => {
    const pref = {
      schemaVersion: 1 as const,
      userId: 'alice',
      family: 'cursor',
      enabled: true,
      updatedAt: '2026-09-10T10:00:00.000Z',
    };

    const fakeListFetch = async () => new Response(JSON.stringify({
      documents: [
        {
          name: 'projects/demo/databases/(default)/documents/users/alice/preferences/cursor',
          fields: {
            schemaVersion: { integerValue: '1' },
            userId: { stringValue: 'alice' },
            family: { stringValue: 'cursor' },
            enabled: { booleanValue: true },
            updatedAt: { stringValue: '2026-09-10T10:00:00.000Z' },
          },
        },
      ],
    }), { status: 200 });
    const result = await readProviderPreferencesRest('demo', 'token-1', 'alice', fakeListFetch);
    expect(result).toEqual([pref]);

    const fakeNotFound = async () => new Response('{}', { status: 404 });
    await expect(readProviderPreferencesRest('demo', 'token-1', 'alice', fakeNotFound)).rejects.toThrow(/404/);
    const fakeEmpty = async () => new Response('{}', { status: 200 });
    expect(await readProviderPreferencesRest('demo', 'token-1', 'alice', fakeEmpty)).toEqual([]);
  });

  it('rejects malformed disabled Codex preference rather than silently swallowing into empty success', async () => {
    const malformedFetch = async () => new Response(JSON.stringify({
      documents: [
        {
          name: 'projects/demo/databases/(default)/documents/users/alice/preferences/codex',
          fields: {
            schemaVersion: { integerValue: '1' },
            userId: { stringValue: 'alice' },
            family: { stringValue: 'codex' },
            enabled: { stringValue: 'false' }, // malformed: string instead of boolean
            updatedAt: { stringValue: '2026-09-10T10:00:00.000Z' },
          },
        },
      ],
    }), { status: 200 });

    await expect(readProviderPreferencesRest('demo', 'token-1', 'alice', malformedFetch)).rejects.toThrow();
  });

  it('rejects wrong UID, mismatched resource path, and duplicate families in REST preferences', async () => {
    // Wrong UID in document body
    const wrongUidFetch = async () => new Response(JSON.stringify({
      documents: [
        {
          name: 'projects/demo/databases/(default)/documents/users/alice/preferences/cursor',
          fields: {
            schemaVersion: { integerValue: '1' },
            userId: { stringValue: 'bob' },
            family: { stringValue: 'cursor' },
            enabled: { booleanValue: true },
            updatedAt: { stringValue: '2026-09-10T10:00:00.000Z' },
          },
        },
      ],
    }), { status: 200 });
    await expect(readProviderPreferencesRest('demo', 'token-1', 'alice', wrongUidFetch)).rejects.toThrow(/UID/i);

    // Mismatched document resource path
    const wrongPathFetch = async () => new Response(JSON.stringify({
      documents: [
        {
          name: 'projects/demo/databases/(default)/documents/users/bob/preferences/cursor',
          fields: {
            schemaVersion: { integerValue: '1' },
            userId: { stringValue: 'alice' },
            family: { stringValue: 'cursor' },
            enabled: { booleanValue: true },
            updatedAt: { stringValue: '2026-09-10T10:00:00.000Z' },
          },
        },
      ],
    }), { status: 200 });
    await expect(readProviderPreferencesRest('demo', 'token-1', 'alice', wrongPathFetch)).rejects.toThrow();

    // Mismatched family vs document ID
    const mismatchedFamilyFetch = async () => new Response(JSON.stringify({
      documents: [
        {
          name: 'projects/demo/databases/(default)/documents/users/alice/preferences/cursor',
          fields: {
            schemaVersion: { integerValue: '1' },
            userId: { stringValue: 'alice' },
            family: { stringValue: 'codex' },
            enabled: { booleanValue: true },
            updatedAt: { stringValue: '2026-09-10T10:00:00.000Z' },
          },
        },
      ],
    }), { status: 200 });
    await expect(readProviderPreferencesRest('demo', 'token-1', 'alice', mismatchedFamilyFetch)).rejects.toThrow();

    // Duplicate family
    const duplicateFetch = async () => new Response(JSON.stringify({
      documents: [
        {
          name: 'projects/demo/databases/(default)/documents/users/alice/preferences/cursor',
          fields: {
            schemaVersion: { integerValue: '1' },
            userId: { stringValue: 'alice' },
            family: { stringValue: 'cursor' },
            enabled: { booleanValue: true },
            updatedAt: { stringValue: '2026-09-10T10:00:00.000Z' },
          },
        },
        {
          name: 'projects/demo/databases/(default)/documents/users/alice/preferences/cursor',
          fields: {
            schemaVersion: { integerValue: '1' },
            userId: { stringValue: 'alice' },
            family: { stringValue: 'cursor' },
            enabled: { booleanValue: false },
            updatedAt: { stringValue: '2026-09-10T10:00:01.000Z' },
          },
        },
      ],
    }), { status: 200 });
    await expect(readProviderPreferencesRest('demo', 'token-1', 'alice', duplicateFetch)).rejects.toThrow(/duplicate/i);
  });

  it('rejects incomplete responses when nextPageToken is present', async () => {
    const pagedFetch = async () => new Response(JSON.stringify({
      documents: [],
      nextPageToken: 'next-token-exceeds-bounds',
    }), { status: 200 });
    await expect(readProviderPreferencesRest('demo', 'token-1', 'alice', pagedFetch)).rejects.toThrow(/bounds|incomplete/i);
  });
});

it('rejects malformed preference payload shapes instead of enabling defaults', async () => {
  for (const payload of [[], { error: 'unexpected' }, { documents: null }, { documents: [], nextPageToken: 5 }]) {
    const fakeFetch = async () => new Response(JSON.stringify(payload), { status: 200 });
    await expect(readProviderPreferencesRest('demo', 'synthetic-token', 'alice', fakeFetch)).rejects.toThrow();
  }
});

describe('REST codec timestampValue support', () => {
  it('encodes Date to timestampValue and decodes timestampValue to Date with exact roundtrip', () => {
    const originalDate = new Date('2026-09-12T12:34:56.789Z');
    const encoded = encodeValue(originalDate);
    expect(encoded).toEqual({ timestampValue: '2026-09-12T12:34:56.789Z' });

    const decoded = decodeValue(encoded);
    expect(decoded).toBeInstanceOf(Date);
    expect((decoded as Date).toISOString()).toBe('2026-09-12T12:34:56.789Z');

    const reEncoded = encodeValue(decoded);
    expect(reEncoded).toEqual(encoded);
  });

  it('preserves string, number, boolean, null, and map decoding without weakening', () => {
    expect(encodeValue('2026-09-12T12:34:56.789Z')).toEqual({ stringValue: '2026-09-12T12:34:56.789Z' });
    expect(decodeValue({ stringValue: '2026-09-12T12:34:56.789Z' })).toBe('2026-09-12T12:34:56.789Z');
    expect(decodeValue({ integerValue: '42' })).toBe(42);
    expect(decodeValue({ doubleValue: 3.14 })).toBe(3.14);
    expect(decodeValue({ booleanValue: true })).toBe(true);
    expect(decodeValue({ nullValue: null })).toBe(null);
  });

  it('rejects invalid Date or invalid timestampValue strings', () => {
    expect(() => encodeValue(new Date('invalid'))).toThrow();
    expect(() => decodeValue({ timestampValue: 'not-an-iso-date' })).toThrow();
    expect(() => decodeValue({ timestampValue: 123 as unknown as string })).toThrow();
  });

  it('never reinterprets an ordinary map merely because its only key is timestampValue', () => {
    expect(encodeValue({ timestampValue: 'not-a-date' })).toEqual({
      mapValue: { fields: { timestampValue: { stringValue: 'not-a-date' } } },
    });
    expect(encodeValue({ timestampValue: '2026-09-12T00:00:00.000Z' })).toEqual({
      mapValue: { fields: { timestampValue: { stringValue: '2026-09-12T00:00:00.000Z' } } },
    });
  });

  it('rejects non-RFC3339 and impossible timestampValue dates', () => {
    expect(() => decodeValue({ timestampValue: '2026' })).toThrow();
    expect(() => decodeValue({ timestampValue: '2026-02-31T00:00:00.000Z' })).toThrow();
  });
});

describe('Reset command and inventory REST functions', () => {
  const publicKey = btoa(String.fromCharCode(4, ...new Array(64).fill(0))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const signature = btoa(String.fromCharCode(...new Array(64).fill(1))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const testNow = Date.parse('2026-09-12T12:00:00.000Z');

  const sampleRequest: ResetCommandRequestRecord = {
    version: 1,
    browserId: 'browser-1',
    producerPublicKey: publicKey,
    leaseExpiresAt: '2026-09-12T12:09:00.000Z',
    command: {
      version: 1,
      backendId: 'codex',
      userId: 'user-1',
      targetDeviceId: 'mac-1',
      accountId: 'acc-1',
      commandId: 'cmd-1',
      idempotencyKey: 'idem-cmd-1',
      creditId: 'credit-1',
      requestedAt: '2026-09-12T11:59:00.000Z',
      expiresAt: '2026-09-12T12:09:00.000Z',
    },
  };

  const sampleInventory: ResetInventoryEnvelope = {
    version: 1,
    type: 'inventory',
    publicKey,
    signature,
    inventory: {
      version: 1,
      backendId: 'codex',
      userId: 'user-1',
      targetDeviceId: 'mac-1',
      accountId: 'acc-1',
      observedAt: '2026-09-12T11:58:00.000Z',
      expiresAt: '2026-09-12T12:03:00.000Z',
      availableCount: 1,
      credits: [{ creditId: 'credit-1', expiresAt: '2026-09-15T00:00:00.000Z', status: 'available', resetType: 'codexRateLimits' }],
    },
  };

  const sampleExecutingReceipt: ResetExecutingReceipt = {
    version: 1,
    type: 'executing',
    publicKey,
    signature,
    backendId: 'codex',
    userId: 'user-1',
    targetDeviceId: 'mac-1',
    accountId: 'acc-1',
    commandId: 'cmd-1',
    idempotencyKey: 'idem-cmd-1',
    creditId: 'credit-1',
    executedAt: '2026-09-12T12:00:05.000Z',
  };

  const sampleTerminalReceipt: ResetTerminalReceipt = {
    version: 1,
    type: 'terminal',
    publicKey,
    signature,
    backendId: 'codex',
    userId: 'user-1',
    targetDeviceId: 'mac-1',
    accountId: 'acc-1',
    commandId: 'cmd-1',
    idempotencyKey: 'idem-cmd-1',
    creditId: 'credit-1',
    executedAt: '2026-09-12T12:00:05.000Z',
    result: {
      version: 1,
      backendId: 'codex',
      userId: 'user-1',
      targetDeviceId: 'mac-1',
      accountId: 'acc-1',
      commandId: 'cmd-1',
      idempotencyKey: 'idem-cmd-1',
      creditId: 'credit-1',
      state: 'success',
      code: 'reset',
      executedAt: '2026-09-12T12:00:05.000Z',
      completedAt: '2026-09-12T12:00:06.000Z',
    },
  };

  const requestFields = () => encodeMap({
    ...sampleRequest,
    requestedAtTimestamp: new Date(sampleRequest.command.requestedAt),
    leaseExpiresAtTimestamp: new Date(sampleRequest.leaseExpiresAt),
  });
  const inventoryFields = () => encodeMap({
    ...sampleInventory,
    observedAtTimestamp: new Date(sampleInventory.inventory.observedAt),
    expiresAtTimestamp: new Date(sampleInventory.inventory.expiresAt),
  });

  it('reads reset command request via REST with exact path and identity check', async () => {
    let requestedUrl = '';
    const fakeFetch = async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        name: 'projects/demo/databases/(default)/documents/users/user-1/devices/mac-1/resetControl/request',
        fields: requestFields(),
      }), { status: 200 });
    };

    const record = await readResetCommandRequestRest('demo', 'tok', 'user-1', 'mac-1', fakeFetch, undefined, testNow);
    expect(record).toEqual(sampleRequest);
    expect(requestedUrl).toContain('users/user-1/devices/mac-1/resetControl/request');

    // Expired leases must still be readable so the runtime can reject them and refresh inventory.
    const expiredRequest: ResetCommandRequestRecord = {
      ...sampleRequest,
      leaseExpiresAt: '2026-09-12T11:50:00.000Z',
      command: {
        ...sampleRequest.command,
        requestedAt: '2026-09-12T11:40:00.000Z',
        expiresAt: '2026-09-12T11:50:00.000Z',
      },
    };
    const expiredFields = encodeMap({
      ...expiredRequest,
      requestedAtTimestamp: new Date(expiredRequest.command.requestedAt),
      leaseExpiresAtTimestamp: new Date(expiredRequest.leaseExpiresAt),
    });
    const expiredFetch = async () => new Response(JSON.stringify({
      name: 'projects/demo/databases/(default)/documents/users/user-1/devices/mac-1/resetControl/request',
      fields: expiredFields,
    }), { status: 200 });
    await expect(readResetCommandRequestRest('demo', 'tok', 'user-1', 'mac-1', expiredFetch, undefined, testNow)).resolves.toEqual(expiredRequest);

    const missingShadowFetch = async () => new Response(JSON.stringify({
      name: 'projects/demo/databases/(default)/documents/users/user-1/devices/mac-1/resetControl/request',
      fields: encodeMap(sampleRequest as unknown as Record<string, unknown>),
    }), { status: 200 });
    await expect(readResetCommandRequestRest('demo', 'tok', 'user-1', 'mac-1', missingShadowFetch, undefined, testNow)).rejects.toThrow(/timestamp|shadow/i);

    const mismatchedShadowFetch = async () => {
      const fields = requestFields();
      fields.requestedAtTimestamp = encodeValue(new Date('2026-09-12T10:59:00.000Z'));
      return new Response(JSON.stringify({
        name: 'projects/demo/databases/(default)/documents/users/user-1/devices/mac-1/resetControl/request', fields,
      }), { status: 200 });
    };
    await expect(readResetCommandRequestRest('demo', 'tok', 'user-1', 'mac-1', mismatchedShadowFetch, undefined, testNow)).rejects.toThrow(/timestamp shadow mismatch/i);

    // Returns undefined on 404
    const notFoundFetch = async () => new Response('{}', { status: 404 });
    await expect(readResetCommandRequestRest('demo', 'tok', 'user-1', 'mac-1', notFoundFetch)).resolves.toBeUndefined();

    // Rejects identity mismatch
    const mismatchedFetch = async () => new Response(JSON.stringify({
      name: 'projects/demo/databases/(default)/documents/users/user-1/devices/mac-1/resetControl/request',
      fields: requestFields(),
    }), { status: 200 });
    await expect(readResetCommandRequestRest('demo', 'tok', 'user-wrong', 'mac-1', mismatchedFetch)).rejects.toThrow(/mismatch/i);

    const missingNameFetch = async () => new Response(JSON.stringify({
      fields: requestFields(),
    }), { status: 200 });
    await expect(readResetCommandRequestRest('demo', 'tok', 'user-1', 'mac-1', missingNameFetch, undefined, testNow)).rejects.toThrow(/path|name/i);
  });

  it('reads and writes reset inventory via REST with exact path and identity check', async () => {
    let writeUrl = '';
    let writeBody = '';
    const fakeWrite = async (input: string | URL | Request, init?: RequestInit) => {
      writeUrl = String(input);
      writeBody = String(init?.body ?? '');
      return new Response('{}', { status: 200 });
    };

    await writeResetInventoryRest('demo', 'tok', sampleInventory, fakeWrite, undefined, 'user-1', testNow);
    expect(writeUrl).toContain('users/user-1/devices/mac-1/resetControl/inventory');
    expect(JSON.parse(writeBody).fields.type.stringValue).toBe('inventory');
    expect(JSON.parse(writeBody).fields.observedAtTimestamp.timestampValue).toBe(sampleInventory.inventory.observedAt);
    expect(JSON.parse(writeBody).fields.expiresAtTimestamp.timestampValue).toBe(sampleInventory.inventory.expiresAt);

    // Reject expectedUid mismatch
    await expect(writeResetInventoryRest('demo', 'tok', sampleInventory, fakeWrite, undefined, 'wrong-uid', testNow)).rejects.toThrow();

    // Read inventory
    const fakeRead = async () => new Response(JSON.stringify({
      name: 'projects/demo/databases/(default)/documents/users/user-1/devices/mac-1/resetControl/inventory',
      fields: inventoryFields(),
    }), { status: 200 });
    const inv = await readResetInventoryRest('demo', 'tok', 'user-1', 'mac-1', fakeRead, undefined, testNow);
    expect(inv).toEqual(sampleInventory);

    const missingShadowRead = async () => new Response(JSON.stringify({
      name: 'projects/demo/databases/(default)/documents/users/user-1/devices/mac-1/resetControl/inventory',
      fields: encodeMap(sampleInventory as unknown as Record<string, unknown>),
    }), { status: 200 });
    await expect(readResetInventoryRest('demo', 'tok', 'user-1', 'mac-1', missingShadowRead, undefined, testNow)).rejects.toThrow(/timestamp shadow mismatch/i);

    const mismatchedShadowRead = async () => {
      const fields = inventoryFields();
      fields.expiresAtTimestamp = encodeValue(new Date('2026-09-12T12:02:00.000Z'));
      return new Response(JSON.stringify({
        name: 'projects/demo/databases/(default)/documents/users/user-1/devices/mac-1/resetControl/inventory', fields,
      }), { status: 200 });
    };
    await expect(readResetInventoryRest('demo', 'tok', 'user-1', 'mac-1', mismatchedShadowRead, undefined, testNow)).rejects.toThrow(/timestamp shadow mismatch/i);
  });

  it('deletes only the exact owner inventory path for command invalidation', async () => {
    let seenUrl = '';
    let seenMethod = '';
    const fakeDelete = async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      seenMethod = String(init?.method ?? '');
      return new Response('{}', { status: 200 });
    };
    await deleteResetInventoryRest('demo', 'tok', 'user-1', 'mac-1', fakeDelete);
    expect(seenMethod).toBe('DELETE');
    expect(seenUrl).toContain('users/user-1/devices/mac-1/resetControl/inventory');
    await expect(deleteResetInventoryRest('demo', 'tok', 'user/1', 'mac-1', fakeDelete)).rejects.toThrow(/segment/i);
  });

  it('treats semantically identical executing/terminal receipts as idempotent and rejects terminal conflicts', async () => {
    const otherSignature = btoa(String.fromCharCode(...new Array(64).fill(2))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const calls: string[] = [];
    const existingTerminal = { ...sampleTerminalReceipt, signature: otherSignature };
    const terminalAlreadyThere = async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(init?.method ?? 'GET'));
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({
          name: 'projects/demo/databases/(default)/documents/users/user-1/devices/mac-1/resetResults/cmd-1',
          fields: encodeMap(existingTerminal as unknown as Record<string, unknown>),
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };
    await writeResetTerminalResultRest('demo', 'tok', sampleTerminalReceipt, terminalAlreadyThere, undefined, 'user-1');
    expect(calls).toEqual(['GET']);

    calls.length = 0;
    const existingExecuting = { ...sampleExecutingReceipt, signature: otherSignature };
    const executingAlreadyThere = async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(init?.method ?? 'GET'));
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({
          name: 'projects/demo/databases/(default)/documents/users/user-1/devices/mac-1/resetResults/cmd-1',
          fields: encodeMap(existingExecuting as unknown as Record<string, unknown>),
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };
    await writeResetExecutingResultRest('demo', 'tok', sampleExecutingReceipt, executingAlreadyThere, undefined, 'user-1');
    expect(calls).toEqual(['GET']);

    calls.length = 0;
    await writeResetTerminalResultRest('demo', 'tok', sampleTerminalReceipt, executingAlreadyThere, undefined, 'user-1');
    expect(calls).toEqual(['GET', 'PATCH']);

    const conflictingTerminal = {
      ...sampleTerminalReceipt,
      signature: otherSignature,
      result: { ...sampleTerminalReceipt.result, state: 'failed' as const, code: 'noCredit' as const },
    };
    const conflictFetch = async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({
          name: 'projects/demo/databases/(default)/documents/users/user-1/devices/mac-1/resetResults/cmd-1',
          fields: encodeMap(conflictingTerminal as unknown as Record<string, unknown>),
        }), { status: 200 });
      }
      throw new Error('must_not_patch_conflicting_terminal');
    };
    await expect(writeResetTerminalResultRest('demo', 'tok', sampleTerminalReceipt, conflictFetch, undefined, 'user-1')).rejects.toThrow(/conflict/i);
  });

  it('writes executing and terminal results to exact commandId path via REST', async () => {
    let writeUrl = '';
    let writeBody = '';
    const fakeWrite = async (input: string | URL | Request, init?: RequestInit) => {
      writeUrl = String(input);
      writeBody = String(init?.body ?? '');
      if ((init?.method ?? 'GET') === 'GET') return new Response('{}', { status: 404 });
      return new Response('{}', { status: 200 });
    };

    // Write executing result
    await writeResetExecutingResultRest('demo', 'tok', sampleExecutingReceipt, fakeWrite, undefined, 'user-1');
    expect(writeUrl).toContain('users/user-1/devices/mac-1/resetResults/cmd-1');
    expect(JSON.parse(writeBody).fields.type.stringValue).toBe('executing');

    // Write terminal result
    await writeResetTerminalResultRest('demo', 'tok', sampleTerminalReceipt, fakeWrite, undefined, 'user-1');
    expect(writeUrl).toContain('users/user-1/devices/mac-1/resetResults/cmd-1');
    expect(JSON.parse(writeBody).fields.type.stringValue).toBe('terminal');

    // Write via generic writeResetResultRest
    await writeResetResultRest('demo', 'tok', sampleExecutingReceipt, fakeWrite, undefined, 'user-1');
    expect(writeUrl).toContain('users/user-1/devices/mac-1/resetResults/cmd-1');
    expect(JSON.parse(writeBody).fields.type.stringValue).toBe('executing');

    // Read result
    const fakeRead = async () => new Response(JSON.stringify({
      name: 'projects/demo/databases/(default)/documents/users/user-1/devices/mac-1/resetResults/cmd-1',
      fields: encodeMap(sampleTerminalReceipt as unknown as Record<string, unknown>),
    }), { status: 200 });
    const res = await readResetResultRest('demo', 'tok', 'user-1', 'mac-1', 'cmd-1', fakeRead);
    expect(res).toEqual(sampleTerminalReceipt);
  });
});
