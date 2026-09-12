import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ResetCommandJournal,
  type ResetCommandJournalOptions,
} from './reset-command-journal';
import type { ResetCreditCommand, ResetCreditResult } from '@94ai/core';

describe('ResetCommandJournal', () => {
  let testDir: string;
  const options: ResetCommandJournalOptions = {
    rootDir: '',
    backendId: 'prod-backend',
    userId: 'user_123',
    deviceId: 'mac_dev_456',
    accountId: 'acc_codex_789',
  };

  const sampleCommand: ResetCreditCommand = {
    version: 1,
    commandId: 'cmd_100',
    idempotencyKey: 'idem_200',
    creditId: 'credit_300',
    accountId: 'acc_codex_789',
    targetDeviceId: 'mac_dev_456',
    userId: 'user_123',
    backendId: 'prod-backend',
    requestedAt: '2026-09-11T10:00:00.000Z',
    expiresAt: '2026-09-11T10:05:00.000Z',
  };

  const sampleResult: ResetCreditResult = {
    version: 1,
    commandId: 'cmd_100',
    idempotencyKey: 'idem_200',
    creditId: 'credit_300',
    accountId: 'acc_codex_789',
    targetDeviceId: 'mac_dev_456',
    userId: 'user_123',
    backendId: 'prod-backend',
    state: 'success',
    code: 'reset',
    executedAt: '2026-09-11T10:00:10.000Z',
    completedAt: '2026-09-11T10:00:11.000Z',
  };

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-journal-test-'));
    options.rootDir = testDir;
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('initializes and saves prepared command with 0600 mode', async () => {
    const journal = new ResetCommandJournal(options);
    const entry = await journal.prepareCommand(sampleCommand);
    expect(entry.state).toBe('prepared');
    expect(entry.command.commandId).toBe(sampleCommand.commandId);

    const journalFile = path.join(testDir, 'reset-journal.json');
    expect(fs.existsSync(journalFile)).toBe(true);
    const stat = fs.statSync(journalFile);
    // 0o600 is 33152 on POSIX (S_IFREG | 0600)
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('duplicate same command (double click) returns existing entry cleanly', async () => {
    const journal = new ResetCommandJournal(options);
    const first = await journal.prepareCommand(sampleCommand);
    const second = await journal.prepareCommand(sampleCommand);
    expect(second).toEqual(first);
  });

  it('rejects duplicate commandId with mutated fields', async () => {
    const journal = new ResetCommandJournal(options);
    await journal.prepareCommand(sampleCommand);

    const mutated = { ...sampleCommand, creditId: 'different_credit_id' };
    await expect(journal.prepareCommand(mutated)).rejects.toThrow('command_mutation_rejected');
  });

  it('rejects duplicate idempotencyKey with different commandId or fields', async () => {
    const journal = new ResetCommandJournal(options);
    await journal.prepareCommand(sampleCommand);

    const conflicting = { ...sampleCommand, commandId: 'different_cmd_id' };
    await expect(journal.prepareCommand(conflicting)).rejects.toThrow('idempotency_conflict');
  });

  it('transitions prepared -> executing -> terminal', async () => {
    const journal = new ResetCommandJournal(options);
    await journal.prepareCommand(sampleCommand);

    const executingEntry = await journal.transitionToExecuting(sampleCommand.commandId);
    expect(executingEntry.state).toBe('executing');
    expect(executingEntry.executingAt).toBeDefined();

    const terminalEntry = await journal.transitionToTerminal(sampleCommand.commandId, sampleResult);
    expect(terminalEntry.state).toBe('terminal');
    expect(terminalEntry.result).toEqual(sampleResult);

    // Terminal cannot transition back
    await expect(journal.transitionToExecuting(sampleCommand.commandId)).rejects.toThrow('terminal_state_immutable');
  });

  it('crash recovery: executing entries become terminal unknown on reload and cannot execute again', async () => {
    const journal1 = new ResetCommandJournal(options);
    await journal1.prepareCommand(sampleCommand);
    await journal1.transitionToExecuting(sampleCommand.commandId);

    // Simulate process crash / reload with fresh journal instance
    const journal2 = new ResetCommandJournal(options);
    const entry = await journal2.getEntry(sampleCommand.commandId);

    expect(entry).toBeDefined();
    expect(entry?.state).toBe('terminal');
    expect(entry?.reconcileRequired).toBe(true);
    expect(entry?.result?.state).toBe('unknown');
    expect(entry?.result?.code).toBe('reconcile_required');

    // Trying to execute again must fail!
    await expect(journal2.transitionToExecuting(sampleCommand.commandId)).rejects.toThrow('terminal_state_immutable');
  });

  it('corruption fails closed without overwriting file', async () => {
    const journalFile = path.join(testDir, 'reset-journal.json');
    fs.writeFileSync(journalFile, 'INVALID CORRUPTED JSON{{{', { mode: 0o600 });

    const journal = new ResetCommandJournal(options);
    await expect(journal.prepareCommand(sampleCommand)).rejects.toThrow('invalid_journal');

    // Ensure corrupted content was NOT clobbered
    const content = fs.readFileSync(journalFile, 'utf8');
    expect(content).toBe('INVALID CORRUPTED JSON{{{');
  });

  it('rejects symlink root directory', async () => {
    const linkDir = path.join(os.tmpdir(), 'symlink-dir-' + Math.random().toString(36).substring(7));
    fs.symlinkSync(testDir, linkDir);
    try {
      expect(() => new ResetCommandJournal({ ...options, rootDir: linkDir })).toThrow('invalid_journal_root_symlink');
    } finally {
      fs.unlinkSync(linkDir);
    }
  });

  it('rejects scope identity mismatch', async () => {
    const journal = new ResetCommandJournal(options);
    const foreignCommand = { ...sampleCommand, accountId: 'different_acc' };
    await expect(journal.prepareCommand(foreignCommand)).rejects.toThrow('journal_identity_mismatch');
  });

  it('fails closed on existing lock without automatic stale-lock reclamation (Blocker 1)', async () => {
    const lockFile = path.join(testDir, 'reset-journal.lock');
    // PID 9999999 is provably non-existent
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: 9999999, nonce: 'nonce-dead', createdAt: new Date().toISOString() }),
      { mode: 0o600 },
    );

    const journal = new ResetCommandJournal(options);
    await expect(journal.prepareCommand(sampleCommand)).rejects.toThrow('journal_locked');
    expect(fs.existsSync(lockFile)).toBe(true);
  });

  it('remains locked when recorded pid is alive', async () => {
    const lockFile = path.join(testDir, 'reset-journal.lock');
    // Use current process PID which is definitely alive
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: process.pid, nonce: 'nonce-live', createdAt: new Date().toISOString() }),
      { mode: 0o600 },
    );

    const journal = new ResetCommandJournal(options);
    await expect(journal.prepareCommand(sampleCommand)).rejects.toThrow('journal_locked');
  });

  it('never breaks malformed or symlink lock', async () => {
    const lockFile = path.join(testDir, 'reset-journal.lock');
    fs.writeFileSync(lockFile, 'NOT_JSON_OR_MALFORMED', { mode: 0o600 });

    const journal = new ResetCommandJournal(options);
    await expect(journal.prepareCommand(sampleCommand)).rejects.toThrow('journal_locked');
    expect(fs.existsSync(lockFile)).toBe(true);

    fs.unlinkSync(lockFile);
    const targetFile = path.join(testDir, 'target.txt');
    fs.writeFileSync(targetFile, 'target');
    fs.symlinkSync(targetFile, lockFile);

    const journalSym = new ResetCommandJournal(options);
    await expect(journalSym.prepareCommand(sampleCommand)).rejects.toThrow('journal_locked');
  });

  it('safely cleans owned reset-journal.tmp.* files on startup under lock', async () => {
    const abandonedTmp = path.join(testDir, 'reset-journal.tmp.abandoned123');
    fs.writeFileSync(abandonedTmp, 'abandoned temp file', { mode: 0o600 });
    expect(fs.existsSync(abandonedTmp)).toBe(true);

    const journal = new ResetCommandJournal(options);
    await journal.prepareCommand(sampleCommand);
    expect(fs.existsSync(abandonedTmp)).toBe(false);
  });

  it('fails closed when too many temp files exist (>32)', async () => {
    for (let i = 0; i < 33; i++) {
      fs.writeFileSync(path.join(testDir, `reset-journal.tmp.file${i}`), 'temp', { mode: 0o600 });
    }

    expect(() => new ResetCommandJournal(options)).toThrow('journal_too_many_temp_files');
  });

  it('prepareCommand compares EVERY canonical field including version, requestedAt, expiresAt', async () => {
    const journal = new ResetCommandJournal(options);
    await journal.prepareCommand(sampleCommand);

    // Mutate requestedAt
    const mutatedRequested = { ...sampleCommand, requestedAt: '2026-09-11T10:01:00.000Z' };
    await expect(journal.prepareCommand(mutatedRequested)).rejects.toThrow('command_mutation_rejected');

    // Mutate expiresAt
    const mutatedExpires = { ...sampleCommand, expiresAt: '2026-09-11T10:07:00.000Z' };
    await expect(journal.prepareCommand(mutatedExpires)).rejects.toThrow('command_mutation_rejected');
  });

  it('validates idempotencyMap is a true bijection to entries', async () => {
    const journalFile = path.join(testDir, 'reset-journal.json');
    const corruptedBijection = {
      schemaVersion: 1,
      backendId: options.backendId,
      userId: options.userId,
      deviceId: options.deviceId,
      accountId: options.accountId,
      entries: {
        cmd_100: {
          state: 'prepared',
          command: sampleCommand,
          preparedAt: '2026-09-11T10:00:00.000Z',
        },
      },
      idempotencyMap: {
        // Orphaned idempotency key that doesn't match entry
        idem_different: 'cmd_100',
      },
    };
    fs.writeFileSync(journalFile, JSON.stringify(corruptedBijection), { mode: 0o600 });

    const journal = new ResetCommandJournal(options);
    await expect(journal.prepareCommand(sampleCommand)).rejects.toThrow('invalid_journal');
  });

  it('rejects direct prepared -> terminal provider success transition', async () => {
    const journal = new ResetCommandJournal(options);
    await journal.prepareCommand(sampleCommand);

    await expect(journal.transitionToTerminal(sampleCommand.commandId, sampleResult)).rejects.toThrow('invalid_transition');
  });

  it('expired command path transitions prepared -> terminal as command_expired via transitionToExpired and rejects provider success', async () => {
    const journal = new ResetCommandJournal(options);
    await journal.prepareCommand(sampleCommand);

    const expiredResult: ResetCreditResult = {
      version: 1,
      commandId: sampleCommand.commandId,
      idempotencyKey: sampleCommand.idempotencyKey,
      creditId: sampleCommand.creditId,
      accountId: sampleCommand.accountId,
      targetDeviceId: sampleCommand.targetDeviceId,
      userId: sampleCommand.userId,
      backendId: sampleCommand.backendId,
      state: 'failed',
      code: 'command_expired',
      executedAt: '2026-09-11T10:00:10.000Z',
      completedAt: '2026-09-11T10:00:10.000Z',
    };

    // Attempting to use transitionToExpired with a success result must fail
    await expect(journal.transitionToExpired(sampleCommand.commandId, sampleResult)).rejects.toThrow('invalid_transition');

    // transitionToExpired with command_expired succeeds
    const entry = await journal.transitionToExpired(sampleCommand.commandId, expiredResult);
    expect(entry.state).toBe('terminal');
    expect(entry.result?.code).toBe('command_expired');
  });

  it('rejects forged terminal success result missing executingAt on reload (Blocker 5)', async () => {
    const journalFile = path.join(testDir, 'reset-journal.json');
    const forgedJournal = {
      schemaVersion: 1,
      backendId: options.backendId,
      userId: options.userId,
      deviceId: options.deviceId,
      accountId: options.accountId,
      entries: {
        cmd_100: {
          state: 'terminal',
          command: sampleCommand,
          result: sampleResult,
          preparedAt: '2026-09-11T10:00:00.000Z',
          // executingAt missing!
          terminalAt: '2026-09-11T10:00:11.000Z',
        },
      },
      idempotencyMap: {
        idem_200: 'cmd_100',
      },
    };
    fs.writeFileSync(journalFile, JSON.stringify(forgedJournal), { mode: 0o600 });

    const journal = new ResetCommandJournal(options);
    await expect(journal.prepareCommand(sampleCommand)).rejects.toThrow('invalid_journal');
  });

  it('rejects forged terminal result with mismatched creditId or idempotencyKey on reload (Blocker 5)', async () => {
    const journalFile = path.join(testDir, 'reset-journal.json');
    const forgedJournal = {
      schemaVersion: 1,
      backendId: options.backendId,
      userId: options.userId,
      deviceId: options.deviceId,
      accountId: options.accountId,
      entries: {
        cmd_100: {
          state: 'terminal',
          command: sampleCommand,
          result: {
            ...sampleResult,
            creditId: 'forged_credit_id',
          },
          preparedAt: '2026-09-11T10:00:00.000Z',
          executingAt: '2026-09-11T10:00:10.000Z',
          terminalAt: '2026-09-11T10:00:11.000Z',
        },
      },
      idempotencyMap: {
        idem_200: 'cmd_100',
      },
    };
    fs.writeFileSync(journalFile, JSON.stringify(forgedJournal), { mode: 0o600 });

    const journal = new ResetCommandJournal(options);
    await expect(journal.prepareCommand(sampleCommand)).rejects.toThrow('journal_identity_mismatch');
  });

  it('Finding 6 RED: __proto__ in journal JSON is rejected and yields no valid claim', async () => {
    const journalFile = path.join(testDir, 'reset-journal.json');
    const protoPollutionJournal = {
      schemaVersion: 1,
      backendId: options.backendId,
      userId: options.userId,
      deviceId: options.deviceId,
      accountId: options.accountId,
      entries: JSON.parse('{"__proto__": {"state": "executing"}}'),
      idempotencyMap: {},
    };
    fs.writeFileSync(journalFile, JSON.stringify(protoPollutionJournal), { mode: 0o600 });

    const journal = new ResetCommandJournal(options);
    await expect(journal.prepareCommand(sampleCommand)).rejects.toThrow('invalid_journal');
  });

  it('Finding 6 RED: dangerous prototype property names as commandId or idempotencyKey are rejected', async () => {
    const journal = new ResetCommandJournal(options);
    const dangerousCmd: ResetCreditCommand = {
      ...sampleCommand,
      commandId: '__proto__',
    };
    await expect(journal.prepareCommand(dangerousCmd)).rejects.toThrow();

    const dangerousIdem: ResetCreditCommand = {
      ...sampleCommand,
      idempotencyKey: 'constructor',
    };
    await expect(journal.prepareCommand(dangerousIdem)).rejects.toThrow();
  });

  it('Finding 7 RED: ResetCommandJournal constructor and prepareCommand reject email and auth strings', async () => {
    expect(() => new ResetCommandJournal({ ...options, userId: ['dev', 'example.com'].join('@') })).toThrow();
    expect(() => new ResetCommandJournal({ ...options, accountId: 'Bearer token-123' })).toThrow();

    const journal = new ResetCommandJournal(options);
    const emailCommand = { ...sampleCommand, userId: ['attacker', 'corp.com'].join('@') };
    await expect(journal.prepareCommand(emailCommand)).rejects.toThrow();
  });

  it('rejects auth_, credential_, session= identifiers in journal constructor and prepareCommand before persistence', async () => {
    expect(() => new ResetCommandJournal({ ...options, accountId: 'auth_acc' })).toThrow();
    expect(() => new ResetCommandJournal({ ...options, deviceId: 'credential-device' })).toThrow();
    expect(() => new ResetCommandJournal({ ...options, userId: 'session_user' })).toThrow();

    const journal = new ResetCommandJournal(options);
    const forbiddenCmd = { ...sampleCommand, creditId: 'session=xyz' };
    await expect(journal.prepareCommand(forbiddenCmd)).rejects.toThrow();
  });

  it('executing -> transitionToTerminal(command_expired) is rejected with invalid_transition while transitionToExpired still succeeds from prepared', async () => {
    const journal = new ResetCommandJournal(options);
    await journal.prepareCommand(sampleCommand);

    const expiredResult: ResetCreditResult = {
      version: 1,
      commandId: sampleCommand.commandId,
      idempotencyKey: sampleCommand.idempotencyKey,
      creditId: sampleCommand.creditId,
      accountId: sampleCommand.accountId,
      targetDeviceId: sampleCommand.targetDeviceId,
      userId: sampleCommand.userId,
      backendId: sampleCommand.backendId,
      state: 'failed',
      code: 'command_expired',
      executedAt: '2026-09-11T10:00:10.000Z',
      completedAt: '2026-09-11T10:00:10.000Z',
    };

    // 1. Move to executing
    await journal.transitionToExecuting(sampleCommand.commandId);

    // 2. Attempt transitionToTerminal with command_expired from executing -> MUST BE REJECTED
    await expect(journal.transitionToTerminal(sampleCommand.commandId, expiredResult)).rejects.toThrow('invalid_transition');

    // 3. For another prepared command, transitionToExpired still succeeds
    const preparedCmd = {
      ...sampleCommand,
      commandId: 'cmd_prepared_expire',
      idempotencyKey: 'idem_prepared_expire',
    };
    await journal.prepareCommand(preparedCmd);
    const expiredResultForPrepared: ResetCreditResult = {
      ...expiredResult,
      commandId: preparedCmd.commandId,
      idempotencyKey: preparedCmd.idempotencyKey,
    };
    const expiredEntry = await journal.transitionToExpired(preparedCmd.commandId, expiredResultForPrepared);
    expect(expiredEntry.state).toBe('terminal');
    expect(expiredEntry.result?.code).toBe('command_expired');
  });

  it('verifyAndConsumeExecutionClaim enforces full command binding and rejects command mismatch even if provider fields match', async () => {
    const journal = new ResetCommandJournal(options);
    await journal.prepareCommand(sampleCommand);
    const executing = await journal.transitionToExecuting(sampleCommand.commandId);
    const claim = executing.executionClaim!;

    const mismatchedCmd = {
      ...sampleCommand,
      expiresAt: '2026-09-11T10:09:00.000Z', // Different expiresAt
    };

    const { verifyAndConsumeExecutionClaim } = await import('./reset-command-journal');
    expect(() =>
      verifyAndConsumeExecutionClaim(claim, {
        journal,
        command: mismatchedCmd,
        accountId: sampleCommand.accountId,
        creditId: sampleCommand.creditId,
        idempotencyKey: sampleCommand.idempotencyKey,
      }),
    ).toThrow('execution_claim_mismatch');
  });

  it('verifyAndConsumeExecutionClaim enforces issuing journal instance and rejects cross-journal claim even if command and provider fields match', async () => {
    const journal1 = new ResetCommandJournal(options);
    await journal1.prepareCommand(sampleCommand);
    const executing = await journal1.transitionToExecuting(sampleCommand.commandId);
    const claim = executing.executionClaim!;

    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-journal-other-'));
    try {
      const journal2 = new ResetCommandJournal({ ...options, rootDir: otherDir });
      const { verifyAndConsumeExecutionClaim } = await import('./reset-command-journal');

      expect(() =>
        verifyAndConsumeExecutionClaim(claim, {
          journal: journal2,
          command: sampleCommand,
          accountId: sampleCommand.accountId,
          creditId: sampleCommand.creditId,
          idempotencyKey: sampleCommand.idempotencyKey,
        }),
      ).toThrow('execution_claim_mismatch');
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });
});
