import { describe, expect, it } from 'vitest';
import { buildSetupReport, type SetupCheck } from './setup-model';

const ready = (label: string): SetupCheck => ({ state: 'ready', code: `${label}_ready`, label, nextAction: 'none' });

describe('setup health model', () => {
  it('chooses needs-action when a required check is missing', () => {
    const report = buildSetupReport({
      platform: ready('platform'),
      engine: { state: 'needs-action', code: 'engine_missing', label: '找不到額度引擎', nextAction: 'install_openusage' },
      backendConfig: ready('backend'), auth: ready('auth'), background: ready('background'), sync: ready('sync'),
    });
    expect(report.schemaVersion).toBe(1);
    expect(report.overall).toBe('needs-action');
    expect(report.checks.engine.nextAction).toBe('install_openusage');
  });

  it('ranks error above needs-action and warning, then ready', () => {
    const base = { platform: ready('p'), engine: ready('e'), backendConfig: ready('b'), auth: ready('a'), background: ready('g'), sync: ready('s') };
    expect(buildSetupReport(base).overall).toBe('ready');
    expect(buildSetupReport({ ...base, sync: { state: 'warning', code: 'sync_stale', label: '同步較舊', nextAction: 'none' } }).overall).toBe('warning');
    expect(buildSetupReport({ ...base, auth: { state: 'needs-action', code: 'auth_missing', label: '需要登入', nextAction: 'login_firebase' } }).overall).toBe('needs-action');
    expect(buildSetupReport({ ...base, platform: { state: 'error', code: 'platform_unsupported', label: '不支援', nextAction: 'none' } }).overall).toBe('error');
  });

  it('allows only the fixed setup action vocabulary', () => {
    const check: SetupCheck = { state: 'needs-action', code: 'background_missing', label: '需要背景同步', nextAction: 'install_background_sync' };
    expect(check.nextAction).toBe('install_background_sync');
  });
});
