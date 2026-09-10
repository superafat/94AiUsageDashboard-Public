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

import { SENSITIVE_PATTERN } from '@94ai/core';

const SENSITIVE_KEY = /^(?:access[_-]?token|refresh[_-]?token|api[_-]?key|cookie|prompt|response|sessions|raw[_-]?session|session[_-]?(?:log|data))$/i;
const SENSITIVE_TEXT = SENSITIVE_PATTERN;

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
    .replace(/\/(?:Users|home|var|tmp|etc|opt|private)\/[^\s"']+/g, '[local-path]')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{20,}\b|\bgithub_pat_[a-zA-Z0-9_]{30,}\b/g, '[redacted-token]')
    .replace(/\b(?:sk-(?:ant-|proj-)?[a-zA-Z0-9_-]{10,}|AIza[0-9A-Za-z-_]{35})\b/g, '[redacted-key]')
    .replace(/((?:access|refresh)[_-]?token\s*[=:]\s*)\S+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key)\s*[=:]\s*)\S+/gi, '$1[redacted]')
    .slice(0, 300);
}


const DEFAULT_TIMEOUT_MS = 15_000;

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`${label} timed out after ${ms}ms`));
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([operation(controller.signal), timeoutPromise]);
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface SyncDependencies {
  now: () => Date;
  getDeviceId: (signal?: AbortSignal) => Promise<string>;
  getAuthContext: (signal?: AbortSignal) => Promise<AuthenticatedFirebaseContext>;
  fetchLimits: (signal?: AbortSignal) => Promise<unknown>;
  writeSnapshot: (auth: AuthenticatedFirebaseContext, snapshot: UsageSnapshot, signal?: AbortSignal) => Promise<void>;
  fetchHistory?: (signal?: AbortSignal) => Promise<ProviderHistoryInput[]>;
  readHistory?: (auth: AuthenticatedFirebaseContext, providerId: string, deviceId: string, signal?: AbortSignal) => Promise<UsageHistorySnapshot | undefined>;
  writeHistory?: (auth: AuthenticatedFirebaseContext, snapshot: UsageHistorySnapshot, signal?: AbortSignal) => Promise<void>;
  backgroundReady?: (signal?: AbortSignal) => Promise<boolean>;
  writeHealth?: (auth: AuthenticatedFirebaseContext, snapshot: DeviceHealthSnapshot, signal?: AbortSignal) => Promise<void>;
  timeoutMs?: number;
}

export interface SyncResult {
  providerCount: number;
  historyProviderCount: number;
  syncedAt: string;
  historyErrorCode?: 'history_source_unavailable' | 'history_write_failed';
  providerErrorCode?: 'provider_write_failed';
  failedProviders?: string[];
  partialFailure?: boolean;
}

export async function runSyncWithDependencies(deps: SyncDependencies): Promise<SyncResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const auth = await withTimeout((signal) => deps.getAuthContext(signal), timeoutMs, 'getAuthContext');
  try {
    const deviceId = await withTimeout((signal) => deps.getDeviceId(signal), timeoutMs, 'getDeviceId');
    const syncedAt = deps.now().toISOString();
    const raw = await withTimeout((signal) => deps.fetchLimits(signal), timeoutMs, 'fetchLimits');
    const snapshots = normalizeOpenUsageLimits(raw, { userId: auth.uid, deviceId, syncedAt });

    let providerSuccessCount = 0;
    const failedProviders: string[] = [];
    const successfulSnapshots: UsageSnapshot[] = [];

    for (const snapshot of snapshots) {
      try {
        const safe = parseUsageSnapshot(JSON.parse(serializeSafeSnapshot(snapshot)) as unknown);
        await withTimeout((signal) => deps.writeSnapshot(auth, safe, signal), timeoutMs, `writeSnapshot(${snapshot.providerId})`);
        providerSuccessCount += 1;
        successfulSnapshots.push(safe);
      } catch {
        failedProviders.push(snapshot.providerId);
      }
    }

    let historyProviderCount = 0;
    let historyErrorCode: SyncResult['historyErrorCode'];
    if (deps.fetchHistory && deps.readHistory && deps.writeHistory) {
      try {
        const incoming = await withTimeout((signal) => deps.fetchHistory!(signal), timeoutMs, 'fetchHistory');
        for (const provider of incoming) {
          try {
            const next = buildHistorySnapshot(provider, { userId: auth.uid, deviceId, syncedAt });
            const previous = await withTimeout((signal) => deps.readHistory!(auth, provider.providerId, deviceId, signal), timeoutMs, `readHistory(${provider.providerId})`);
            await withTimeout((signal) => deps.writeHistory!(auth, mergeHistory(previous, next), signal), timeoutMs, `writeHistory(${provider.providerId})`);
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
        const background = deps.backgroundReady ? await withTimeout((signal) => deps.backgroundReady!(signal), timeoutMs, 'backgroundReady') : false;
        const providerWarningCount = successfulSnapshots.filter((snapshot) => Boolean(snapshot.errorSummary)).length;
        const healthSyncState: DeviceHealthSnapshot['sync'] = failedProviders.length > 0
          ? (providerSuccessCount > 0 ? 'warning' : 'error')
          : 'ready';
        const health: DeviceHealthSnapshot = {
          schemaVersion: 1,
          userId: auth.uid,
          deviceId,
          updatedAt: syncedAt,
          engine: 'ready',
          background: background ? 'ready' : 'missing',
          sync: healthSyncState,
          providerReadyCount: providerSuccessCount - providerWarningCount,
          providerWarningCount,
        };
        await withTimeout((signal) => deps.writeHealth!(auth, health, signal), timeoutMs, 'writeHealth');
      } catch {
        // Health is advisory. Never make a successful quota sync fail because health reporting failed.
      }
    }
    const hasProviderFailures = failedProviders.length > 0;
    return {
      providerCount: providerSuccessCount,
      historyProviderCount,
      syncedAt,
      ...(hasProviderFailures ? { providerErrorCode: 'provider_write_failed' as const, failedProviders } : {}),
      ...(hasProviderFailures && providerSuccessCount > 0 ? { partialFailure: true } : {}),
      ...(historyErrorCode ? { historyErrorCode } : {}),
    };
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
    writeSnapshot: (auth, snapshot, signal) => writeUsageSnapshotRest(config.firebase.projectId, auth.idToken, snapshot, fetch, signal),
    fetchHistory: () => readLegacyUsageHistory(),
    readHistory: (auth, providerId, deviceId, signal) => readUsageHistoryRest(config.firebase.projectId, auth.idToken, auth.uid, deviceId, providerId, fetch, signal),
    writeHistory: (auth, snapshot, signal) => writeUsageHistoryRest(config.firebase.projectId, auth.idToken, snapshot, fetch, signal),
    backgroundReady: () => backgroundSyncInstalled(),
    writeHealth: (auth, snapshot, signal) => writeDeviceHealthRest(config.firebase.projectId, auth.idToken, snapshot, fetch, signal),
  });
  await writeLastSync(result);
  return result;
}
