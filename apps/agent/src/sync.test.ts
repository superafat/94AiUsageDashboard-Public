import { describe, expect, it } from 'vitest';
import { formatSafeError, formatSyncStatus, runSyncWithDependencies, serializeSafeSnapshot } from './sync';

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
    expect(() => serializeSafeSnapshot({ ...snapshot, errorSummary: syntheticPath })).toThrow(/sensitive|errorSummary/i);
  });

  it('rejects synthetic GitHub tokens and API keys in uploadable strings', () => {
    expect(() => serializeSafeSnapshot({ ...snapshot, errorSummary: ['ghp', '123456789012345678901234567890'].join('_') })).toThrow(/sensitive|errorSummary/i);
    expect(() => serializeSafeSnapshot({ ...snapshot, errorSummary: ['github', 'pat', '11AAAAAAA0123456789012345678901234567890'].join('_') })).toThrow(/sensitive|errorSummary/i);
    expect(() => serializeSafeSnapshot({ ...snapshot, errorSummary: ['sk', 'ant', 'api03', '12345678901234567890'].join('-') })).toThrow(/sensitive|errorSummary/i);
    expect(() => serializeSafeSnapshot({ ...snapshot, plan: ['ghp', '123456789012345678901234567890'].join('_') })).toThrow(/sensitive/i);
  });

  it('rejects arbitrary upstream prose in persisted provider errorSummary', () => {
    expect(() => serializeSafeSnapshot({ ...snapshot, errorSummary: 'random upstream stack trace and detailed error text' })).toThrow(/sensitive|errorSummary/i);
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

  it('isolates per-provider write failures, allowing other providers and history to succeed', async () => {
    const writtenSnapshots: string[] = [];
    const writtenHistory: string[] = [];
    const healthSnapshots: unknown[] = [];

    const result = await runSyncWithDependencies({
      now: () => new Date('2026-09-06T10:00:05.000Z'),
      getDeviceId: async () => 'device-1',
      getAuthContext: async () => ({ uid: 'alice', idToken: 'firebase-id-token', close: async () => undefined }),
      fetchLimits: async () => ({
        schema: 'openusage.limits.v1',
        providers: {
          codex: {
            fetchedAt: '2026-09-06T10:00:00.000Z', expiresAt: '2026-09-06T10:05:00.000Z', stale: false,
            resources: { session: { kind: 'consumption', unit: 'percent', remaining: 50 } },
          },
          claude: {
            fetchedAt: '2026-09-06T10:00:00.000Z', expiresAt: '2026-09-06T10:05:00.000Z', stale: false,
            resources: { session: { kind: 'consumption', unit: 'percent', remaining: 80 } },
          },
        },
        errors: [],
      }),
      writeSnapshot: async (_auth, snapshot) => {
        if (snapshot.providerId === 'codex') {
          throw new Error('Firestore write failed for codex');
        }
        writtenSnapshots.push(snapshot.providerId);
      },
      fetchHistory: async () => [
        {
          providerId: 'claude',
          periods: { today: { tokens: 500, estimatedCostUsd: 0.5 } },
          daily: [{ date: '2026-09-06', tokens: 500, estimatedCostUsd: 0.5, finalized: false }],
        },
      ],
      readHistory: async () => undefined,
      writeHistory: async (_auth, snapshot) => {
        writtenHistory.push(snapshot.providerId);
      },
      backgroundReady: async () => true,
      writeHealth: async (_auth, snapshot) => {
        healthSnapshots.push(snapshot);
      },
    });

    // Claude quota was written even though Codex write threw
    expect(writtenSnapshots).toEqual(['claude']);
    // History sync for claude also executed
    expect(writtenHistory).toEqual(['claude']);
    // Truthful partial failure reporting in result
    expect(result.providerCount).toBe(1);
    expect(result.historyProviderCount).toBe(1);
    expect(result.providerErrorCode).toBe('provider_write_failed');
    expect(result.failedProviders).toEqual(['codex']);
    expect(result.partialFailure).toBe(true);
    // Health snapshot truthfully reports warning status for sync
    expect(healthSnapshots).toHaveLength(1);
    expect(healthSnapshots[0]).toMatchObject({
      sync: 'warning',
      providerReadyCount: 1,
    });
  });

  it('bounds network operations with a timeout and avoids blind write retries', async () => {
    let writeAttempts = 0;
    const result = await runSyncWithDependencies({
      now: () => new Date('2026-09-06T10:00:05.000Z'),
      getDeviceId: async () => 'device-timeout',
      getAuthContext: async () => ({ uid: 'alice', idToken: 'firebase-id-token', close: async () => undefined }),
      fetchLimits: async () => ({
        schema: 'openusage.limits.v1',
        providers: {
          slowProvider: {
            fetchedAt: '2026-09-06T10:00:00.000Z', expiresAt: '2026-09-06T10:05:00.000Z', stale: false,
            resources: { session: { kind: 'consumption', unit: 'percent', remaining: 50 } },
          },
        },
        errors: [],
      }),
      // Hanging writeSnapshot
      writeSnapshot: async () => {
        writeAttempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 500));
      },
      timeoutMs: 50,
    });

    expect(result.providerCount).toBe(0);
    expect(result.providerErrorCode).toBe('provider_write_failed');
    expect(result.failedProviders).toEqual(['slowProvider']);
    // Exactly one attempt — no blind retry loops
    expect(writeAttempts).toBe(1);
  });

  it('passes AbortSignal to network writes and aborts it on timeout, which fake fetch observes', async () => {
    let observedSignal: AbortSignal | undefined;
    let fetchAborted = false;
    let authClosedWhileUnaborted = false;
    let authClosed = false;

    const result = await runSyncWithDependencies({
      now: () => new Date('2026-09-06T10:00:05.000Z'),
      getDeviceId: async () => 'device-test',
      getAuthContext: async () => ({
        uid: 'alice',
        idToken: 'firebase-id-token',
        close: async () => {
          authClosed = true;
          if (observedSignal && !observedSignal.aborted) {
            authClosedWhileUnaborted = true;
          }
        },
      }),
      fetchLimits: async () => ({
        schema: 'openusage.limits.v1',
        providers: {
          codex: {
            fetchedAt: '2026-09-06T10:00:00.000Z', expiresAt: '2026-09-06T10:05:00.000Z', stale: false,
            resources: { session: { kind: 'consumption', unit: 'percent', remaining: 50 } },
          },
        },
        errors: [],
      }),
      writeSnapshot: async (_auth, _snapshot, signal) => {
        observedSignal = signal;
        if (signal) {
          signal.addEventListener('abort', () => { fetchAborted = true; });
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      },
      timeoutMs: 50,
    });

    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(fetchAborted).toBe(true);
    expect(authClosed).toBe(true);
    expect(authClosedWhileUnaborted).toBe(false);
    expect(result.failedProviders).toEqual(['codex']);
  });

  it('bounds getAuthContext in bounded timeout', async () => {
    await expect(runSyncWithDependencies({
      now: () => new Date(),
      getDeviceId: async () => 'device-1',
      getAuthContext: async () => new Promise((resolve) => setTimeout(resolve, 500)),
      fetchLimits: async () => ({ schema: 'openusage.limits.v1', providers: {}, errors: [] }),
      writeSnapshot: async () => undefined,
      timeoutMs: 50,
    })).rejects.toThrow(/getAuthContext timed out/);
  });

  it('bounds getDeviceId in bounded timeout and closes auth context', async () => {
    let authClosed = false;
    await expect(runSyncWithDependencies({
      now: () => new Date(),
      getDeviceId: async () => new Promise((resolve) => setTimeout(resolve, 500)),
      getAuthContext: async () => ({ uid: 'alice', idToken: 'token', close: async () => { authClosed = true; } }),
      fetchLimits: async () => ({ schema: 'openusage.limits.v1', providers: {}, errors: [] }),
      writeSnapshot: async () => undefined,
      timeoutMs: 50,
    })).rejects.toThrow(/getDeviceId timed out/);
    expect(authClosed).toBe(true);
  });

  it('bounds coordinator waiting for non-cancellable local dependencies', async () => {
    const start = Date.now();
    await expect(runSyncWithDependencies({
      now: () => new Date(),
      getDeviceId: async () => 'device-1',
      getAuthContext: async () => ({ uid: 'alice', idToken: 'token', close: async () => undefined }),
      fetchLimits: async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return { schema: 'openusage.limits.v1', providers: {}, errors: [] };
      },
      writeSnapshot: async () => undefined,
      timeoutMs: 50,
    })).rejects.toThrow(/fetchLimits timed out/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(300);
  });

  it('reads authenticated preferences before publishing and filters disabled families', async () => {
    const writtenSnapshots: string[] = [];
    const writtenHistory: string[] = [];

    const result = await runSyncWithDependencies({
      now: () => new Date('2026-09-05T10:00:05.000Z'),
      getDeviceId: async () => 'device-1',
      getAuthContext: async () => ({ uid: 'alice', idToken: 'token', close: async () => undefined }),
      fetchPreferences: async () => [
        { schemaVersion: 1, userId: 'alice', family: 'codex', enabled: false, updatedAt: '2026-09-10T10:00:00Z' },
        { schemaVersion: 1, userId: 'alice', family: 'claude', enabled: true, updatedAt: '2026-09-10T10:00:00Z' },
      ],
      fetchLimits: async () => ({
        schema: 'openusage.limits.v1',
        providers: {
          codex: {
            fetchedAt: '2026-09-05T10:00:00.000Z',
            expiresAt: '2026-09-05T10:05:00.000Z',
            stale: false,
            resources: { session: { kind: 'consumption', unit: 'percent', remaining: 51 } },
          },
          claude: {
            fetchedAt: '2026-09-05T10:00:00.000Z',
            expiresAt: '2026-09-05T10:05:00.000Z',
            stale: false,
            resources: { session: { kind: 'consumption', unit: 'percent', remaining: 80 } },
          },
        },
        errors: [],
      }),
      writeSnapshot: async (_auth, item) => { writtenSnapshots.push(item.providerId); },
      fetchHistory: async () => [
        { providerId: 'codex', periods: { today: { tokens: 100 } }, daily: [] },
        { providerId: 'claude', periods: { today: { tokens: 200 } }, daily: [] },
      ],
      readHistory: async () => undefined,
      writeHistory: async (_auth, item) => { writtenHistory.push(item.providerId); },
    });

    expect(result.providerCount).toBe(1);
    expect(writtenSnapshots).toEqual(['claude']);
    expect(writtenHistory).toEqual(['claude']);
  });

  it('keeps default-three behavior when preference collection is empty and added providers are disabled', async () => {
    const writtenSnapshots: string[] = [];

    const result = await runSyncWithDependencies({
      now: () => new Date('2026-09-05T10:00:05.000Z'),
      getDeviceId: async () => 'device-1',
      getAuthContext: async () => ({ uid: 'alice', idToken: 'token', close: async () => undefined }),
      fetchPreferences: async () => [],
      fetchLimits: async () => ({
        schema: 'openusage.limits.v1',
        providers: {
          codex: {
            fetchedAt: '2026-09-05T10:00:00.000Z',
            expiresAt: '2026-09-05T10:05:00.000Z',
            stale: false,
            resources: { session: { kind: 'consumption', unit: 'percent', remaining: 51 } },
          },
          cursor: {
            fetchedAt: '2026-09-05T10:00:00.000Z',
            expiresAt: '2026-09-05T10:05:00.000Z',
            stale: false,
            resources: { session: { kind: 'consumption', unit: 'percent', remaining: 90 } },
          },
        },
        errors: [],
      }),
      writeSnapshot: async (_auth, item) => { writtenSnapshots.push(item.providerId); },
    });

    // Codex is in default-three (enabled), Cursor is added provider (default disabled)
    expect(result.providerCount).toBe(1);
    expect(writtenSnapshots).toEqual(['codex']);
  });

  it('suppresses publishing with diagnostic when preference read fails and no cache exists', async () => {
    const writtenSnapshots: string[] = [];

    const result = await runSyncWithDependencies({
      now: () => new Date('2026-09-05T10:00:05.000Z'),
      getDeviceId: async () => 'device-1',
      getAuthContext: async () => ({ uid: 'alice', idToken: 'token', close: async () => undefined }),
      fetchPreferences: async () => { throw new Error('Network error reading preferences'); },
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
      writeSnapshot: async (_auth, item) => { writtenSnapshots.push(item.providerId); },
    });

    // Must NOT silently publish potentially disabled providers
    expect(writtenSnapshots).toEqual([]);
    expect(result.providerCount).toBe(0);
    expect(result.preferenceErrorCode).toBe('preferences_read_failed');
  });

  it('never calls fetchLimits or writeSnapshot when preference read fails', async () => {
    let fetchLimitsCalled = false;
    let writeSnapshotCalled = false;
    let fetchHistoryCalled = false;

    const result = await runSyncWithDependencies({
      now: () => new Date('2026-09-05T10:00:05.000Z'),
      getDeviceId: async () => 'device-1',
      getAuthContext: async () => ({ uid: 'alice', idToken: 'token', close: async () => undefined }),
      fetchPreferences: async () => { throw new Error('Firestore preferences unavailable'); },
      fetchLimits: async () => {
        fetchLimitsCalled = true;
        return { schema: 'openusage.limits.v1', providers: {}, errors: [] };
      },
      writeSnapshot: async () => { writeSnapshotCalled = true; },
      fetchHistory: async () => {
        fetchHistoryCalled = true;
        return [];
      },
      readHistory: async () => undefined,
      writeHistory: async () => undefined,
    });

    expect(fetchLimitsCalled).toBe(false);
    expect(writeSnapshotCalled).toBe(false);
    expect(fetchHistoryCalled).toBe(false);
    expect(result.providerCount).toBe(0);
    expect(result.historyProviderCount).toBe(0);
    expect(result.preferenceErrorCode).toBe('preferences_read_failed');
  });

  it('rejects preferences with mismatched UID and refuses to sync or publish', async () => {
    let fetchLimitsCalled = false;
    const writtenSnapshots: string[] = [];

    const result = await runSyncWithDependencies({
      now: () => new Date('2026-09-05T10:00:05.000Z'),
      getDeviceId: async () => 'device-1',
      getAuthContext: async () => ({ uid: 'alice', idToken: 'token', close: async () => undefined }),
      fetchPreferences: async () => [
        // Wrong UID: 'bob' instead of authenticated 'alice'
        { schemaVersion: 1, userId: 'bob', family: 'codex', enabled: true, updatedAt: '2026-09-10T10:00:00.000Z' },
      ],
      fetchLimits: async () => {
        fetchLimitsCalled = true;
        return {
          schema: 'openusage.limits.v1',
          providers: {
            codex: {
              fetchedAt: '2026-09-05T10:00:00.000Z',
              expiresAt: '2026-09-05T10:05:00.000Z',
              stale: false,
              resources: { session: { kind: 'consumption', unit: 'percent', remaining: 50 } },
            },
          },
          errors: [],
        };
      },
      writeSnapshot: async (_auth, item) => { writtenSnapshots.push(item.providerId); },
    });

    expect(fetchLimitsCalled).toBe(false);
    expect(writtenSnapshots).toEqual([]);
    expect(result.providerCount).toBe(0);
    expect(result.preferenceErrorCode).toBe('preferences_read_failed');
  });
});

it('does not describe a preference-read failure as a completed sync', () => {
  const message = formatSyncStatus({providerCount: 0, historyProviderCount: 0, syncedAt: '2026-09-10T00:00:00.000Z', preferenceErrorCode: 'preferences_read_failed', partialFailure: true});
  expect(message).toContain('資料來源設定讀取失敗');
  expect(message).not.toContain('同步完成');
});

it('triggers push notification sync and isolates push errors from quota sync', async () => {
  let pushCalled = false;
  const result = await runSyncWithDependencies({
    now: () => new Date('2026-09-05T10:00:05.000Z'),
    getDeviceId: async () => 'device-1',
    getAuthContext: async () => ({ uid: 'alice', idToken: 'token', close: async () => undefined }),
    fetchLimits: async () => ({
      schema: 'openusage.limits.v1',
      providers: {
        codex: {
          fetchedAt: '2026-09-05T10:00:00.000Z',
          expiresAt: '2026-09-05T10:05:00.000Z',
          stale: false,
          resources: { session: { kind: 'consumption', unit: 'percent', remaining: 50 } },
        },
      },
      errors: [],
    }),
    writeSnapshot: async () => undefined,
    syncPushNotifications: async () => {
      pushCalled = true;
      throw new Error('keys_failed');
    },
  });

  expect(pushCalled).toBe(true);
  expect(result.providerCount).toBe(1);
  expect(result.pushErrorCode).toBe('push_keys_failed');
});
