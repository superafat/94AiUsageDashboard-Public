import { mkdir, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseProviderPreference, parseUsageSnapshot, providerFamilyOf, resolveFamilyEnabled, validateResetIdentifier, type DeviceHealthSnapshot, type ProviderPreference, type UsageHistorySnapshot, type UsageSnapshot } from '@94ai/core';
import {
  deleteResetInventoryRest,
  readProviderPreferencesRest,
  readResetCommandRequestRest,
  readUsageHistoryRest,
  writeDeviceHealthRest,
  writeResetExecutingResultRest,
  writeResetInventoryRest,
  writeResetTerminalResultRest,
  writeUsageHistoryRest,
  writeUsageSnapshotRest,
} from '@94ai/firebase';
import { normalizeOpenUsageLimits, readLegacyUsageHistory, type ProviderHistoryInput } from '@94ai/openusage';
import { createAuthenticatedFirebaseContext, type AgentAuthConfig, type AuthenticatedFirebaseContext } from './auth';
import { MacOSKeychainCredentialStore, type CredentialStore } from './credential-store';
import { getOrCreateDeviceId } from './device-id';
import { buildHistorySnapshot, mergeHistory } from './history-sync';
import { backgroundSyncInstalled } from './background';
import { readPreferredLimits } from './engine-select';
import { runPushNotificationSync } from './push-runtime';
import { getOrCreateLocalPushKeys } from './local-push-keys';
import { ResetCommandJournal } from './reset-command-journal';
import { CodexResetAdapter } from './codex-reset-adapter';
import { runResetCommandSync } from './reset-command-runtime';

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
  fetchPreferences?: (auth: AuthenticatedFirebaseContext, signal?: AbortSignal) => Promise<ProviderPreference[]>;
  fetchHistory?: (signal?: AbortSignal) => Promise<ProviderHistoryInput[]>;
  readHistory?: (auth: AuthenticatedFirebaseContext, providerId: string, deviceId: string, signal?: AbortSignal) => Promise<UsageHistorySnapshot | undefined>;
  writeHistory?: (auth: AuthenticatedFirebaseContext, snapshot: UsageHistorySnapshot, signal?: AbortSignal) => Promise<void>;
  backgroundReady?: (signal?: AbortSignal) => Promise<boolean>;
  writeHealth?: (auth: AuthenticatedFirebaseContext, snapshot: DeviceHealthSnapshot, signal?: AbortSignal) => Promise<void>;
  syncPushNotifications?: (
    auth: AuthenticatedFirebaseContext,
    deviceId: string,
    snapshots: UsageSnapshot[],
    preferences: ProviderPreference[],
    signal?: AbortSignal,
  ) => Promise<void>;
  syncResetCommands?: (
    auth: AuthenticatedFirebaseContext,
    deviceId: string,
    signal?: AbortSignal,
  ) => Promise<void>;
  timeoutMs?: number;
}

export interface SyncResult {
  providerCount: number;
  historyProviderCount: number;
  syncedAt: string;
  historyErrorCode?: 'history_source_unavailable' | 'history_write_failed';
  providerErrorCode?: 'provider_write_failed';
  preferenceErrorCode?: 'preferences_read_failed';
  pushErrorCode?: 'push_dispatch_failed' | 'push_keys_failed';
  resetCommandErrorCode?: 'reset_command_failed';
  failedProviders?: string[];
  partialFailure?: boolean;
}

export function formatSyncStatus(result: SyncResult): string {
  if (result.preferenceErrorCode) return '未同步：資料來源設定讀取失敗；保留既有資料，待下次重試。';
  const summary = `${result.providerCount} 個額度來源，${result.historyProviderCount} 個歷史來源，${result.syncedAt}`;
  if (result.partialFailure || result.providerErrorCode || result.historyErrorCode) return `同步部分完成：${summary}`;
  return `同步完成：${summary}`;
}

export async function runSyncWithDependencies(deps: SyncDependencies): Promise<SyncResult> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const auth = await withTimeout((signal) => deps.getAuthContext(signal), timeoutMs, 'getAuthContext');
  try {
    const deviceId = await withTimeout((signal) => deps.getDeviceId(signal), timeoutMs, 'getDeviceId');
    const syncedAt = deps.now().toISOString();

    let activePreferences: ProviderPreference[] | undefined;
    let preferenceErrorCode: SyncResult['preferenceErrorCode'];

    if (deps.fetchPreferences) {
      try {
        const fetched = await withTimeout((signal) => deps.fetchPreferences!(auth, signal), timeoutMs, 'fetchPreferences');
        if (!Array.isArray(fetched)) {
          throw new Error('fetchPreferences must return an array');
        }
        for (const p of fetched) {
          const parsed = parseProviderPreference(p);
          if (parsed.userId !== auth.uid) {
            throw new Error(`preference UID mismatch: ${parsed.userId} !== ${auth.uid}`);
          }
        }
        activePreferences = fetched;
      } catch {
        preferenceErrorCode = 'preferences_read_failed';
      }
    } else {
      activePreferences = [];
    }

    if (preferenceErrorCode) {
      return {
        providerCount: 0,
        historyProviderCount: 0,
        syncedAt,
        preferenceErrorCode,
        partialFailure: true,
      };
    }

    const preferencesMap: Record<string, boolean> = {};
    for (const p of activePreferences ?? []) {
      const parsed = parseProviderPreference(p);
      if (parsed.userId !== auth.uid) {
        return {
          providerCount: 0,
          historyProviderCount: 0,
          syncedAt,
          preferenceErrorCode: 'preferences_read_failed',
          partialFailure: true,
        };
      }
      preferencesMap[parsed.family] = parsed.enabled;
    }

    const raw = await withTimeout((signal) => deps.fetchLimits(signal), timeoutMs, 'fetchLimits');
    const snapshots = normalizeOpenUsageLimits(raw, { userId: auth.uid, deviceId, syncedAt });
    const eligibleSnapshots = deps.fetchPreferences
      ? snapshots.filter((snapshot) => {
          const family = providerFamilyOf(snapshot.providerId);
          return resolveFamilyEnabled(family, preferencesMap);
        })
      : snapshots;

    let providerSuccessCount = 0;
    const failedProviders: string[] = [];
    const successfulSnapshots: UsageSnapshot[] = [];

    for (const snapshot of eligibleSnapshots) {
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
        const eligibleHistory = deps.fetchPreferences
          ? incoming.filter((provider) => {
              const family = providerFamilyOf(provider.providerId);
              return resolveFamilyEnabled(family, preferencesMap);
            })
          : incoming;
        for (const provider of eligibleHistory) {
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
    let pushErrorCode: SyncResult['pushErrorCode'];
    if (deps.syncPushNotifications) {
      try {
        await withTimeout(
          (signal) => deps.syncPushNotifications!(auth, deviceId, successfulSnapshots, activePreferences ?? [], signal),
          timeoutMs,
          'syncPushNotifications',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pushErrorCode = msg.includes('keys') ? 'push_keys_failed' : 'push_dispatch_failed';
      }
    }
    let resetCommandErrorCode: SyncResult['resetCommandErrorCode'];
    if (deps.syncResetCommands) {
      try {
        await withTimeout(
          (signal) => deps.syncResetCommands!(auth, deviceId, signal),
          timeoutMs,
          'syncResetCommands',
        );
      } catch {
        resetCommandErrorCode = 'reset_command_failed';
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
      ...(pushErrorCode ? { pushErrorCode } : {}),
      ...(resetCommandErrorCode ? { resetCommandErrorCode } : {}),
    };
  } finally {
    await auth.close();
  }
}

export function isR3ResetConsumeAuthorized(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AI_USAGE_RESET_REAL_CONSUME_ENABLED === '1';
}

export async function hasUnresolvedResetJournalsForDevice(input: {
  journalDir: string;
  backendId: string;
  userId: string;
  deviceId: string;
}): Promise<boolean> {
  if (!fs.existsSync(input.journalDir)) return false;
  const rootStat = fs.lstatSync(input.journalDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('invalid_journal_root');
  for (const entry of fs.readdirSync(input.journalDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('invalid_account_journal_path');
    if (!entry.isDirectory()) continue;
    const accountDir = resolveResetJournalAccountDir(input.journalDir, entry.name);
    const journal = new ResetCommandJournal({
      rootDir: accountDir,
      backendId: input.backendId,
      userId: input.userId,
      deviceId: input.deviceId,
      accountId: entry.name,
    });
    if (await journal.hasUnresolvedReconciliation()) return true;
  }
  return false;
}

export function resolveResetJournalAccountDir(journalDir: string, accountId: string): string {
  const safeAccountId = validateResetIdentifier(accountId, 'account_id');
  if (safeAccountId === '.' || safeAccountId === '..') throw new Error('invalid_account_journal_path');
  const root = path.resolve(journalDir);
  const candidate = path.resolve(root, safeAccountId);
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) throw new Error('invalid_account_journal_path');
  return candidate;
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
    fetchPreferences: (auth, signal) => readProviderPreferencesRest(config.firebase.projectId, auth.idToken, auth.uid, fetch, signal),
    writeSnapshot: (auth, snapshot, signal) => writeUsageSnapshotRest(config.firebase.projectId, auth.idToken, snapshot, fetch, signal),
    fetchHistory: () => readLegacyUsageHistory(),
    readHistory: (auth, providerId, deviceId, signal) => readUsageHistoryRest(config.firebase.projectId, auth.idToken, auth.uid, deviceId, providerId, fetch, signal),
    writeHistory: (auth, snapshot, signal) => writeUsageHistoryRest(config.firebase.projectId, auth.idToken, snapshot, fetch, signal),
    backgroundReady: () => backgroundSyncInstalled(),
    writeHealth: (auth, snapshot, signal) => writeDeviceHealthRest(config.firebase.projectId, auth.idToken, snapshot, fetch, signal),
    syncPushNotifications: async (auth, deviceId, snapshots, preferences, signal) => {
      const pushRes = await runPushNotificationSync({
        backendId: config.firebase.projectId,
        userId: auth.uid,
        deviceId,
        projectId: config.firebase.projectId,
        idToken: auth.idToken,
        snapshots,
        preferences,
        ...(signal ? {signal} : {}),
      });
      if (pushRes.status === 'keys_failed') {
        throw new Error('keys_failed');
      }
      if (pushRes.status === 'error') {
        throw new Error('push_dispatch_failed');
      }
    },
    syncResetCommands: async (auth, deviceId, signal) => {
      const journalDir = path.join(os.homedir(), '.config', '94ai-usage-dashboard', 'journals');
      await runResetCommandSync({
        env: process.env,
        backendId: config.firebase.projectId,
        userId: auth.uid,
        deviceId,
        getLocalKeys: async () => {
          const res = await getOrCreateLocalPushKeys({
            backendId: config.firebase.projectId,
            userId: auth.uid,
            deviceId,
          });
          if (res.status !== 'ready' || !res.keys) {
            throw new Error('local_keys_unavailable');
          }
          return res.keys;
        },
        readRequest: (uid, devId, sig) =>
          readResetCommandRequestRest(config.firebase.projectId, auth.idToken, uid, devId, fetch, sig),
        writeInventory: (envelope, sig) =>
          writeResetInventoryRest(config.firebase.projectId, auth.idToken, envelope, fetch, sig, auth.uid),
        deleteInventory: (uid, devId, sig) =>
          deleteResetInventoryRest(config.firebase.projectId, auth.idToken, uid, devId, fetch, sig),
        writeExecutingResult: (receipt, sig) =>
          writeResetExecutingResultRest(config.firebase.projectId, auth.idToken, receipt, fetch, sig, auth.uid),
        writeTerminalResult: (receipt, sig) =>
          writeResetTerminalResultRest(config.firebase.projectId, auth.idToken, receipt, fetch, sig, auth.uid),
        hasGlobalUnresolved: () => hasUnresolvedResetJournalsForDevice({
          journalDir,
          backendId: config.firebase.projectId,
          userId: auth.uid,
          deviceId,
        }),
        allowProviderMutation: isR3ResetConsumeAuthorized(process.env),
        journal: (accountId: string) => {
          const accountDir = resolveResetJournalAccountDir(journalDir, accountId);
          if (!fs.existsSync(accountDir)) {
            fs.mkdirSync(accountDir, { recursive: true, mode: 0o700 });
          }
          return new ResetCommandJournal({
            rootDir: accountDir,
            backendId: config.firebase.projectId,
            userId: auth.uid,
            deviceId,
            accountId,
          });
        },
        adapter: new CodexResetAdapter(),
        signal,
      });
    },
  });
  await writeLastSync(result);
  return result;
}
