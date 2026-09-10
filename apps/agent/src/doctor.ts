import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadAgentAuthConfig, FIREBASE_REFRESH_TOKEN_ACCOUNT } from './auth';
import { backgroundSyncInstalled } from './background';
import { MacOSKeychainCredentialStore, type CredentialStore } from './credential-store';
import { selectUsageEngine } from './engine-select';
import { buildSetupReport, type SetupCheck, type SetupReport } from './setup-model';

export interface LastSyncStatus {
  providerCount: number;
  syncedAt: string;
  partialFailure?: boolean | undefined;
  providerErrorCode?: string | undefined;
  failedProviders?: string[] | undefined;
}
export interface DoctorDependencies {
  platform: () => string;
  engineHealth: () => Promise<{ state: 'ready' | 'missing' | 'error'; detailCode: string }>;
  backendConfigReady: () => boolean;
  authReady: () => Promise<boolean>;
  backgroundReady: () => Promise<boolean>;
  lastSync: () => Promise<LastSyncStatus | undefined>;
  now?: () => Date;
}

const check = (state: SetupCheck['state'], code: string, label: string, nextAction: SetupCheck['nextAction'] = 'none'): SetupCheck => ({ state, code, label, nextAction });

function lastSyncPath(): string {
  return path.join(os.homedir(), '.config', '94ai-usage-dashboard', 'last-sync.json');
}

async function readLastSync(): Promise<LastSyncStatus | undefined> {
  try {
    const value = JSON.parse(await readFile(lastSyncPath(), 'utf8')) as Record<string, unknown>;
    return typeof value.providerCount === 'number' && typeof value.syncedAt === 'string'
      ? {
          providerCount: value.providerCount,
          syncedAt: value.syncedAt,
          ...(value.partialFailure === true ? { partialFailure: true } : {}),
          ...(typeof value.providerErrorCode === 'string' ? { providerErrorCode: value.providerErrorCode } : {}),
          ...(Array.isArray(value.failedProviders) ? { failedProviders: value.failedProviders as string[] } : {}),
        }
      : undefined;
  } catch { return undefined; }
}

export async function runDoctorWithDependencies(deps: DoctorDependencies): Promise<SetupReport> {
  const now = (deps.now ?? (() => new Date()))();
  const platform = deps.platform() === 'darwin'
    ? check('ready', 'platform_ready', 'macOS 可用')
    : check('error', 'platform_unsupported', '目前只支援 macOS');

  const engineResult = await deps.engineHealth();
  const engine = engineResult.state === 'ready'
    ? check('ready', 'engine_ready', '額度引擎可用')
    : engineResult.state === 'missing'
      ? check('needs-action', 'engine_missing', '尚未找到 OpenUsage 額度引擎', 'install_openusage')
      : check('error', 'engine_error', '額度引擎目前無法使用');

  const backendConfig = deps.backendConfigReady()
    ? check('ready', 'backend_ready', '同步服務設定完成')
    : check('needs-action', 'backend_missing', '尚未完成同步服務設定', 'configure_firebase');
  const auth = await deps.authReady()
    ? check('ready', 'auth_ready', '帳號登入完成')
    : check('needs-action', 'auth_missing', '尚未登入同步帳號', 'login_firebase');
  const background = await deps.backgroundReady()
    ? check('ready', 'background_ready', '背景同步已安裝')
    : check('needs-action', 'background_missing', '尚未安裝背景同步', 'install_background_sync');

  const last = await deps.lastSync();
  let sync = check('warning', 'sync_never', '尚未完成第一次同步');
  if (last && Number.isFinite(Date.parse(last.syncedAt))) {
    const syncTime = Date.parse(last.syncedAt);
    const age = now.getTime() - syncTime;
    if (syncTime > now.getTime()) {
      sync = check('warning', 'sync_future_inconsistent', `最近同步時間異常（來自未來時間：${last.syncedAt}）`);
    } else if (last.providerCount <= 0) {
      sync = check('warning', 'sync_zero_providers', '最近同步未包含任何來源（0 個來源）', 'refresh_provider_login');
    } else if (last.partialFailure || (last.failedProviders && last.failedProviders.length > 0)) {
      sync = check('warning', 'sync_partial', `最近同步部分失敗（成功 ${last.providerCount} 個來源）`);
    } else if (age <= 12 * 60 * 1000) {
      sync = check('ready', 'sync_ready', `最近同步正常（${last.providerCount} 個來源）`);
    } else {
      sync = check('warning', 'sync_stale', `最近同步較舊（${last.providerCount} 個來源）`);
    }
  }
  return buildSetupReport({ platform, engine, backendConfig, auth, background, sync });
}

export async function runDoctor(
  env: Record<string, string | undefined>,
  store: CredentialStore = new MacOSKeychainCredentialStore(),
): Promise<SetupReport> {
  return runDoctorWithDependencies({
    platform: () => process.platform,
    engineHealth: async () => {
      try {
        const engine = await selectUsageEngine();
        return { state: 'ready', detailCode: `${engine.kind}_ready` };
      } catch { return { state: 'missing', detailCode: 'engine_missing' }; }
    },
    backendConfigReady: () => { try { loadAgentAuthConfig(env); return true; } catch { return false; } },
    authReady: async () => Boolean(await store.get(FIREBASE_REFRESH_TOKEN_ACCOUNT)),
    backgroundReady: () => backgroundSyncInstalled(),
    lastSync: () => readLastSync(),
  });
}

const ORDER: Array<[keyof SetupReport['checks'], string]> = [
  ['platform', 'Mac'], ['engine', '額度引擎'], ['backendConfig', '同步設定'],
  ['auth', '帳號'], ['background', '背景同步'], ['sync', '最近同步'],
];

export function formatDoctorHuman(report: SetupReport): string {
  return ORDER.map(([key, name]) => {
    const item = report.checks[key];
    const mark = item.state === 'ready' ? '✓' : item.state === 'warning' ? '!' : item.state === 'needs-action' ? '→' : '×';
    return `${mark} ${name}：${item.label}`;
  }).join('\n');
}

export function formatDoctorJson(report: SetupReport): string {
  return JSON.stringify(report, null, 2);
}
