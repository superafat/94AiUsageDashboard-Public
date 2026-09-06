import { describe, expect, it, vi } from 'vitest';
import type { SetupReport } from './setup-model';
import { AgentSetupActionError, nextSetupAction, runSetupStep, runSetupWorkflow, type SetupActionDependencies } from './setup-actions';

function deps(): SetupActionDependencies {
  return {
    login: vi.fn(async () => 'alice'),
    installBackground: vi.fn(async () => ({ plistPath: '/safe/LaunchAgents/sync.plist' })),
  };
}

const report = (overrides: Partial<SetupReport['checks']> = {}): SetupReport => ({
  schemaVersion: 1, overall: 'needs-action', checks: {
    platform: { state: 'ready', code: 'platform_ready', label: 'ok', nextAction: 'none' },
    engine: { state: 'ready', code: 'engine_ready', label: 'ok', nextAction: 'none' },
    backendConfig: { state: 'ready', code: 'backend_ready', label: 'ok', nextAction: 'none' },
    auth: { state: 'ready', code: 'auth_ready', label: 'ok', nextAction: 'none' },
    background: { state: 'ready', code: 'background_ready', label: 'ok', nextAction: 'none' },
    sync: { state: 'warning', code: 'sync_never', label: 'not yet', nextAction: 'none' },
    ...overrides,
  },
});

describe('safe setup actions', () => {
  it('allowlists login and background installation', async () => {
    const d = deps();
    await expect(runSetupStep('login_firebase', d)).resolves.toMatchObject({ state: 'done', action: 'login_firebase' });
    await expect(runSetupStep('install_background_sync', d)).resolves.toMatchObject({ state: 'done', action: 'install_background_sync' });
    expect(d.login).toHaveBeenCalledTimes(1);
    expect(d.installBackground).toHaveBeenCalledTimes(1);
  });

  it('never silently installs OpenUsage or mutates provider quotas', async () => {
    const d = deps();
    await expect(runSetupStep('install_openusage', d)).resolves.toEqual({ state: 'manual', action: 'install_openusage', instructionCode: 'install_official_openusage' });
    expect(d.login).not.toHaveBeenCalled();
    expect(d.installBackground).not.toHaveBeenCalled();
    await expect(runSetupStep('claim_reset_credit' as never, d)).rejects.toMatchObject({ code: 'action_not_allowed' });
  });

  it('selects the first safe next action in dependency order', () => {
    expect(nextSetupAction(report({ engine: { state: 'needs-action', code: 'engine_missing', label: 'missing', nextAction: 'install_openusage' } }))).toBe('install_openusage');
    expect(nextSetupAction(report({ auth: { state: 'needs-action', code: 'auth_missing', label: 'login', nextAction: 'login_firebase' }, background: { state: 'needs-action', code: 'background_missing', label: 'bg', nextAction: 'install_background_sync' } }))).toBe('login_firebase');
    expect(nextSetupAction(report({ background: { state: 'needs-action', code: 'background_missing', label: 'bg', nextAction: 'install_background_sync' } }))).toBe('install_background_sync');
    expect(nextSetupAction(report())).toBe('none');
  });

  it('uses a typed safe runtime error', () => {
    expect(new AgentSetupActionError('action_not_allowed').message).toBe('action_not_allowed');
  });

  it('runs login, initial sync and background installation in a resumable checked sequence', async () => {
    const calls: string[] = [];
    const reports = [
      report({ auth: { state: 'needs-action', code: 'auth_missing', label: 'login', nextAction: 'login_firebase' }, background: { state: 'needs-action', code: 'background_missing', label: 'bg', nextAction: 'install_background_sync' } }),
      report({ background: { state: 'needs-action', code: 'background_missing', label: 'bg', nextAction: 'install_background_sync' } }),
      report({ background: { state: 'needs-action', code: 'background_missing', label: 'bg', nextAction: 'install_background_sync' }, sync: { state: 'ready', code: 'sync_ready', label: 'ok', nextAction: 'none' } }),
      { ...report(), overall: 'ready' as const, checks: { ...report().checks, sync: { state: 'ready' as const, code: 'sync_ready', label: 'ok', nextAction: 'none' as const } } },
    ];
    const result = await runSetupWorkflow({
      doctor: async () => reports.shift()!,
      runAction: async (action) => { calls.push(action); return { state: 'done', action }; },
      sync: async () => { calls.push('sync'); },
    });
    expect(result.state).toBe('ready');
    expect(calls).toEqual(['login_firebase', 'sync', 'install_background_sync']);
  });

  it('stops safely at a manual engine installation boundary', async () => {
    const result = await runSetupWorkflow({
      doctor: async () => report({ engine: { state: 'needs-action', code: 'engine_missing', label: 'missing', nextAction: 'install_openusage' } }),
      runAction: async (action) => ({ state: 'manual', action, instructionCode: 'install_official_openusage' }),
      sync: async () => { throw new Error('must not sync'); },
    });
    expect(result).toEqual({ state: 'manual', action: 'install_openusage', instructionCode: 'install_official_openusage' });
  });

  it('does nothing destructive when setup is already ready', async () => {
    const readyReport = { ...report(), overall: 'ready' as const, checks: { ...report().checks, sync: { state: 'ready' as const, code: 'sync_ready', label: 'ok', nextAction: 'none' as const } } };
    const runAction = vi.fn(); const sync = vi.fn();
    await expect(runSetupWorkflow({ doctor: async () => readyReport, runAction, sync })).resolves.toEqual({ state: 'ready', report: readyReport });
    expect(runAction).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled();
  });

});
