import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseUsageSnapshot, type DeviceHealthSnapshot, type UsageHistorySnapshot, type UsageSnapshot } from '@94ai/core';
import { readUsageHistoryRest, writeDeviceHealthRest, writeUsageHistoryRest, writeUsageSnapshotRest } from '@94ai/firebase';
import { normalizeOpenUsageLimits, readLegacyUsageHistory, type ProviderHistoryInput } from '@94ai/openusage';
import { createAuthenticatedFirebaseContext, type AgentAuthConfig, type AuthenticatedFirebaseContext } from './auth';
import { MacOSKeychainCredentialStore, type CredentialStore } from './credential-store';
import { getOrCreateDeviceId } from './device-id';
import { buildHistorySnapshot, mergeHistory } from './history-sync';
import { backgroundSyncInstalled } from './background';
import { readPreferredLimits } from './engine-select';

const SENSITIVE_KEY = /^(?:access[_-]?token|refresh[_-]?token|api[_-]?key|cookie|prompt|response|sessions|raw[_-]?session|session[_-]?(?:log|data))$/i;
const SENSITIVE_TEXT = /(?:\bBearer\s+\S+|\/(?:Users|home)\/[^\s"']+|(?:access|refresh)[_-]?token\s*[=:]\s*\S+)/i;

function assertNoSensitiveMaterial(value: unknown, trail = 'snapshot'): void {
  if (typeof value === 'string') {
    if (SENSITIVE_TEXT.test(value)) throw new Error(`sensitive material detected at ${trail}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveMaterial(item, `${trail}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`sensitive field detected: ${key}`);
    assertNoSensitiveMaterial(item, `${trail}.${key}`);
  }
}

export function serializeSafeSnapshot(input: unknown): string {
  assertNoSensitiveMaterial(input);
  return JSON.stringify(parseUsageSnapshot(input));
}

export function formatSafeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\/(?:Users|home)\/[^\s"']+/g, '[local-path]')
    .replace(/((?:access|refresh)[_-]?token\s*[=:]\s*)\S+/gi, '$1[redacted]')
    .slice(0, 300);
}

export interface SyncDependencies {
  now: () => Date;
  getDeviceId: () => Promise<string>;
  getAuthContext: () => Promise<AuthenticatedFirebaseContext>;
  fetchLimits: () => Promise<unknown>;
  writeSnapshot: (auth: AuthenticatedFirebaseContext, snapshot: UsageSnapshot) => Promise<void>;
  fetchHistory?: () => Promise<ProviderHistoryInput[]>;
  readHistory?: (auth: AuthenticatedFirebaseContext, providerId: string, deviceId: string) => Promise<UsageHistorySnapshot | undefined>;
  writeHistory?: (auth: AuthenticatedFirebaseContext, snapshot: UsageHistorySnapshot) => Promise<void>;
  backgroundReady?: () => Promise<boolean>;
  writeHealth?: (auth: AuthenticatedFirebaseContext, snapshot: DeviceHealthSnapshot) => Promise<void>;
}

export interface SyncResult {
  providerCount: number;
  historyProviderCount: number;
  syncedAt: string;
  historyErrorCode?: 'history_source_unavailable' | 'history_write_failed';
}

export async function runSyncWithDependencies(deps: SyncDependencies): Promise<SyncResult> {
  const auth = await deps.getAuthContext();
  try {
    const deviceId = await deps.getDeviceId();
    const syncedAt = deps.now().toISOString();
    const raw = await deps.fetchLimits();
    const snapshots = normalizeOpenUsageLimits(raw, { userId: auth.uid, deviceId, syncedAt });
    for (const snapshot of snapshots) {
      const safe = parseUsageSnapshot(JSON.parse(serializeSafeSnapshot(snapshot)) as unknown);
      await deps.writeSnapshot(auth, safe);
    }

    let historyProviderCount = 0;
    let historyErrorCode: SyncResult['historyErrorCode'];
    if (deps.fetchHistory && deps.readHistory && deps.writeHistory) {
      try {
        const incoming = await deps.fetchHistory();
        for (const provider of incoming) {
          try {
            const next = buildHistorySnapshot(provider, { userId: auth.uid, deviceId, syncedAt });
            const previous = await deps.readHistory(auth, provider.providerId, deviceId);
            await deps.writeHistory(auth, mergeHistory(previous, next));
            historyProviderCount += 1;
          } catch {
            historyErrorCode = 'history_write_failed';
          }
        }
      } catch {
        historyErrorCode = 'history_source_unavailable';
      }
    }
    if (deps.writeHealth) {
      try {
        const background = deps.backgroundReady ? await deps.backgroundReady() : false;
        const providerWarningCount = snapshots.filter((snapshot) => Boolean(snapshot.errorSummary)).length;
        const health: DeviceHealthSnapshot = {
          schemaVersion: 1,
          userId: auth.uid,
          deviceId,
          updatedAt: syncedAt,
          engine: 'ready',
          background: background ? 'ready' : 'missing',
          sync: 'ready',
          providerReadyCount: snapshots.length - providerWarningCount,
          providerWarningCount,
        };
        await deps.writeHealth(auth, health);
      } catch {
        // Health is advisory. Never make a successful quota sync fail because health reporting failed.
      }
    }
    return { providerCount: snapshots.length, historyProviderCount, syncedAt, ...(historyErrorCode ? { historyErrorCode } : {}) };
  } finally {
    await auth.close();
  }
}

function statusPath(): string {
  return path.join(os.homedir(), '.config', '94ai-usage-dashboard', 'last-sync.json');
}

async function writeLastSync(result: SyncResult): Promise<void> {
  const file = statusPath();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(result)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export async function runSync(
  config: AgentAuthConfig,
  store: CredentialStore = new MacOSKeychainCredentialStore(),
): Promise<SyncResult> {
  const result = await runSyncWithDependencies({
    now: () => new Date(),
    getDeviceId: () => getOrCreateDeviceId(),
    getAuthContext: () => createAuthenticatedFirebaseContext(config, store),
    fetchLimits: () => readPreferredLimits(),
    writeSnapshot: (auth, snapshot) => writeUsageSnapshotRest(config.firebase.projectId, auth.idToken, snapshot),
    fetchHistory: () => readLegacyUsageHistory(),
    readHistory: (auth, providerId, deviceId) => readUsageHistoryRest(config.firebase.projectId, auth.idToken, auth.uid, deviceId, providerId),
    writeHistory: (auth, snapshot) => writeUsageHistoryRest(config.firebase.projectId, auth.idToken, snapshot),
    backgroundReady: () => backgroundSyncInstalled(),
    writeHealth: (auth, snapshot) => writeDeviceHealthRest(config.firebase.projectId, auth.idToken, snapshot),
  });
  await writeLastSync(result);
  return result;
}
