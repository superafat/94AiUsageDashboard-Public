import { describe, expect, it } from 'vitest';
import { formatSafeError, runSyncWithDependencies, serializeSafeSnapshot } from './sync';

const snapshot = {
  schemaVersion: 1,
  userId: 'alice',
  deviceId: 'device-1',
  providerId: 'codex',
  fetchedAt: '2026-09-05T10:00:00.000Z',
  syncedAt: '2026-09-05T10:00:05.000Z',
  expiresAt: '2026-09-05T10:05:00.000Z',
  stale: false,
  resources: { session: { kind: 'consumption', unit: 'percent', remaining: 51 } },
};

describe('agent privacy boundary', () => {
  for (const key of ['access_token', 'refresh_token', 'apiKey', 'cookie', 'prompt', 'response', 'sessions']) {
    it(`rejects secret-bearing field ${key}`, () => {
      expect(() => serializeSafeSnapshot({ ...snapshot, [key]: 'secret-value' })).toThrow(/sensitive|unknown field/i);
    });
  }

  it('rejects local absolute paths in uploadable strings', () => {
    const syntheticPath = ['/', 'Users', 'alice', 'private', 'file'].join('/');
    expect(() => serializeSafeSnapshot({ ...snapshot, errorSummary: syntheticPath })).toThrow(/sensitive/i);
  });



  it('normalizes and writes only the authenticated user snapshots', async () => {
    const writes: Array<{ uid: string; providerId: string }> = [];
    const result = await runSyncWithDependencies({
      now: () => new Date('2026-09-05T10:00:05.000Z'),
      getDeviceId: async () => 'device-1',
      getAuthContext: async () => ({ uid: 'alice', idToken: 'firebase-id-token', close: async () => undefined }),
      fetchLimits: async () => ({
        schema: 'openusage.limits.v1',
        providers: {
          codex: {
            fetchedAt: '2026-09-05T10:00:00.000Z',
            expiresAt: '2026-09-05T10:05:00.000Z',
            stale: false,
            resources: { session: { kind: 'consumption', unit: 'percent', remaining: 51 } },
          },
        },
        errors: [],
      }),
      writeSnapshot: async (auth, item) => { writes.push({ uid: auth.uid, providerId: item.providerId }); expect(auth.idToken).toBe('firebase-id-token'); },
    });
    expect(result.providerCount).toBe(1);
    expect(writes).toEqual([{ uid: 'alice', providerId: 'codex' }]);
  });

  it('redacts secrets and local paths from error text', () => {
    const syntheticHome = ['/', 'Users', 'alice'].join('/');
    const safe = formatSafeError(new Error(`Bearer abc123 at ${syntheticHome}/private/file`));
    expect(safe).not.toContain('abc123');
    expect(safe).not.toContain(syntheticHome);
  });

  it('best-effort syncs usage history without blocking quota snapshots', async () => {
    const historyWrites: unknown[] = [];
    const deps = {
      now: () => new Date('2026-09-06T10:00:05.000Z'),
      getDeviceId: async () => 'device-1',
      getAuthContext: async () => ({ uid: 'alice', idToken: 'firebase-id-token', close: async () => undefined }),
      fetchLimits: async () => ({ schema: 'openusage.limits.v1', providers: { codex: {
        fetchedAt: '2026-09-06T10:00:00.000Z', expiresAt: '2026-09-06T10:05:00.000Z', stale: false,
        resources: { session: { kind: 'consumption', unit: 'percent', remaining: 51 } },
      } }, errors: [] }),
      writeSnapshot: async () => undefined,
      fetchHistory: async () => [{ providerId: 'codex', periods: { today: { tokens: 100, estimatedCostUsd: 1 } }, daily: [{ date: '2026-09-06', tokens: 100, estimatedCostUsd: 1, finalized: false }] }],
      readHistory: async () => undefined,
      writeHistory: async (_auth: unknown, item: unknown) => { historyWrites.push(item); },
    };
    const result = await runSyncWithDependencies(deps);
    expect(result).toMatchObject({ providerCount: 1, historyProviderCount: 1 });
    expect(historyWrites).toHaveLength(1);
  });

  it('keeps quota sync successful when the optional history source fails', async () => {
    const result = await runSyncWithDependencies({
      now: () => new Date('2026-09-06T10:00:05.000Z'),
      getDeviceId: async () => 'device-1',
      getAuthContext: async () => ({ uid: 'alice', idToken: 'firebase-id-token', close: async () => undefined }),
      fetchLimits: async () => ({ schema: 'openusage.limits.v1', providers: { codex: {
        fetchedAt: '2026-09-06T10:00:00.000Z', expiresAt: '2026-09-06T10:05:00.000Z', stale: false,
        resources: { session: { kind: 'consumption', unit: 'percent', remaining: 51 } },
      } }, errors: [] }),
      writeSnapshot: async () => undefined,
      fetchHistory: async () => { throw new Error('legacy history unavailable'); },
      readHistory: async () => undefined,
      writeHistory: async () => { throw new Error('should not write'); },
    });
    expect(result).toMatchObject({ providerCount: 1, historyProviderCount: 0 });
  });


  it('writes a minimal device health snapshot after successful quota sync', async () => {
    const health: unknown[] = [];
    const result = await runSyncWithDependencies({
      now: () => new Date('2026-09-06T10:00:05.000Z'),
      getDeviceId: async () => 'device-health',
      getAuthContext: async () => ({ uid: 'alice', idToken: 'firebase-id-token', close: async () => undefined }),
      fetchLimits: async () => ({ schema: 'openusage.limits.v1', providers: {
        codex: { fetchedAt: '2026-09-06T10:00:00.000Z', expiresAt: '2026-09-06T10:05:00.000Z', stale: false, resources: { session: { kind: 'consumption', unit: 'percent', remaining: 51 } } },
        claude: { fetchedAt: '2026-09-06T10:00:00.000Z', expiresAt: '2026-09-06T10:05:00.000Z', stale: false, resources: {} },
      }, errors: [{ providerId: 'claude', message: 'not logged in' }] }),
      writeSnapshot: async () => undefined,
      backgroundReady: async () => true,
      writeHealth: async (_auth, snapshot) => { health.push(snapshot); },
    });
    expect(result.providerCount).toBe(2);
    expect(health).toEqual([{ schemaVersion: 1, userId: 'alice', deviceId: 'device-health', updatedAt: '2026-09-06T10:00:05.000Z', engine: 'ready', background: 'ready', sync: 'ready', providerReadyCount: 1, providerWarningCount: 1 }]);
  });

  it('does not fail quota sync when optional health reporting fails', async () => {
    await expect(runSyncWithDependencies({
      now: () => new Date('2026-09-06T10:00:05.000Z'), getDeviceId: async () => 'device-health',
      getAuthContext: async () => ({ uid: 'alice', idToken: 'firebase-id-token', close: async () => undefined }),
      fetchLimits: async () => ({ schema: 'openusage.limits.v1', providers: {}, errors: [] }), writeSnapshot: async () => undefined,
      backgroundReady: async () => false, writeHealth: async () => { throw new Error('health unavailable'); },
    })).resolves.toMatchObject({ providerCount: 0 });
  });

});
