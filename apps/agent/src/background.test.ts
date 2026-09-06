import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BACKGROUND_LABEL, buildLaunchAgentPlist, installBackgroundSync } from './background';

describe('macOS background sync', () => {
  it('builds a five-minute LaunchAgent without embedding credentials', () => {
    const plist = buildLaunchAgentPlist({
      nodePath: '/opt/node/bin/node',
      agentDir: '/repo/apps/agent',
      rootDir: '/repo',
    });
    expect(plist).toContain(BACKGROUND_LABEL);
    expect(plist).toContain('<integer>300</integer>');
    expect(plist).toContain('--env-file-if-exists=../../.env.local');
    expect(plist).toContain('<string>sync</string>');
    expect(plist).not.toMatch(/refresh.?token|api.?key|service.?account/i);
  });

  it('installs and bootstraps a per-user LaunchAgent', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), '94ai-bg-'));
    const calls: string[][] = [];
    const result = await installBackgroundSync({
      homeDir: home,
      nodePath: '/opt/node/bin/node',
      agentDir: '/repo/apps/agent',
      rootDir: '/repo',
      uid: 501,
      nodeVersion: '22.23.1',
      run: async (args) => { calls.push(args); },
    });
    expect(result.plistPath).toContain('Library/LaunchAgents');
    expect(await readFile(result.plistPath, 'utf8')).toContain('<key>RunAtLoad</key>');
    expect(calls.some((args) => args[0] === 'bootstrap')).toBe(true);
    expect(calls.some((args) => args[0] === 'enable')).toBe(true);
  });

  it('rejects a non-Node-22 installer so LaunchAgent cannot pin an unsupported runtime', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), '94ai-bg-version-'));
    await expect(installBackgroundSync({
      homeDir: home,
      nodePath: '/opt/node26/bin/node',
      nodeVersion: '26.8.1',
      agentDir: '/repo/apps/agent',
      rootDir: '/repo',
      uid: 501,
      run: async () => undefined,
    })).rejects.toThrow(/Node\.js 22/);
  });

});
