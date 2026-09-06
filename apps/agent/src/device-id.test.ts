import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getOrCreateDeviceId } from './device-id';

describe('getOrCreateDeviceId', () => {
  it('creates a random stable installation id without hardware identity', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), '94ai-device-'));
    const file = path.join(dir, 'device-id');
    const first = await getOrCreateDeviceId(file);
    const second = await getOrCreateDeviceId(file);
    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f-]{36}$/i);
    expect(first).not.toContain(os.hostname());
    expect((await readFile(file, 'utf8')).trim()).toBe(first);
  });
});
