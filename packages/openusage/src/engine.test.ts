import { describe, expect, it } from 'vitest';
import { HttpOpenUsageEngine, type UsageEngine } from './engine';

describe('managed OpenUsage engine', () => {
  it('describes a safe read-only engine boundary', async () => {
    const fake: UsageEngine = {
      kind: 'http',
      health: async () => ({ state: 'ready', kind: 'http', detailCode: 'http_reachable' }),
      readLimits: async () => ({ schema: 'openusage.limits.v1', providers: {}, errors: [] }),
    };
    expect((await fake.health()).state).toBe('ready');
    await expect(fake.readLimits()).resolves.toMatchObject({ schema: 'openusage.limits.v1' });
  });

  it('maps loopback failures to stable health codes without raw errors', async () => {
    const syntheticPath = ['/', 'Users', 'alice', 'path'].join('/');
    const engine = new HttpOpenUsageEngine(async () => { throw new Error(`private ${syntheticPath} bearer abc`); });
    await expect(engine.health()).resolves.toEqual({ state: 'missing', kind: 'http', detailCode: 'http_unreachable' });
  });

  it('rejects malformed successful payloads as an engine error', async () => {
    const engine = new HttpOpenUsageEngine(async () => ({ nope: true }));
    await expect(engine.health()).resolves.toEqual({ state: 'error', kind: 'http', detailCode: 'http_invalid_response' });
  });
});
