import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchOpenUsageLimits } from './client';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function localServer(body: string): Promise<string> {
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(body); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

describe('fetchOpenUsageLimits', () => {
  it('reads the limits endpoint from loopback', async () => {
    const baseUrl = await localServer('{"schema":"openusage.limits.v1","providers":{},"errors":[]}');
    await expect(fetchOpenUsageLimits({ baseUrl })).resolves.toMatchObject({ schema: 'openusage.limits.v1' });
  });

  it('rejects non-loopback URLs', async () => {
    await expect(fetchOpenUsageLimits({ baseUrl: 'https://example.com' })).rejects.toThrow(/loopback/i);
  });

  it('surfaces connection failures', async () => {
    await expect(fetchOpenUsageLimits({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 100 })).rejects.toThrow();
  });
});
