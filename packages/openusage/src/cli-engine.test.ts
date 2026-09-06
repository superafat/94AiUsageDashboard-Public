import { describe, expect, it } from 'vitest';
import { CliOpenUsageEngine, OpenUsageCliError, type ProcessRunner } from './cli-engine';

describe('CliOpenUsageEngine', () => {
  it('uses cached refresh by default and --force only when requested', async () => {
    const calls: string[][] = [];
    const runner: ProcessRunner = async (_cmd, args) => {
      calls.push(args);
      return { exitCode: 0, stdout: JSON.stringify({ schema: 'openusage.limits.v1', providers: {}, errors: [] }), stderr: '' };
    };
    const engine = new CliOpenUsageEngine(runner);
    await engine.readLimits();
    await engine.readLimits({ force: true });
    expect(calls).toEqual([[], ['--force']]);
  });

  it('maps missing executable, nonzero exit, and malformed output to stable codes', async () => {
    const syntheticHome = ['/', 'Users', 'alice'].join('/');
    const missing: ProcessRunner = async () => { throw Object.assign(new Error(`private path ${syntheticHome}/bin`), { code: 'ENOENT' }); };
    await expect(new CliOpenUsageEngine(missing).readLimits()).rejects.toMatchObject({ code: 'cli_missing' });

    const failed: ProcessRunner = async () => ({ exitCode: 4, stdout: '', stderr: `Bearer private-secret ${syntheticHome}/private` });
    await expect(new CliOpenUsageEngine(failed).readLimits()).rejects.toMatchObject({ code: 'cli_failed' });

    const invalid: ProcessRunner = async () => ({ exitCode: 0, stdout: '{"wrong":true}', stderr: '' });
    await expect(new CliOpenUsageEngine(invalid).readLimits()).rejects.toMatchObject({ code: 'cli_invalid_output' });
  });

  it('reports health without returning raw stderr or machine paths', async () => {
    const syntheticHome = ['/', 'Users', 'alice'].join('/');
    const runner: ProcessRunner = async () => ({ exitCode: 4, stdout: '', stderr: `Bearer secret ${syntheticHome}/private` });
    const health = await new CliOpenUsageEngine(runner).health();
    expect(health).toEqual({ state: 'error', kind: 'cli', detailCode: 'cli_failed' });
    expect(JSON.stringify(health)).not.toContain('secret');
    expect(JSON.stringify(health)).not.toContain(syntheticHome);
  });

  it('exposes a typed stable error rather than provider diagnostics', () => {
    expect(new OpenUsageCliError('cli_failed').message).toBe('cli_failed');
  });
});
