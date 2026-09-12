import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ResetCreditCommand } from '@94ai/core';
import { ResetCommandJournal } from './reset-command-journal';
import { executeResetCreditCommand } from './reset-command-executor';

describe('executeResetCreditCommand', () => {
  let testDir: string;
  let journal: ResetCommandJournal;

  const validCommand: ResetCreditCommand = {
    version: 1,
    commandId: 'cmd_exec_1',
    idempotencyKey: 'idem_exec_1',
    creditId: 'credit_x',
    accountId: 'acc_target',
    targetDeviceId: 'device_mac',
    userId: 'user_1',
    backendId: 'backend_prod',
    requestedAt: '2026-09-11T10:00:00.000Z',
    expiresAt: '2026-09-11T10:05:00.000Z',
  };

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-exec-test-'));
    journal = new ResetCommandJournal({
      rootDir: testDir,
      backendId: validCommand.backendId,
      userId: validCommand.userId,
      deviceId: validCommand.targetDeviceId,
      accountId: validCommand.accountId,
    });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('calls adapter once on happy path and transitions journal to terminal success', async () => {
    let adapterCalls = 0;
    const fakeAdapter = {
      consumeResetCredit: async () => {
        adapterCalls++;
        return { state: 'success' as const, code: 'reset' };
      },
    };

    const res = await executeResetCreditCommand({
      journal,
      adapter: fakeAdapter,
      command: validCommand,
      now: new Date('2026-09-11T10:01:00.000Z'),
    });

    expect(adapterCalls).toBe(1);
    expect(res.state).toBe('success');
    expect(res.code).toBe('reset');

    const entry = await journal.getEntry(validCommand.commandId);
    expect(entry?.state).toBe('terminal');
    expect(entry?.result?.code).toBe('reset');
  });

  it('double call: second call returns prior terminal result and never calls adapter again (call count = 1)', async () => {
    let adapterCalls = 0;
    const fakeAdapter = {
      consumeResetCredit: async () => {
        adapterCalls++;
        return { state: 'success' as const, code: 'reset' };
      },
    };

    const res1 = await executeResetCreditCommand({
      journal,
      adapter: fakeAdapter,
      command: validCommand,
      now: new Date('2026-09-11T10:01:00.000Z'),
    });

    const res2 = await executeResetCreditCommand({
      journal,
      adapter: fakeAdapter,
      command: validCommand,
      now: new Date('2026-09-11T10:01:05.000Z'),
    });

    expect(adapterCalls).toBe(1);
    expect(res2).toEqual(res1);
  });

  it('duplicate command with changed timestamp or fields throws mutation rejected and never calls adapter', async () => {
    let adapterCalls = 0;
    const fakeAdapter = {
      consumeResetCredit: async () => {
        adapterCalls++;
        return { state: 'success' as const, code: 'reset' };
      },
    };

    await executeResetCreditCommand({
      journal,
      adapter: fakeAdapter,
      command: validCommand,
      now: new Date('2026-09-11T10:01:00.000Z'),
    });
    expect(adapterCalls).toBe(1);

    const mutatedCommand = {
      ...validCommand,
      requestedAt: '2026-09-11T10:02:00.000Z',
    };

    await expect(
      executeResetCreditCommand({
        journal,
        adapter: fakeAdapter,
        command: mutatedCommand,
        now: new Date('2026-09-11T10:02:05.000Z'),
      }),
    ).rejects.toThrow('command_mutation_rejected');

    expect(adapterCalls).toBe(1);
  });

  it('idempotency collision rejects before adapter call', async () => {
    let adapterCalls = 0;
    const fakeAdapter = {
      consumeResetCredit: async () => {
        adapterCalls++;
        return { state: 'success' as const, code: 'reset' };
      },
    };

    await executeResetCreditCommand({
      journal,
      adapter: fakeAdapter,
      command: validCommand,
      now: new Date('2026-09-11T10:01:00.000Z'),
    });

    const conflictingCmd = {
      ...validCommand,
      commandId: 'cmd_different_999',
    };

    await expect(
      executeResetCreditCommand({
        journal,
        adapter: fakeAdapter,
        command: conflictingCmd,
        now: new Date('2026-09-11T10:01:00.000Z'),
      }),
    ).rejects.toThrow('idempotency_conflict');

    expect(adapterCalls).toBe(1);
  });

  it('crash at executing: reload marks reconcile_required, subsequent execution returns prior unknown and never calls adapter', async () => {
    // Manually prepare and transition to executing
    await journal.prepareCommand(validCommand);
    await journal.transitionToExecuting(validCommand.commandId);

    // Simulate crash and restart
    const journal2 = new ResetCommandJournal({
      rootDir: testDir,
      backendId: validCommand.backendId,
      userId: validCommand.userId,
      deviceId: validCommand.targetDeviceId,
      accountId: validCommand.accountId,
    });

    let adapterCalls = 0;
    const fakeAdapter = {
      consumeResetCredit: async () => {
        adapterCalls++;
        return { state: 'success' as const, code: 'reset' };
      },
    };

    const res = await executeResetCreditCommand({
      journal: journal2,
      adapter: fakeAdapter,
      command: validCommand,
      now: new Date('2026-09-11T10:01:00.000Z'),
    });

    expect(adapterCalls).toBe(0); // Adapter was NEVER called!
    expect(res.state).toBe('unknown');
    expect(res.code).toBe('reconcile_required');
  });

  it('expired command fails closed without calling adapter', async () => {
    let adapterCalls = 0;
    const fakeAdapter = {
      consumeResetCredit: async () => {
        adapterCalls++;
        return { state: 'success' as const, code: 'reset' };
      },
    };

    const res = await executeResetCreditCommand({
      journal,
      adapter: fakeAdapter,
      command: validCommand,
      now: new Date('2026-09-11T10:06:00.000Z'), // Past expiresAt (10:05:00)
    });

    expect(adapterCalls).toBe(0);
    expect(res.state).toBe('failed');
    expect(res.code).toBe('command_expired');
  });

  it('existing terminal command returns prior result with adapter call count <= 1', async () => {
    let adapterCalls = 0;
    const fakeAdapter = {
      consumeResetCredit: async () => {
        adapterCalls++;
        return { state: 'success' as const, code: 'reset' };
      },
    };

    // Pre-seed terminal in journal
    await journal.prepareCommand(validCommand);
    await journal.transitionToExecuting(validCommand.commandId);
    await journal.transitionToTerminal(validCommand.commandId, {
      version: 1,
      commandId: validCommand.commandId,
      idempotencyKey: validCommand.idempotencyKey,
      creditId: validCommand.creditId,
      accountId: validCommand.accountId,
      targetDeviceId: validCommand.targetDeviceId,
      userId: validCommand.userId,
      backendId: validCommand.backendId,
      state: 'success',
      code: 'reset',
      executedAt: '2026-09-11T10:00:10.000Z',
      completedAt: '2026-09-11T10:00:11.000Z',
    });

    const res = await executeResetCreditCommand({
      journal,
      adapter: fakeAdapter,
      command: validCommand,
      now: new Date('2026-09-11T10:01:00.000Z'),
    });

    expect(adapterCalls).toBe(0);
    expect(res.state).toBe('success');
    expect(res.code).toBe('reset');
  });

  it('concurrent duplicate execution: Promise.all calls adapter exactly once and second result is bounded without triggering retry', async () => {
    let adapterCalls = 0;
    const fakeAdapter = {
      consumeResetCredit: async () => {
        adapterCalls++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { state: 'success' as const, code: 'reset' };
      },
    };

    const [res1, res2] = await Promise.all([
      executeResetCreditCommand({
        journal,
        adapter: fakeAdapter,
        command: validCommand,
        now: new Date('2026-09-11T10:01:00.000Z'),
      }),
      executeResetCreditCommand({
        journal,
        adapter: fakeAdapter,
        command: validCommand,
        now: new Date('2026-09-11T10:01:00.000Z'),
      }),
    ]);

    expect(adapterCalls).toBe(1);
    expect(res1.state).toBe('success');
    expect(res1.code).toBe('reset');
    expect(res2.state).toBe('success');
    expect(res2.code).toBe('reset');
    expect(res2.commandId).toBe(validCommand.commandId);
  });

  it('in-flight dedup never crosses identity boundaries (different userId or deviceId never share flight promise) (Blocker 6)', async () => {
    let adapterCalls = 0;
    const fakeAdapter = {
      consumeResetCredit: async () => {
        adapterCalls++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { state: 'success' as const, code: 'reset' };
      },
    };

    const user1Command: ResetCreditCommand = {
      ...validCommand,
      userId: 'user_A',
      commandId: 'shared_cmd_id',
      idempotencyKey: 'idem_user_A',
    };

    const user2Command: ResetCreditCommand = {
      ...validCommand,
      userId: 'user_B',
      commandId: 'shared_cmd_id',
      idempotencyKey: 'idem_user_B',
    };

    const journal1 = new ResetCommandJournal({
      rootDir: testDir,
      backendId: user1Command.backendId,
      userId: user1Command.userId,
      deviceId: user1Command.targetDeviceId,
      accountId: user1Command.accountId,
    });

    const testDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-exec-user2-'));
    const journal2 = new ResetCommandJournal({
      rootDir: testDir2,
      backendId: user2Command.backendId,
      userId: user2Command.userId,
      deviceId: user2Command.targetDeviceId,
      accountId: user2Command.accountId,
    });

    try {
      const [res1, res2] = await Promise.all([
        executeResetCreditCommand({
          journal: journal1,
          adapter: fakeAdapter,
          command: user1Command,
          now: new Date('2026-09-11T10:01:00.000Z'),
        }),
        executeResetCreditCommand({
          journal: journal2,
          adapter: fakeAdapter,
          command: user2Command,
          now: new Date('2026-09-11T10:01:00.000Z'),
        }),
      ]);

      expect(res1.userId).toBe('user_A');
      expect(res2.userId).toBe('user_B');
      expect(adapterCalls).toBe(2);
    } finally {
      fs.rmSync(testDir2, { recursive: true, force: true });
    }
  });

  it('unexpected adapter exception after dispatch began remains unknown_outcome and never overwrites to failed/transport_error (Finding 2)', async () => {
    const fakeAdapter = {
      consumeResetCredit: async () => {
        throw new Error('unexpected_adapter_crash_after_send');
      },
    };

    const res = await executeResetCreditCommand({
      journal,
      adapter: fakeAdapter,
      command: validCommand,
      now: new Date('2026-09-11T10:01:00.000Z'),
    });

    expect(res.state).toBe('unknown');
    expect(res.code).toBe('unknown_outcome');
  });

  it('in-flight dedup prevents collision when fields contain delimiter characters (Finding 3)', async () => {
    let adapterCalls = 0;
    const fakeAdapter = {
      consumeResetCredit: async () => {
        adapterCalls++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { state: 'success' as const, code: 'reset' };
      },
    };

    const cmd1: ResetCreditCommand = {
      ...validCommand,
      commandId: 'cmd:1',
      idempotencyKey: 'idem',
    };

    const cmd2: ResetCreditCommand = {
      ...validCommand,
      commandId: 'cmd',
      idempotencyKey: '1:idem',
    };

    const [res1, res2] = await Promise.all([
      executeResetCreditCommand({
        journal,
        adapter: fakeAdapter,
        command: cmd1,
        now: new Date('2026-09-11T10:01:00.000Z'),
      }),
      executeResetCreditCommand({
        journal,
        adapter: fakeAdapter,
        command: cmd2,
        now: new Date('2026-09-11T10:01:00.000Z'),
      }),
    ]);

    expect(res1.commandId).toBe('cmd:1');
    expect(res2.commandId).toBe('cmd');
    expect(adapterCalls).toBe(2);
  });

  it('executor passes its own journal instance and full parsed command to adapter as expected authority', async () => {
    let capturedParams: { journal?: unknown; command?: unknown } | undefined;
    const fakeAdapter = {
      consumeResetCredit: async (params: { journal?: unknown; command?: unknown }) => {
        capturedParams = params;
        return { state: 'success' as const, code: 'reset' };
      },
    };

    await executeResetCreditCommand({
      journal,
      adapter: fakeAdapter,
      command: validCommand,
      now: new Date('2026-09-11T10:01:00.000Z'),
    });

    expect(capturedParams).toBeDefined();
    expect(capturedParams?.journal).toBe(journal);
    expect(capturedParams?.command).toEqual(validCommand);
  });
});
