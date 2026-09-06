import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export interface CredentialStore {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export type SecurityRunner = (args: string[], input?: string) => Promise<{ stdout: string; stderr: string }>;

const KEYCHAIN_CHUNK_SIZE = 96;
const MAX_CREDENTIAL_BYTES = 16_384;
const MAX_CHUNKS = 256;
const MANIFEST_SUFFIX = '.__94ai_manifest';

const KEYCHAIN_WRITE_EXPECT_SCRIPT = String.raw`
log_user 0
set timeout 10
set f [open "/dev/fd/3" r]
gets $f secret
close $f
spawn /usr/bin/security add-generic-password -U -s $env(KEYCHAIN_SERVICE) -a $env(KEYCHAIN_ACCOUNT) -w
expect {
  -re {(?i)password.*:} { send -- "$secret\r"; exp_continue }
  eof {}
  timeout { exit 124 }
}
set result [wait]
exit [lindex $result 3]
`;

function captureProcess(command: string, args: string[], options: { input?: string; env?: NodeJS.ProcessEnv; secretFd?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const useSecretFd = options.secretFd !== undefined;
    const child = spawn(command, args, {
      env: options.env,
      stdio: useSecretFd ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    if (options.input !== undefined) child.stdin?.end(options.input);
    if (useSecretFd) {
      const fd = child.stdio[3];
      if (fd && 'end' in fd) fd.end(options.secretFd);
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Keychain command timed out'));
    }, 15_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Keychain command failed (${code ?? 'unknown'})`));
    });
  });
}

function argValue(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`Keychain command missing ${flag}`);
  return value;
}

const defaultSecurityRunner: SecurityRunner = async (args, input) => {
  if (input !== undefined && args[0] === 'add-generic-password') {
    const secret = input.endsWith('\n') ? input.slice(0, -1) : input;
    return captureProcess('/usr/bin/expect', ['-c', KEYCHAIN_WRITE_EXPECT_SCRIPT], {
      env: {
        ...process.env,
        KEYCHAIN_SERVICE: argValue(args, '-s'),
        KEYCHAIN_ACCOUNT: argValue(args, '-a'),
      },
      secretFd: secret,
    });
  }
  return captureProcess('/usr/bin/security', args);
};

interface Manifest {
  generation: string;
  count: number;
}

function manifestAccount(account: string): string {
  return `${account}${MANIFEST_SUFFIX}`;
}

function partAccount(account: string, generation: string, index: number): string {
  return `${account}.__94ai_${generation}_${String(index).padStart(3, '0')}`;
}

function parseManifest(value: string | null): Manifest | null {
  if (!value) return null;
  const match = /^v1:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([1-9][0-9]{0,2})$/i.exec(value);
  if (!match) return null;
  const count = Number(match[2]);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_CHUNKS) return null;
  return { generation: match[1]!, count };
}

function chunkValue(value: string): string[] {
  if (Buffer.byteLength(value, 'utf8') > MAX_CREDENTIAL_BYTES) throw new Error('credential is too large');
  const encoded = Buffer.from(value, 'utf8').toString('base64url');
  const chunks: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += KEYCHAIN_CHUNK_SIZE) {
    chunks.push(encoded.slice(offset, offset + KEYCHAIN_CHUNK_SIZE));
  }
  if (!chunks.length || chunks.length > MAX_CHUNKS) throw new Error('credential chunk count is invalid');
  return chunks;
}

export class MacOSKeychainCredentialStore implements CredentialStore {
  constructor(
    private readonly service = '94AiUsageDashboard',
    private readonly runner: SecurityRunner = defaultSecurityRunner,
  ) {}

  private async rawGet(account: string): Promise<string | null> {
    try {
      const result = await this.runner(['find-generic-password', '-s', this.service, '-a', account, '-w']);
      return result.stdout.replace(/\r?\n$/, '') || null;
    } catch {
      return null;
    }
  }

  private async rawSet(account: string, value: string): Promise<void> {
    await this.runner(['add-generic-password', '-U', '-s', this.service, '-a', account, '-w'], `${value}\n`);
  }

  private async rawDelete(account: string): Promise<void> {
    try {
      await this.runner(['delete-generic-password', '-s', this.service, '-a', account]);
    } catch {
      return;
    }
  }

  private async deleteGeneration(account: string, manifest: Manifest): Promise<void> {
    for (let index = 0; index < manifest.count; index += 1) {
      await this.rawDelete(partAccount(account, manifest.generation, index));
    }
  }

  async get(account: string): Promise<string | null> {
    const manifest = parseManifest(await this.rawGet(manifestAccount(account)));
    if (!manifest) return this.rawGet(account);

    const chunks: string[] = [];
    for (let index = 0; index < manifest.count; index += 1) {
      const part = await this.rawGet(partAccount(account, manifest.generation, index));
      if (part === null) return null;
      chunks.push(part);
    }
    try {
      return Buffer.from(chunks.join(''), 'base64url').toString('utf8');
    } catch {
      return null;
    }
  }

  async set(account: string, value: string): Promise<void> {
    if (!value) throw new Error('refusing to store an empty credential');
    const chunks = chunkValue(value);
    const oldManifest = parseManifest(await this.rawGet(manifestAccount(account)));
    const generation = randomUUID();
    const written: string[] = [];

    try {
      for (let index = 0; index < chunks.length; index += 1) {
        const part = partAccount(account, generation, index);
        await this.rawSet(part, chunks[index]!);
        written.push(part);
      }
      await this.rawSet(manifestAccount(account), `v1:${generation}:${chunks.length}`);
    } catch (error) {
      for (const part of written) await this.rawDelete(part);
      throw error;
    }

    await this.rawDelete(account);
    if (oldManifest && oldManifest.generation !== generation) await this.deleteGeneration(account, oldManifest);
  }

  async delete(account: string): Promise<void> {
    const manifestName = manifestAccount(account);
    const manifest = parseManifest(await this.rawGet(manifestName));
    if (manifest) await this.deleteGeneration(account, manifest);
    await this.rawDelete(manifestName);
    await this.rawDelete(account);
  }
}
