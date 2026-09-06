import { describe, expect, it } from 'vitest';
import type { EngineHealth, UsageEngine } from '@94ai/openusage';
import { AgentSetupError, readPreferredLimits, selectUsageEngine } from './engine-select';

function engine(kind: 'cli' | 'http', health: EngineHealth, value: unknown = { schema: 'openusage.limits.v1', providers: {}, errors: [] }): UsageEngine {
  return { kind, health: async () => health, readLimits: async () => value };
}

describe('selectUsageEngine', () => {
  it('prefers a ready CLI over HTTP', async () => {
    const cli = engine('cli', { state: 'ready', kind: 'cli', detailCode: 'cli_ready' });
    const http = engine('http', { state: 'ready', kind: 'http', detailCode: 'http_reachable' });
    await expect(selectUsageEngine([cli, http])).resolves.toBe(cli);
  });

  it('falls back to loopback HTTP when CLI is missing', async () => {
    const cli = engine('cli', { state: 'missing', kind: 'cli', detailCode: 'cli_missing' });
    const http = engine('http', { state: 'ready', kind: 'http', detailCode: 'http_reachable' });
    await expect(selectUsageEngine([cli, http])).resolves.toBe(http);
  });

  it('fails with a stable setup code when no engine is ready', async () => {
    const cli = engine('cli', { state: 'missing', kind: 'cli', detailCode: 'cli_missing' });
    const http = engine('http', { state: 'missing', kind: 'http', detailCode: 'http_unreachable' });
    await expect(selectUsageEngine([cli, http])).rejects.toMatchObject({ code: 'engine_missing' });
  });

  it('keeps a valid CLI envelope ready even when provider errors are present', async () => {
    const cli = engine('cli', { state: 'ready', kind: 'cli', detailCode: 'cli_ready' }, { schema: 'openusage.limits.v1', providers: {}, errors: [{ providerId: 'claude', message: 'not logged in' }] });
    const selected = await selectUsageEngine([cli]);
    await expect(selected.readLimits()).resolves.toMatchObject({ schema: 'openusage.limits.v1' });
  });

  it('uses a typed setup error with no raw diagnostics', () => {
    expect(new AgentSetupError('engine_missing').message).toBe('engine_missing');
  });

  it('reads limits from the selected preferred engine', async () => {
    const cli = engine('cli', { state: 'ready', kind: 'cli', detailCode: 'cli_ready' }, { schema: 'openusage.limits.v1', providers: { codex: {} }, errors: [] });
    const http = engine('http', { state: 'ready', kind: 'http', detailCode: 'http_reachable' });
    await expect(readPreferredLimits([cli, http])).resolves.toMatchObject({ providers: { codex: {} } });
  });

});
