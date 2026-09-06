import { describe, expect, it } from 'vitest';
import { formatDoctorHuman, formatDoctorJson, runDoctorWithDependencies } from './doctor';

describe('doctor', () => {
  it('reports exact next actions with stable codes and no raw diagnostics', async () => {
    const report = await runDoctorWithDependencies({
      platform: () => 'darwin',
      engineHealth: async () => ({ state: 'missing', detailCode: 'cli_missing' }),
      backendConfigReady: () => true,
      authReady: async () => false,
      backgroundReady: async () => false,
      lastSync: async () => undefined,
    });
    expect(report.overall).toBe('needs-action');
    expect(report.checks.engine).toMatchObject({ code: 'engine_missing', nextAction: 'install_openusage' });
    expect(report.checks.auth).toMatchObject({ code: 'auth_missing', nextAction: 'login_firebase' });
    expect(report.checks.background).toMatchObject({ code: 'background_missing', nextAction: 'install_background_sync' });
    expect(JSON.stringify(report)).not.toMatch(/Users\/|Bearer|token=/i);
  });

  it('reports a recent successful sync as ready and stale sync as warning', async () => {
    const base = {
      platform: () => 'darwin',
      engineHealth: async () => ({ state: 'ready' as const, detailCode: 'cli_ready' }),
      backendConfigReady: () => true,
      authReady: async () => true,
      backgroundReady: async () => true,
    };
    const recent = await runDoctorWithDependencies({ ...base, lastSync: async () => ({ providerCount: 3, syncedAt: '2026-09-06T10:00:00.000Z' }), now: () => new Date('2026-09-06T10:06:00.000Z') });
    expect(recent.overall).toBe('ready');
    expect(recent.checks.sync.code).toBe('sync_ready');
    const stale = await runDoctorWithDependencies({ ...base, lastSync: async () => ({ providerCount: 3, syncedAt: '2026-09-06T09:00:00.000Z' }), now: () => new Date('2026-09-06T10:06:00.000Z') });
    expect(stale.overall).toBe('warning');
    expect(stale.checks.sync.code).toBe('sync_stale');
  });

  it('formats a short human checklist without internal stack text', async () => {
    const report = await runDoctorWithDependencies({
      platform: () => 'darwin', engineHealth: async () => ({ state: 'ready', detailCode: 'http_reachable' }), backendConfigReady: () => true,
      authReady: async () => true, backgroundReady: async () => true, lastSync: async () => ({ providerCount: 2, syncedAt: '2026-09-06T10:00:00.000Z' }), now: () => new Date('2026-09-06T10:01:00.000Z'),
    });
    const text = formatDoctorHuman(report);
    expect(text).toContain('額度引擎');
    expect(text).toContain('背景同步');
    expect(text).not.toMatch(/stack|Bearer|refresh/i);
  });

  it('formats doctor --json as machine-readable JSON only', async () => {
    const report = await runDoctorWithDependencies({
      platform: () => 'darwin', engineHealth: async () => ({ state: 'ready', detailCode: 'cli_ready' }), backendConfigReady: () => true,
      authReady: async () => true, backgroundReady: async () => true, lastSync: async () => undefined,
    });
    const output = formatDoctorJson(report);
    expect(JSON.parse(output)).toMatchObject({ schemaVersion: 1, checks: { engine: { code: 'engine_ready' } } });
    expect(output.trim().startsWith('{')).toBe(true);
  });

});
