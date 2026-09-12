import { describe, expect, it } from 'vitest';
import { readProviderPreferencesRest, readUsageHistoryRest, writeUsageHistoryRest, writeUsageSnapshotRest } from './rest';

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
