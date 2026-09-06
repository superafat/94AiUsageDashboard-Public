import { describe, expect, it } from 'vitest';
import { readUsageHistoryRest, writeUsageHistoryRest, writeUsageSnapshotRest } from './rest';

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
      expect(payload.writes).toHaveLength(8);
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

  it('returns undefined when no previous history document exists', async () => {
    const fakeRead = async () => new Response('{}', { status: 404 });
    await expect(readUsageHistoryRest('demo', 'firebase-id-token', 'alice', 'device-1', 'codex', fakeRead)).resolves.toBeUndefined();
  });

});
