import { spawn } from 'node:child_process';
import { isLimitsEnvelope, type EngineHealth, type UsageEngine } from './engine';

export type CliErrorCode = 'cli_missing' | 'cli_failed' | 'cli_invalid_output';
export interface ProcessResult { exitCode: number; stdout: string; stderr: string }
export type ProcessRunner = (command: string, args: string[]) => Promise<ProcessResult>;

export class OpenUsageCliError extends Error {
  constructor(readonly code: CliErrorCode) {
    super(code);
    this.name = 'OpenUsageCliError';
  }
}

const MAX_OUTPUT = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

export const runOpenUsageProcess: ProcessRunner = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutSize = 0;
  let stderrSize = 0;
  let settled = false;

  const finish = (error?: Error, result?: ProcessResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error); else resolve(result!);
  };
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    finish(new Error('cli_timeout'));
  }, TIMEOUT_MS);

  child.once('error', (error) => finish(error));
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutSize += chunk.length;
    if (stdoutSize > MAX_OUTPUT) {
      child.kill('SIGKILL');
      finish(new Error('cli_output_too_large'));
      return;
    }
    stdout.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderrSize += chunk.length;
    if (stderrSize <= MAX_OUTPUT) stderr.push(chunk);
  });
  child.once('close', (code) => finish(undefined, {
    exitCode: code ?? 1,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  }));
});

export class CliOpenUsageEngine implements UsageEngine {
  readonly kind = 'cli' as const;
  constructor(private readonly runner: ProcessRunner = runOpenUsageProcess) {}

  async health(): Promise<EngineHealth> {
    try {
      await this.readLimits();
      return { state: 'ready', kind: this.kind, detailCode: 'cli_ready' };
    } catch (error) {
      const code = error instanceof OpenUsageCliError ? error.code : 'cli_failed';
      return code === 'cli_missing'
        ? { state: 'missing', kind: this.kind, detailCode: code }
        : { state: 'error', kind: this.kind, detailCode: code };
    }
  }

  async readLimits(options: { force?: boolean } = {}): Promise<unknown> {
    let result: ProcessResult;
    try { result = await this.runner('openusage', options.force ? ['--force'] : []); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') throw new OpenUsageCliError('cli_missing');
      throw new OpenUsageCliError('cli_failed');
    }
    if (result.exitCode !== 0) throw new OpenUsageCliError('cli_failed');
    let value: unknown;
    try { value = JSON.parse(result.stdout); } catch { throw new OpenUsageCliError('cli_invalid_output'); }
    if (!isLimitsEnvelope(value)) throw new OpenUsageCliError('cli_invalid_output');
    return value;
  }
}
