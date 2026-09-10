#!/usr/bin/env node
import path from 'node:path';
import { loadAgentAuthConfig, loginWithGoogle } from './auth';
import { MacOSKeychainCredentialStore } from './credential-store';
import { formatSafeError, formatSyncStatus, runSync } from './sync';
import { formatDoctorHuman, formatDoctorJson, runDoctor } from './doctor';
import { runSetupStep, runSetupWorkflow } from './setup-actions';
import { installBackgroundSync, uninstallBackgroundSync } from './background';

async function main(): Promise<void> {
  const command = process.argv[2];
  const store = new MacOSKeychainCredentialStore();

  if (command === 'doctor') {
    const report = await runDoctor(process.env, store);
    console.log(process.argv.includes('--json') ? formatDoctorJson(report) : formatDoctorHuman(report));
    return;
  }

  const agentDir = process.cwd();
  const rootDir = path.resolve(agentDir, '../..');

  if (command === 'login') {
    const config = loadAgentAuthConfig(process.env);
    const uid = await loginWithGoogle(config, store);
    console.log(`登入完成：${uid}`);
    return;
  }
  if (command === 'sync') {
    const config = loadAgentAuthConfig(process.env);
    const result = await runSync(config, store);
    console.log(formatSyncStatus(result));
    if (result.preferenceErrorCode) process.exitCode = 1;
    return;
  }
  if (command === 'install') {
    if (process.platform !== 'darwin') throw new Error('background sync v1 currently supports macOS only');
    const result = await installBackgroundSync({ agentDir, rootDir });
    console.log(`背景同步已安裝：${result.plistPath}`);
    return;
  }
  if (command === 'uninstall') {
    if (process.platform !== 'darwin') throw new Error('background sync v1 currently supports macOS only');
    await uninstallBackgroundSync();
    console.log('背景同步已移除');
    return;
  }
  if (command === 'setup') {
    if (process.platform !== 'darwin') throw new Error('setup v1 currently supports macOS only');
    let config: ReturnType<typeof loadAgentAuthConfig> | undefined;
    const getConfig = () => config ??= loadAgentAuthConfig(process.env);
    const result = await runSetupWorkflow({
      doctor: () => runDoctor(process.env, store),
      runAction: (action) => runSetupStep(action, {
        login: () => loginWithGoogle(getConfig(), store),
        installBackground: () => installBackgroundSync({ agentDir, rootDir }),
      }),
      sync: async () => {
        const synced = await runSync(getConfig(), store);
        if (synced.preferenceErrorCode) throw new Error(formatSyncStatus(synced));
      },
    });
    if (result.state === 'manual') {
      const instruction = result.instructionCode === 'install_official_openusage'
        ? '請先安裝官方 OpenUsage（可使用 brew install --cask openusage），完成後重新執行 setup。'
        : result.instructionCode === 'configure_self_hosted_backend'
          ? '請先完成同步服務設定；Self-hosted 使用者依 README 設定自己的 Firebase，完成後重新執行 setup。'
          : '請先更新對應 AI 工具的登入狀態，再重新執行 setup。';
      console.log(`尚需一步：${instruction}`);
      return;
    }
    console.log('設定完成：額度引擎、登入、同步與背景服務都已就緒。');
    return;
  }
  throw new Error('usage: 94ai-usage <setup|login|sync|install|uninstall|doctor>');
}

main().catch((error) => {
  console.error(formatSafeError(error));
  process.exitCode = 1;
});
