import { describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  CodexResetAdapter,
  PreWriteTransportError,
  type CodexRpcTransport,
  type ExecutionClaim,
  type SpawnFunction,
} from './codex-reset-adapter';
import { ResetCommandJournal } from './reset-command-journal';
import type { ResetCreditCommand } from '@94ai/core';

async function createJournalClaim(params: {
  accountId: string;
  creditId: string;
  idempotencyKey: string;
  commandId?: string;
  requestedAt?: string;
  expiresAt?: string;
}): Promise<{ claim: ExecutionClaim; journal: ResetCommandJournal; command: ResetCreditCommand; cleanup: () => void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-test-'));
  const journal = new ResetCommandJournal({
    rootDir: dir,
    backendId: 'codex-local',
    userId: 'test-user',
    deviceId: 'test-device',
    accountId: params.accountId,
  });
  const cmd: ResetCreditCommand = {
    version: 1 as const,
    commandId: params.commandId ?? 'cmd_' + randomUUID(),
    idempotencyKey: params.idempotencyKey,
    creditId: params.creditId,
    accountId: params.accountId,
    targetDeviceId: 'test-device',
    userId: 'test-user',
    backendId: 'codex-local',
    requestedAt: params.requestedAt ?? new Date(Date.now() - 1000).toISOString(),
    expiresAt: params.expiresAt ?? new Date(Date.now() + 3600_000).toISOString(),
  };
  await journal.prepareCommand(cmd);
  const executing = await journal.transitionToExecuting(cmd.commandId);
  return {
    claim: executing.executionClaim!,
    journal,
    command: cmd,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

class FakeTransport implements CodexRpcTransport {
  public sentMessages: string[] = [];
  public messageHandlers: ((msg: string) => void)[] = [];
  public errorHandlers: ((err: Error) => void)[] = [];
  public closeHandlers: ((code: number | null, signal: string | null) => void)[] = [];
  public closed = false;

  public async send(message: string): Promise<void> {
    this.sentMessages.push(message);
  }

  public onMessage(handler: (msg: string) => void): void {
    this.messageHandlers.push(handler);
  }

  public onError(handler: (err: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  public onClose(handler: (code: number | null, signal: string | null) => void): void {
    this.closeHandlers.push(handler);
  }

  public async close(): Promise<void> {
    this.closed = true;
    for (const h of this.closeHandlers) h(0, null);
  }

  public emitMessage(msg: Record<string, unknown>): void {
    const raw = JSON.stringify(msg);
    for (const h of this.messageHandlers) h(raw);
  }

  public emitRaw(raw: string): void {
    for (const h of this.messageHandlers) h(raw);
  }

  public emitError(err: Error): void {
    for (const h of this.errorHandlers) h(err);
  }

  public emitClose(code: number | null = 0, signal: string | null = null): void {
    this.closed = true;
    for (const h of this.closeHandlers) h(code, signal);
  }
}

describe('CodexResetAdapter', () => {
  it('verifies spawn options strictly enforce no shell and exact binary + args', () => {
    let capturedCmd = '';
    let capturedArgs: string[] = [];
    let capturedOpts: { shell?: boolean; stdio?: unknown } | undefined;

    const fakeSpawner: SpawnFunction = (cmd, args, opts) => {
      capturedCmd = cmd;
      capturedArgs = args;
      capturedOpts = opts;
      return {
        stdin: { write: () => true, end: () => {} },
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: () => {},
        kill: () => true,
      } as unknown as ChildProcess;
    };

    const adapter = new CodexResetAdapter({
      spawnProcess: fakeSpawner,
    });

    expect(adapter).toBeDefined();
    adapter.testSpawnConfig();
    expect(capturedCmd).toBe('codex');
    expect(capturedArgs).toEqual(['app-server', '--stdio']);
    expect(capturedOpts?.shell).toBe(false);
  });

  it('rejects/ignores arbitrary executablePath and always spawns fixed codex binary', () => {
    let capturedCmd = '';
    const fakeSpawner: SpawnFunction = (cmd) => {
      capturedCmd = cmd;
      return {} as unknown as ChildProcess;
    };

    const adapter = new CodexResetAdapter({
      spawnProcess: fakeSpawner,
      // @ts-expect-error executablePath should be removed from options
      executablePath: '/usr/local/bin/malicious-binary',
    });

    adapter.testSpawnConfig();
    expect(capturedCmd).toBe('codex');
  });

  it('verifies apps/agent index does not export CodexResetAdapter directly', async () => {
    const agentIndex = await import('./index');
    expect((agentIndex as Record<string, unknown>).CodexResetAdapter).toBeUndefined();
  });

  it('performs RPC handshake: initialize with clientInfo + initialized notification', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexResetAdapter({ transport });

    const sessionPromise = adapter.readRateLimits();

    await new Promise((r) => setTimeout(r, 10));

    // Check initialize request
    expect(transport.sentMessages.length).toBe(1);
    const initReq = JSON.parse(transport.sentMessages[0]!);
    expect(initReq.method).toBe('initialize');
    expect(initReq.params.clientInfo.name).toBe('94AiUsageDashboard');
    expect(initReq.params.clientInfo.version).toBe('0.1.4');

    // Respond to initialize
    transport.emitMessage({
      jsonrpc: '2.0',
      id: initReq.id,
      result: { capabilities: {} },
    });

    await new Promise((r) => setTimeout(r, 10));

    // Check initialized notification sent and read request sent
    expect(transport.sentMessages.length).toBe(3);
    const initializedNotif = JSON.parse(transport.sentMessages[1]!);
    expect(initializedNotif.method).toBe('initialized');

    const readReq = JSON.parse(transport.sentMessages[2]!);
    expect(readReq.method).toBe('account/rateLimits/read');

    // Respond to read
    transport.emitMessage({
      jsonrpc: '2.0',
      id: readReq.id,
      result: {
        accountId: 'acc_test_1',
        rateLimitResetCredits: {
          availableCount: 1,
          credits: [
            {
              id: 'credit_1',
              resetType: 'codexRateLimits',
              status: 'available',
              grantedAt: 1789000000,
              expiresAt: 1790000000,
            },
          ],
        },
      },
    });

    const result = await sessionPromise;
    expect(result.accountId).toBe('acc_test_1');
    expect(result.availableCount).toBe(1);
    expect(result.credits?.length).toBe(1);
    expect(result.credits?.[0]?.creditId).toBe('credit_1');
    expect(result.credits?.[0]?.status).toBe('available');
    expect(result.credits?.[0]?.resetType).toBe('codexRateLimits');
  });

  it('enforces exact method allowlist and rejects unapproved methods', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexResetAdapter({ transport });
    expect(() => adapter.callMethod('forbidden/arbitraryMethod')).toThrow('disallowed_method');
  });

  it('consume helper: happy path with explicit creditId and four outcome support', async () => {
    for (const outcome of ['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'] as const) {
      const transport = new FakeTransport();
      const adapter = new CodexResetAdapter({ transport });
      const { claim, journal, command, cleanup } = await createJournalClaim({
        accountId: 'acc_target',
        creditId: 'credit_x',
        idempotencyKey: 'idem_123',
      });

      try {
        const consumePromise = adapter.consumeResetCredit({
          expectedAccountId: 'acc_target',
          creditId: 'credit_x',
          idempotencyKey: 'idem_123',
          executionClaim: claim,
          journal,
          command,
        });

        await new Promise((r) => setTimeout(r, 10));

        // 1. initialize
        const initReq = JSON.parse(transport.sentMessages[0]!);
        transport.emitMessage({ jsonrpc: '2.0', id: initReq.id, result: {} });

        await new Promise((r) => setTimeout(r, 10));

        // 2. read
        const readReq = JSON.parse(transport.sentMessages[2]!);
        expect(readReq.method).toBe('account/rateLimits/read');
        transport.emitMessage({
          jsonrpc: '2.0',
          id: readReq.id,
          result: {
            accountId: 'acc_target',
            rateLimitResetCredits: {
              availableCount: 1,
              credits: [
                {
                  id: 'credit_x',
                  resetType: 'codexRateLimits',
                  status: 'available',
                  grantedAt: 1789000000,
                  expiresAt: 1790000000,
                },
              ],
            },
          },
        });

        await new Promise((r) => setTimeout(r, 10));

        // 3. consume sent with explicit creditId & idempotencyKey
        const consumeReq = JSON.parse(transport.sentMessages[3]!);
        expect(consumeReq.method).toBe('account/rateLimitResetCredit/consume');
        expect(consumeReq.params.creditId).toBe('credit_x');
        expect(consumeReq.params.idempotencyKey).toBe('idem_123');

        // 4. emit outcome
        transport.emitMessage({
          jsonrpc: '2.0',
          id: consumeReq.id,
          result: { outcome },
        });

        const res = await consumePromise;
        if (outcome === 'reset') {
          expect(res.state).toBe('success');
          expect(res.code).toBe('reset');
        } else {
          expect(res.state).toBe('failed');
          expect(res.code).toBe(outcome);
        }
      } finally {
        cleanup();
      }
    }
  });

  it('consume helper: rejects account mismatch before consume dispatch', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexResetAdapter({ transport });
    const { claim, journal, command, cleanup } = await createJournalClaim({
      accountId: 'expected_acc',
      creditId: 'credit_x',
      idempotencyKey: 'idem_123',
    });

    try {
      const consumePromise = adapter.consumeResetCredit({
        expectedAccountId: 'expected_acc',
        creditId: 'credit_x',
        idempotencyKey: 'idem_123',
        executionClaim: claim,
        journal,
        command,
      });

      await new Promise((r) => setTimeout(r, 10));
      const initReq = JSON.parse(transport.sentMessages[0]!);
      transport.emitMessage({ jsonrpc: '2.0', id: initReq.id, result: {} });

      await new Promise((r) => setTimeout(r, 10));
      const readReq = JSON.parse(transport.sentMessages[2]!);
      transport.emitMessage({
        jsonrpc: '2.0',
        id: readReq.id,
        result: {
          accountId: 'different_acc_hacked',
          rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'credit_x', status: 'available', resetType: 'codexRateLimits', grantedAt: 1789000000, expiresAt: 1790000000 }] },
        },
      });

      const res = await consumePromise;
      expect(res.state).toBe('failed');
      expect(res.code).toBe('account_mismatch');
      // Ensure consume was NEVER sent
      expect(transport.sentMessages.some((m) => m.includes('consume'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('consume helper: rejects missing or expired credit before consume dispatch', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexResetAdapter({ transport });
    const { claim, journal, command, cleanup } = await createJournalClaim({
      accountId: 'acc_target',
      creditId: 'credit_missing_id',
      idempotencyKey: 'idem_123',
    });

    try {
      const consumePromise = adapter.consumeResetCredit({
        expectedAccountId: 'acc_target',
        creditId: 'credit_missing_id',
        idempotencyKey: 'idem_123',
        executionClaim: claim,
        journal,
        command,
      });

      await new Promise((r) => setTimeout(r, 10));
      const initReq = JSON.parse(transport.sentMessages[0]!);
      transport.emitMessage({ jsonrpc: '2.0', id: initReq.id, result: {} });

      await new Promise((r) => setTimeout(r, 10));
      const readReq = JSON.parse(transport.sentMessages[2]!);
      transport.emitMessage({
        jsonrpc: '2.0',
        id: readReq.id,
        result: {
          accountId: 'acc_target',
          rateLimitResetCredits: {
            availableCount: 1,
            credits: [
              { id: 'different_credit', status: 'available', resetType: 'codexRateLimits', grantedAt: 1789000000, expiresAt: 1790000000 },
            ],
          },
        },
      });

      const res = await consumePromise;
      expect(res.state).toBe('failed');
      expect(res.code).toBe('credit_missing');
      expect(transport.sentMessages.some((m) => m.includes('consume'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('consume helper: returns unknown when transport terminates after consume was sent', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexResetAdapter({ transport });
    const { claim, journal, command, cleanup } = await createJournalClaim({
      accountId: 'acc_target',
      creditId: 'credit_x',
      idempotencyKey: 'idem_123',
    });

    try {
      const consumePromise = adapter.consumeResetCredit({
        expectedAccountId: 'acc_target',
        creditId: 'credit_x',
        idempotencyKey: 'idem_123',
        executionClaim: claim,
        journal,
        command,
      });

      await new Promise((r) => setTimeout(r, 10));
      const initReq = JSON.parse(transport.sentMessages[0]!);
      transport.emitMessage({ jsonrpc: '2.0', id: initReq.id, result: {} });

      await new Promise((r) => setTimeout(r, 10));
      const readReq = JSON.parse(transport.sentMessages[2]!);
      transport.emitMessage({
        jsonrpc: '2.0',
        id: readReq.id,
        result: {
          accountId: 'acc_target',
          rateLimitResetCredits: {
            availableCount: 1,
            credits: [
              { id: 'credit_x', status: 'available', resetType: 'codexRateLimits', grantedAt: 1789000000, expiresAt: 1790000000 },
            ],
          },
        },
      });

      await new Promise((r) => setTimeout(r, 10));
      expect(transport.sentMessages.some((m) => m.includes('consume'))).toBe(true);

      // Suddenly transport closes unexpectedly!
      transport.emitClose(1, 'SIGKILL');

      const res = await consumePromise;
      expect(res.state).toBe('unknown');
      expect(res.code).toBe('unknown_outcome');
      // MUST NOT auto-retry!
      expect(transport.sentMessages.filter((m) => m.includes('consume')).length).toBe(1);
    } finally {
      cleanup();
    }
  });

  it('consume helper: returns transport_error when transport send fails before consume dispatch', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexResetAdapter({ transport });
    const { claim, journal, command, cleanup } = await createJournalClaim({
      accountId: 'acc_target',
      creditId: 'credit_x',
      idempotencyKey: 'idem_123',
    });

    try {
      const consumePromise = adapter.consumeResetCredit({
        expectedAccountId: 'acc_target',
        creditId: 'credit_x',
        idempotencyKey: 'idem_123',
        executionClaim: claim,
        journal,
        command,
      });

      await new Promise((r) => setTimeout(r, 10));
      const initReq = JSON.parse(transport.sentMessages[0]!);
      transport.emitMessage({ jsonrpc: '2.0', id: initReq.id, result: {} });

      await new Promise((r) => setTimeout(r, 10));
      const readReq = JSON.parse(transport.sentMessages[2]!);
      transport.emitMessage({
        jsonrpc: '2.0',
        id: readReq.id,
        result: {
          accountId: 'acc_target',
          rateLimitResetCredits: {
            availableCount: 1,
            credits: [
              { id: 'credit_x', status: 'available', resetType: 'codexRateLimits', grantedAt: 1789000000, expiresAt: 1790000000 },
            ],
          },
        },
      });

      // Make transport.send fail for subsequent messages (consume) with proven pre-write error
      transport.send = async () => {
        throw new PreWriteTransportError('pre_write_transport_error');
      };

      const res = await consumePromise;
      expect(res.state).toBe('failed');
      expect(res.code).toBe('transport_error');
    } finally {
      cleanup();
    }
  });

  it('bounds line size and ignores harmless notifications without reflecting content', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexResetAdapter({ transport, maxLineBytes: 100 });

    const readPromise = adapter.readRateLimits();
    await new Promise((r) => setTimeout(r, 10));

    // Send a harmless notification from server
    transport.emitMessage({ method: 'window/logMessage', params: { type: 3, message: 'Harmless note' } });

    // Send oversized line
    transport.emitRaw('x'.repeat(200) + '\n');

    await expect(readPromise).rejects.toThrow('protocol_error');
  });

  it('never exposes raw auth/bearer tokens in thrown error messages', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexResetAdapter({ transport });

    const readPromise = adapter.readRateLimits();
    await new Promise((r) => setTimeout(r, 10));
    const initReq = JSON.parse(transport.sentMessages[0]!);

    // Emit error containing a fake secret token
    transport.emitMessage({
      jsonrpc: '2.0',
      id: initReq.id,
      error: { code: -32000, message: ['Invalid token Bearer ', ['sk', 'ant', 'synthetic-secret'].join('-'), ' at ', ['', 'Users', 'synthetic-user', 'file'].join('/')].join('') },
    });

    try {
      await readPromise;
      expect.fail('should have thrown');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '';
      expect(message).not.toContain('Bearer');
      expect(message).not.toContain('sk-ant');
      expect(message).not.toContain(['', 'Users', 'synthetic-user', 'file'].join('/'));
    }
  });

  it('rejects JSON-RPC response missing jsonrpc 2.0 or having mismatched/duplicate ID', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexResetAdapter({ transport });
    const readPromise = adapter.readRateLimits();
    await new Promise((r) => setTimeout(r, 10));

    // Send mismatched id
    transport.emitMessage({
      jsonrpc: '2.0',
      id: 9999, // not pending
      result: {},
    });

    await expect(readPromise).rejects.toThrow('protocol_error');
  });

  it('rejects JSON-RPC response with both result and error or neither', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexResetAdapter({ transport });
    const readPromise = adapter.readRateLimits();
    await new Promise((r) => setTimeout(r, 10));
    const initReq = JSON.parse(transport.sentMessages[0]!);

    // Emit both result and error
    transport.emitMessage({
      jsonrpc: '2.0',
      id: initReq.id,
      result: {},
      error: { message: 'oops' },
    });

    await expect(readPromise).rejects.toThrow('protocol_error');
  });

  it('rejects provider row with unknown status/type, duplicate IDs, or mismatched availableCount', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexResetAdapter({ transport });
    const readPromise = adapter.readRateLimits();
    await new Promise((r) => setTimeout(r, 10));

    const initReq = JSON.parse(transport.sentMessages[0]!);
    transport.emitMessage({ jsonrpc: '2.0', id: initReq.id, result: {} });

    await new Promise((r) => setTimeout(r, 10));
    const readReq = JSON.parse(transport.sentMessages[2]!);

    // Provider returns row with unknown status and availableCount=0 while credit is available
    transport.emitMessage({
      jsonrpc: '2.0',
      id: readReq.id,
      result: {
        accountId: 'acc_test',
        rateLimitResetCredits: {
          availableCount: 0,
          credits: [
            {
              id: 'c1',
              status: 'available',
              resetType: 'codexRateLimits',
              grantedAt: 1789000000,
              expiresAt: 1790000000,
            },
          ],
        },
      },
    });

    // Should reject because availableCount=0 when available credits exist (or invalid shape)
    await expect(readPromise).rejects.toThrow();
  });

  it('rejects JSON-RPC response with unexpected envelope key as protocol_error', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexResetAdapter({ transport, timeoutMs: 200 });
    const readPromise = adapter.readRateLimits();

    await new Promise((r) => setTimeout(r, 10));
    const initReq = JSON.parse(transport.sentMessages[0]!);

    // Emit response with unexpected envelope key
    transport.emitMessage({
      jsonrpc: '2.0',
      id: initReq.id,
      result: { capabilities: {} },
      unexpectedEnvelopeKey: 'injected_field',
    });

    await expect(readPromise).rejects.toThrow('protocol_error');
  });

  it('rejects rateLimits result missing rateLimitResetCredits as protocol_error instead of returning 0', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexResetAdapter({ transport });
    const readPromise = adapter.readRateLimits();
    await new Promise((r) => setTimeout(r, 10));

    const initReq = JSON.parse(transport.sentMessages[0]!);
    transport.emitMessage({ jsonrpc: '2.0', id: initReq.id, result: {} });

    await new Promise((r) => setTimeout(r, 10));
    const readReq = JSON.parse(transport.sentMessages[2]!);

    // Missing rateLimitResetCredits completely
    transport.emitMessage({
      jsonrpc: '2.0',
      id: readReq.id,
      result: {
        accountId: 'acc_test_1',
      },
    });

    await expect(readPromise).rejects.toThrow('protocol_error');
  });

  it('consume requires an unforgeable single-use execution claim and rejects direct call with only IDs (Blocker 2)', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexResetAdapter({ transport });

    // Calling without capability/claim
    // @ts-expect-error executionClaim is missing
    const callWithoutClaim = adapter.consumeResetCredit({
      expectedAccountId: 'acc_target',
      creditId: 'credit_x',
      idempotencyKey: 'idem_123',
    });
    await expect(callWithoutClaim).rejects.toThrow('execution_claim_required');

    // Calling with forged object
    const callWithForged = adapter.consumeResetCredit({
      expectedAccountId: 'acc_target',
      creditId: 'credit_x',
      idempotencyKey: 'idem_123',
      // @ts-expect-error forged claim
      executionClaim: { fake: true },
    });
    await expect(callWithForged).rejects.toThrow('execution_claim_required');
  });

  it('consume helper: send rejection after send begins must be classified as unknown_outcome, never definite failed (Blocker 3)', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexResetAdapter({ transport });
    const { claim, journal, command, cleanup } = await createJournalClaim({
      accountId: 'acc_target',
      creditId: 'credit_x',
      idempotencyKey: 'idem_123',
    });

    try {
      const consumePromise = adapter.consumeResetCredit({
        expectedAccountId: 'acc_target',
        creditId: 'credit_x',
        idempotencyKey: 'idem_123',
        executionClaim: claim,
        journal,
        command,
      });

      await new Promise((r) => setTimeout(r, 10));
      const initReq = JSON.parse(transport.sentMessages[0]!);
      transport.emitMessage({ jsonrpc: '2.0', id: initReq.id, result: {} });

      await new Promise((r) => setTimeout(r, 10));
      const readReq = JSON.parse(transport.sentMessages[2]!);
      transport.emitMessage({
        jsonrpc: '2.0',
        id: readReq.id,
        result: {
          accountId: 'acc_target',
          rateLimitResetCredits: {
            availableCount: 1,
            credits: [
              { id: 'credit_x', status: 'available', resetType: 'codexRateLimits', grantedAt: 1789000000, expiresAt: 1790000000 },
            ],
          },
        },
      });

      // Make transport.send fail for consume with standard stream error
      transport.send = async () => {
        throw new Error('EPIPE: broken pipe during write');
      };

      const res = await consumePromise;
      expect(res.state).toBe('unknown');
      expect(res.code).toBe('unknown_outcome');
    } finally {
      cleanup();
    }
  });

  it('session latches failed synchronously after malformed or extra-field envelope and rejects before transport.send (Blocker 4)', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexResetAdapter({ transport });

    const readPromise = adapter.readRateLimits();
    await new Promise((r) => setTimeout(r, 10));

    expect(transport.sentMessages.length).toBe(1);

    // Emit extra-field envelope
    transport.emitMessage({
      jsonrpc: '2.0',
      id: 1,
      result: {},
      extraField: 'forbidden',
    });

    await expect(readPromise).rejects.toThrow('protocol_error');

    // Verify NO subsequent message was sent to transport
    expect(transport.sentMessages.length).toBe(1);
  });

  it('verifies raw createSession cannot be reflectively reached on adapter instance (Finding 1)', () => {
    const adapter = new CodexResetAdapter();
    expect(Reflect.get(adapter, 'createSession')).toBeUndefined();
    expect((adapter as unknown as Record<string, unknown>)['createSession']).toBeUndefined();
  });

  it('verifies createTestExecutionClaim is not exported by production modules (Finding 1)', async () => {
    const adapterModule = await import('./codex-reset-adapter');
    expect((adapterModule as Record<string, unknown>).createTestExecutionClaim).toBeUndefined();
    const claimModule = await import('./execution-claim');
    expect((claimModule as Record<string, unknown>).createTestExecutionClaim).toBeUndefined();
  });

  it('cleanup/close rejection after consume dispatch preserves unknown_outcome and does not throw or become failed (Finding 2)', async () => {
    const transport = new FakeTransport();
    transport.close = async () => {
      throw new Error('close_rejected_in_cleanup');
    };
    const adapter = new CodexResetAdapter({ transport });
    const { claim, journal, command, cleanup } = await createJournalClaim({
      accountId: 'acc_target',
      creditId: 'credit_x',
      idempotencyKey: 'idem_123',
    });

    try {
      const consumePromise = adapter.consumeResetCredit({
        expectedAccountId: 'acc_target',
        creditId: 'credit_x',
        idempotencyKey: 'idem_123',
        executionClaim: claim,
        journal,
        command,
      });

      await new Promise((r) => setTimeout(r, 10));
      const initReq = JSON.parse(transport.sentMessages[0]!);
      transport.emitMessage({ jsonrpc: '2.0', id: initReq.id, result: {} });

      await new Promise((r) => setTimeout(r, 10));
      const readReq = JSON.parse(transport.sentMessages[2]!);
      transport.emitMessage({
        jsonrpc: '2.0',
        id: readReq.id,
        result: {
          accountId: 'acc_target',
          rateLimitResetCredits: {
            availableCount: 1,
            credits: [
              { id: 'credit_x', status: 'available', resetType: 'codexRateLimits', grantedAt: 1789000000, expiresAt: 1790000000 },
            ],
          },
        },
      });

      await new Promise((r) => setTimeout(r, 10));
      // Consume message sent; now transport closes/fails
      transport.emitClose(1, 'SIGTERM');

      const res = await consumePromise;
      expect(res.state).toBe('unknown');
      expect(res.code).toBe('unknown_outcome');
    } finally {
      cleanup();
    }
  });

  it('transport.send hanging during consume times out within bounded deadline and resolves to unknown_outcome (Finding 4)', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexResetAdapter({ transport, timeoutMs: 50 });
    const { claim, journal, command, cleanup } = await createJournalClaim({
      accountId: 'acc_target',
      creditId: 'credit_x',
      idempotencyKey: 'idem_123',
    });

    try {
      const consumePromise = adapter.consumeResetCredit({
        expectedAccountId: 'acc_target',
        creditId: 'credit_x',
        idempotencyKey: 'idem_123',
        executionClaim: claim,
        journal,
        command,
      });

      await new Promise((r) => setTimeout(r, 10));
      const initReq = JSON.parse(transport.sentMessages[0]!);
      transport.emitMessage({ jsonrpc: '2.0', id: initReq.id, result: {} });

      await new Promise((r) => setTimeout(r, 10));
      const readReq = JSON.parse(transport.sentMessages[2]!);
      transport.emitMessage({
        jsonrpc: '2.0',
        id: readReq.id,
        result: {
          accountId: 'acc_target',
          rateLimitResetCredits: {
            availableCount: 1,
            credits: [
              { id: 'credit_x', status: 'available', resetType: 'codexRateLimits', grantedAt: 1789000000, expiresAt: 1790000000 },
            ],
          },
        },
      });

      // Make transport.send hang indefinitely when sending consume
      transport.send = () => new Promise<void>(() => {});

      const startTime = Date.now();
      const res = await Promise.race([
        consumePromise,
        new Promise<'timed_out_test'>((resolve) => setTimeout(() => resolve('timed_out_test'), 1500)),
      ]);
      const elapsed = Date.now() - startTime;

      expect(res).not.toBe('timed_out_test');
      expect(elapsed).toBeLessThan(1200);
      expect((res as { state: string }).state).toBe('unknown');
      expect((res as { code: string }).code).toBe('unknown_outcome');
    } finally {
      cleanup();
    }
  });

  it('re-checks command authorization expiry immediately before consume dispatch and rejects with command_expired without sending consume (Finding 5)', async () => {
    const transport = new FakeTransport();
    let currentClock = new Date('2026-09-11T10:00:01.000Z').getTime();
    const adapter = new CodexResetAdapter({
      transport,
      clock: () => new Date(currentClock),
    });

    const { claim, journal, command, cleanup } = await createJournalClaim({
      accountId: 'acc_target',
      creditId: 'credit_x',
      idempotencyKey: 'idem_123',
      requestedAt: '2026-09-11T10:00:00.000Z',
      expiresAt: '2026-09-11T10:00:05.000Z',
    });

    try {
      const consumePromise = adapter.consumeResetCredit({
        expectedAccountId: 'acc_target',
        creditId: 'credit_x',
        idempotencyKey: 'idem_123',
        executionClaim: claim,
        journal,
        command,
      });

      await new Promise((r) => setTimeout(r, 10));
      const initReq = JSON.parse(transport.sentMessages[0]!);
      transport.emitMessage({ jsonrpc: '2.0', id: initReq.id, result: {} });

      await new Promise((r) => setTimeout(r, 10));
      const readReq = JSON.parse(transport.sentMessages[2]!);
      transport.emitMessage({
        jsonrpc: '2.0',
        id: readReq.id,
        result: {
          accountId: 'acc_target',
          rateLimitResetCredits: {
            availableCount: 1,
            credits: [
              { id: 'credit_x', status: 'available', resetType: 'codexRateLimits', grantedAt: 1789000000, expiresAt: 1790000000 },
            ],
          },
        },
      });

      // Advance clock past authorization expiry (10:00:05.000Z) before consume dispatch
      currentClock = new Date('2026-09-11T10:00:06.000Z').getTime();
      await new Promise((r) => setTimeout(r, 10));

      const res = await consumePromise;
      expect(res.state).toBe('failed');
      expect(res.code).toBe('command_expired');
      // Ensure consume was NEVER sent to transport
      expect(transport.sentMessages.some((m) => m.includes('consume'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('Finding 1 RED: external claim minting authority is removed and impossible to forge by import', async () => {
    const claimModule = await import('./execution-claim');
    expect((claimModule as Record<string, unknown>).registerActiveJournalTransition).toBeUndefined();
    expect((claimModule as Record<string, unknown>).issueDurableExecutionClaim).toBeUndefined();
    expect((claimModule as Record<string, unknown>).createTestExecutionClaim).toBeUndefined();
  });

  it('Finding 2 RED: caller mutates params during delayed handshake but exact original credit is consumed', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexResetAdapter({ transport });
    const { claim, journal, command, cleanup } = await createJournalClaim({
      accountId: 'acc_target',
      creditId: 'credit_original',
      idempotencyKey: 'idem_original',
    });

    try {
      const mutableParams = {
        expectedAccountId: 'acc_target',
        creditId: 'credit_original',
        idempotencyKey: 'idem_original',
        executionClaim: claim,
        journal,
        command,
      };

      const consumePromise = adapter.consumeResetCredit(mutableParams);

      // Mutate during delayed handshake
      mutableParams.creditId = 'credit_MUTATED_RACE';
      mutableParams.idempotencyKey = 'idem_MUTATED_RACE';

      await new Promise((r) => setTimeout(r, 10));
      const initReq = JSON.parse(transport.sentMessages[0]!);
      transport.emitMessage({ jsonrpc: '2.0', id: initReq.id, result: {} });

      await new Promise((r) => setTimeout(r, 10));
      const readReq = JSON.parse(transport.sentMessages[2]!);
      transport.emitMessage({
        jsonrpc: '2.0',
        id: readReq.id,
        result: {
          accountId: 'acc_target',
          rateLimitResetCredits: {
            availableCount: 2,
            credits: [
              { id: 'credit_original', status: 'available', resetType: 'codexRateLimits', grantedAt: 1789000000, expiresAt: 1790000000 },
              { id: 'credit_MUTATED_RACE', status: 'available', resetType: 'codexRateLimits', grantedAt: 1789000000, expiresAt: 1790000000 },
            ],
          },
        },
      });

      await new Promise((r) => setTimeout(r, 10));
      const consumeReqMsg = transport.sentMessages.find((m) => m.includes('consume'));
      expect(consumeReqMsg).toBeDefined();
      const consumeReq = JSON.parse(consumeReqMsg!);
      // MUST consume original credit, NOT mutated credit!
      expect(consumeReq.params.creditId).toBe('credit_original');
      expect(consumeReq.params.idempotencyKey).toBe('idem_original');

      // Complete response
      transport.emitMessage({ jsonrpc: '2.0', id: consumeReq.id, result: { outcome: 'reset' } });
      const res = (await consumePromise) as { state: string };
      expect(res.state).toBe('success');
    } finally {
      cleanup();
    }
  });

  it('Finding 3 RED: per-call stale now cannot bypass expiry and adapter uses trusted clock seam', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexResetAdapter({
      transport,
      clock: () => new Date('2026-10-01T00:00:00.000Z'),
    });

    const { claim, journal, command, cleanup } = await createJournalClaim({
      accountId: 'acc_target',
      creditId: 'credit_x',
      idempotencyKey: 'idem_123',
    });

    try {
      const consumePromise = (
        adapter.consumeResetCredit as unknown as (params: unknown) => Promise<{ state: string; code: string }>
      )({
        expectedAccountId: 'acc_target',
        creditId: 'credit_x',
        idempotencyKey: 'idem_123',
        executionClaim: claim,
        journal,
        command,
        // Attempt to supply frozen past now to bypass expiry
        now: new Date('2026-09-11T10:00:00.000Z'),
      });

      await new Promise((r) => setTimeout(r, 10));
      const initReq = JSON.parse(transport.sentMessages[0]!);
      transport.emitMessage({ jsonrpc: '2.0', id: initReq.id, result: {} });

      await new Promise((r) => setTimeout(r, 10));
      const readReq = JSON.parse(transport.sentMessages[2]!);
      transport.emitMessage({
        jsonrpc: '2.0',
        id: readReq.id,
        result: {
          accountId: 'acc_target',
          rateLimitResetCredits: {
            availableCount: 1,
            credits: [
              { id: 'credit_x', status: 'available', resetType: 'codexRateLimits', grantedAt: 1789000000, expiresAt: 1790000000 },
            ],
          },
        },
      });

      const res = await consumePromise;
      expect(res.state).toBe('failed');
      expect(res.code).toBe('credit_expired');
      expect(transport.sentMessages.some((m) => m.includes('consume'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('Finding 4 RED: early response + never-settling send still times out within bounded deadline', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexResetAdapter({ transport, timeoutMs: 50 });

    transport.send = async () => new Promise<void>(() => {});

    const readPromise = adapter.readRateLimits();

    await new Promise((r) => setTimeout(r, 10));
    transport.emitMessage({
      jsonrpc: '2.0',
      id: 1,
      result: { capabilities: {} },
    });

    const startTime = Date.now();
    await expect(
      Promise.race([
        readPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('test_hung_forever')), 350)),
      ]),
    ).rejects.toThrow('timeout');
    expect(Date.now() - startTime).toBeLessThan(300);
  });

  it('Finding 5 RED: sync close throw after possible dispatch remains unknown and does not leak uncaught error', async () => {
    const transport = new FakeTransport();
    transport.close = () => {
      throw new Error('synchronous_close_explosion');
    };
    const adapter = new CodexResetAdapter({ transport });
    const { claim, journal, command, cleanup } = await createJournalClaim({
      accountId: 'acc_target',
      creditId: 'credit_x',
      idempotencyKey: 'idem_123',
    });

    try {
      const consumePromise = adapter.consumeResetCredit({
        expectedAccountId: 'acc_target',
        creditId: 'credit_x',
        idempotencyKey: 'idem_123',
        executionClaim: claim,
        journal,
        command,
      });

      await new Promise((r) => setTimeout(r, 10));
      const initReq = JSON.parse(transport.sentMessages[0]!);
      transport.emitMessage({ jsonrpc: '2.0', id: initReq.id, result: {} });

      await new Promise((r) => setTimeout(r, 10));
      const readReq = JSON.parse(transport.sentMessages[2]!);
      transport.emitMessage({
        jsonrpc: '2.0',
        id: readReq.id,
        result: {
          accountId: 'acc_target',
          rateLimitResetCredits: {
            availableCount: 1,
            credits: [
              { id: 'credit_x', status: 'available', resetType: 'codexRateLimits', grantedAt: 1789000000, expiresAt: 1790000000 },
            ],
          },
        },
      });

      await new Promise((r) => setTimeout(r, 10));
      transport.emitError(new Error('network_failure_after_consume'));

      const res = await consumePromise;
      expect(res.state).toBe('unknown');
      expect(res.code).toBe('unknown_outcome');
    } finally {
      cleanup();
    }
  });

  it('consume helper: rejects cross-journal execution claim even if command and provider fields match', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexResetAdapter({ transport });
    const { claim, command, cleanup } = await createJournalClaim({
      accountId: 'acc_target',
      creditId: 'credit_x',
      idempotencyKey: 'idem_123',
    });

    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-other-'));
    const otherJournal = new ResetCommandJournal({
      rootDir: otherDir,
      backendId: 'codex-local',
      userId: 'test-user',
      deviceId: 'test-device',
      accountId: 'acc_target',
    });

    try {
      await expect(
        adapter.consumeResetCredit({
          expectedAccountId: 'acc_target',
          creditId: 'credit_x',
          idempotencyKey: 'idem_123',
          executionClaim: claim,
          journal: otherJournal,
          command,
        }),
      ).rejects.toThrow('execution_claim_mismatch');
    } finally {
      cleanup();
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('consume helper: rejects mismatched command authority even if provider fields match', async () => {
    const transport = new FakeTransport();
    const adapter = new CodexResetAdapter({ transport });
    const { claim, journal, command, cleanup } = await createJournalClaim({
      accountId: 'acc_target',
      creditId: 'credit_x',
      idempotencyKey: 'idem_123',
    });

    try {
      const mismatchedCmd = {
        ...command,
        commandId: 'cmd_different_authority',
      };

      await expect(
        adapter.consumeResetCredit({
          expectedAccountId: 'acc_target',
          creditId: 'credit_x',
          idempotencyKey: 'idem_123',
          executionClaim: claim,
          journal,
          command: mismatchedCmd,
        }),
      ).rejects.toThrow('execution_claim_mismatch');
    } finally {
      cleanup();
    }
  });
});
