import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const BACKGROUND_LABEL = 'com.94ai.usage-dashboard.sync';
export const BACKGROUND_INTERVAL_SECONDS = 300;

type LaunchctlRunner = (args: string[]) => Promise<void>;

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildLaunchAgentPlist(input: { nodePath: string; agentDir: string; rootDir: string }): string {
  const args = [
    input.nodePath,
    '--env-file-if-exists=../../.env.local',
    '--import',
    'tsx',
    'src/cli.ts',
    'sync',
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${BACKGROUND_LABEL}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(input.agentDir)}</string>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>${BACKGROUND_INTERVAL_SECONDS}</integer>
<key>ProcessType</key><string>Background</string>
<key>ThrottleInterval</key><integer>60</integer>
</dict></plist>\n`;
}

async function runLaunchctl(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/bin/launchctl', args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`launchctl failed: ${args[0] ?? 'unknown'}`)));
  });
}

export async function installBackgroundSync(options: {
  homeDir?: string;
  nodePath?: string;
  nodeVersion?: string;
  agentDir: string;
  rootDir: string;
  uid?: number;
  run?: LaunchctlRunner;
}): Promise<{ plistPath: string }> {
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  if (Number.parseInt(nodeVersion.split('.')[0] ?? '', 10) !== 22) {
    throw new Error(`background sync requires Node.js 22; current runtime is ${nodeVersion}`);
  }
  const homeDir = options.homeDir ?? os.homedir();
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error('background sync requires a user session');
  const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', `${BACKGROUND_LABEL}.plist`);
  await mkdir(path.dirname(plistPath), { recursive: true, mode: 0o700 });
  await writeFile(plistPath, buildLaunchAgentPlist({ nodePath: options.nodePath ?? process.execPath, agentDir: options.agentDir, rootDir: options.rootDir }), { mode: 0o644 });
  const run = options.run ?? runLaunchctl;
  await run(['bootout', `gui/${uid}`, plistPath]).catch(() => undefined);
  await run(['bootstrap', `gui/${uid}`, plistPath]);
  await run(['enable', `gui/${uid}/${BACKGROUND_LABEL}`]);
  await run(['kickstart', '-k', `gui/${uid}/${BACKGROUND_LABEL}`]);
  return { plistPath };
}

export async function uninstallBackgroundSync(options: { homeDir?: string; uid?: number; run?: LaunchctlRunner } = {}): Promise<void> {
  const homeDir = options.homeDir ?? os.homedir();
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error('background sync requires a user session');
  const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', `${BACKGROUND_LABEL}.plist`);
  const run = options.run ?? runLaunchctl;
  await run(['bootout', `gui/${uid}`, plistPath]).catch(() => undefined);
  await unlink(plistPath).catch(() => undefined);
}

export async function backgroundSyncInstalled(homeDir = os.homedir()): Promise<boolean> {
  try {
    await access(path.join(homeDir, 'Library', 'LaunchAgents', `${BACKGROUND_LABEL}.plist`));
    return true;
  } catch {
    return false;
  }
}
