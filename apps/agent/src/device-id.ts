import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function defaultDeviceIdPath(): string {
  return path.join(os.homedir(), '.config', '94ai-usage-dashboard', 'device-id');
}

export async function getOrCreateDeviceId(filePath = defaultDeviceIdPath()): Promise<string> {
  try {
    const existing = (await readFile(filePath, 'utf8')).trim();
    if (!UUID_RE.test(existing)) throw new Error('stored device id is invalid');
    return existing;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }

  const id = randomUUID();
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await writeFile(filePath, `${id}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = (await readFile(filePath, 'utf8')).trim();
    if (!UUID_RE.test(existing)) throw new Error('stored device id is invalid');
    return existing;
  }
}
