import { describe, expect, it, vi, beforeEach } from 'vitest';
import webPush from 'web-push';
import {
  type ResetCommandRequestRecord,
  type ResetCreditCommand,
  type ResetCreditItem,
  type ResetCreditResult,
} from '@94ai/core';
import {
  projectActionableCredits,
  runResetCommandSync,
} from './reset-command-runtime';
import { ResetCommandJournal } from './reset-command-journal';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('reset-command-runtime', () => {
  const keys = webPush.generateVAPIDKeys();
  const otherKeys = webPush.generateVAPIDKeys();
  const baseTime = '2026-09-12T10:00:00.000Z';
  const now = () => new Date(baseTime);

  let tempDir: string;
  let journal: ResetCommandJournal;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), '94ai-reset-runtime-'));
    journal = new ResetCommandJournal({
      rootDir: tempDir,
      backendId: 'test_backend',
      userId: 'test_user',
      deviceId: 'test_device',
      accountId: 'test_account',
    });
  });

  describe('projectActionableCredits', () => {
    const nowMs = Date.parse(baseTime);

    it('filters out non-available, non-codexRateLimits, and expired credits', () => {
      const items: ResetCreditItem[] = [
        { creditId: 'c1', status: 'redeemed', expiresAt: '2026-09-12T12:00:00.000Z', resetType: 'codexRateLimits' },
        { creditId: 'c2', status: 'available', expiresAt: '2026-09-12T09:00:00.000Z', resetType: 'codexRateLimits' }, // expired
        { creditId: 'c3', status: 'available', expiresAt: '2026-09-12T12:00:00.000Z', resetType: 'otherType' as never },
        { creditId: 'c4', status: 'available', expiresAt: '2026-09-12T11:00:00.000Z', resetType: 'codexRateLimits' },
      ];
      const projected = projectActionableCredits(items, nowMs);
      expect(projected).toHaveLength(1);
      expect(projected[0]!.creditId).toBe('c4');
    });

    it('sorts known expiries ascending and exposes both on earliest tie', () => {
      const items: ResetCreditItem[] = [
        { creditId: 'c1', status: 'available', expiresAt: '2026-09-12T12:00:00.000Z', resetType: 'codexRateLimits' },
        { creditId: 'c2', status: 'available', expiresAt: '2026-09-12T11:00:00.000Z', resetType: 'codexRateLimits' },
        { creditId: 'c3', status: 'available', expiresAt: '2026-09-12T11:00:00.000Z', resetType: 'codexRateLimits' },
      ];
      const projected = projectActionableCredits(items, nowMs);
      expect(projected).toHaveLength(2);
      expect(projected[0]!.expiresAt).toBe('2026-09-12T11:00:00.000Z');
      expect(projected[1]!.expiresAt).toBe('2026-09-12T11:00:00.000Z');
      expect(projected.map((c) => c.creditId).sort()).toEqual(['c2', 'c3']);
    });

    it('if unique earliest known exists, includes it plus next candidate', () => {
      const items: ResetCreditItem[] = [
        { creditId: 'c_later', status: 'available', expiresAt: '2026-09-12T13:00:00.000Z', resetType: 'codexRateLimits' },
        { creditId: 'c_earliest', status: 'available', expiresAt: '2026-09-12T11:00:00.000Z', resetType: 'codexRateLimits' },
      ];
      const projected = projectActionableCredits(items, nowMs);
      expect(projected).toHaveLength(2);
      expect(projected[0]!.creditId).toBe('c_earliest');
      expect(projected[1]!.creditId).toBe('c_later');
    });

    it('if unique earliest known exists and next is unknown, includes both', () => {
      const items: ResetCreditItem[] = [
        { creditId: 'c_unknown', status: 'available', expiresAt: null, resetType: 'codexRateLimits' },
        { creditId: 'c_earliest', status: 'available', expiresAt: '2026-09-12T11:00:00.000Z', resetType: 'codexRateLimits' },
      ];
      const projected = projectActionableCredits(items, nowMs);
      expect(projected).toHaveLength(2);
      expect(projected[0]!.creditId).toBe('c_earliest');
      expect(projected[1]!.creditId).toBe('c_unknown');
    });

    it('if only unknown-expiry candidates, includes up to 2', () => {
      const items: ResetCreditItem[] = [
        { creditId: 'u1', status: 'available', expiresAt: null, resetType: 'codexRateLimits' },
        { creditId: 'u2', status: 'available', expiresAt: null, resetType: 'codexRateLimits' },
        { creditId: 'u3', status: 'available', expiresAt: null, resetType: 'codexRateLimits' },
      ];
      const projected = projectActionableCredits(items, nowMs);
      expect(projected).toHaveLength(2);
      expect(projected.map((c) => c.creditId)).toEqual(['u1', 'u2']);
    });
  });

  describe('runResetCommandSync lifecycle', () => {
    const validCommand: ResetCreditCommand = {
      version: 1,
      commandId: 'cmd_test_1',
      idempotencyKey: 'idem_test_1',
      creditId: 'cred_test_1',
      accountId: 'test_account',
      targetDeviceId: 'test_device',
      userId: 'test_user',
      backendId: 'test_backend',
      requestedAt: '2026-09-12T10:00:00.000Z',
      expiresAt: '2026-09-12T10:08:00.000Z',
    };

    const validRequest: ResetCommandRequestRecord = {
      version: 1,
      browserId: 'browser_1',
      producerPublicKey: keys.publicKey,
      leaseExpiresAt: '2026-09-12T10:08:00.000Z',
      command: validCommand,
    };

    it('is disabled by default and NEVER calls any provider/fetch/reset APIs', async () => {
      const readRateLimits = vi.fn();
      const readRequest = vi.fn();
      const writeInventory = vi.fn();
      const executeCommand = vi.fn();

      const result = await runResetCommandSync({
        env: {},
        now,
        backendId: 'test_backend',
        userId: 'test_user',
        deviceId: 'test_device',
        keys,
        readRateLimits,
        readRequest,
        writeInventory,
        executeCommand,
      });

      expect(result.status).toBe('disabled');
      expect(readRateLimits).not.toHaveBeenCalled();
      expect(readRequest).not.toHaveBeenCalled();
      expect(writeInventory).not.toHaveBeenCalled();
      expect(executeCommand).not.toHaveBeenCalled();
    });

    it('reads rate limits, projects candidates, and writes signed inventory when enabled without request', async () => {
      const readRateLimits = vi.fn().mockResolvedValue({
        accountId: 'test_account',
        availableCount: 5,
        credits: [
          { creditId: 'c1', expiresAt: '2026-09-12T11:00:00.000Z', status: 'available', resetType: 'codexRateLimits' },
          { creditId: 'c2', expiresAt: '2026-09-12T12:00:00.000Z', status: 'available', resetType: 'codexRateLimits' },
          { creditId: 'c3', expiresAt: '2026-09-12T13:00:00.000Z', status: 'available', resetType: 'codexRateLimits' },
        ],
      });
      const readRequest = vi.fn().mockResolvedValue(undefined);
      const writeInventory = vi.fn().mockResolvedValue(undefined);

      const result = await runResetCommandSync({
        env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1' },
        now,
        backendId: 'test_backend',
        userId: 'test_user',
        deviceId: 'test_device',
        keys,
        journal,
        readRateLimits,
        readRequest,
        writeInventory,
      });

      expect(result.status).toBe('idle');
      expect(readRateLimits).toHaveBeenCalledTimes(1);
      expect(writeInventory).toHaveBeenCalledTimes(1);

      const writtenEnvelope = writeInventory.mock.calls[0]![0];
      expect(writtenEnvelope.version).toBe(1);
      expect(writtenEnvelope.type).toBe('inventory');
      expect(writtenEnvelope.publicKey).toBe(keys.publicKey);
      expect(writtenEnvelope.inventory.availableCount).toBe(5);
      // Projection max 2
      expect(writtenEnvelope.inventory.credits).toHaveLength(2);
      expect(writtenEnvelope.inventory.credits[0].creditId).toBe('c1');
      expect(writtenEnvelope.inventory.credits[1].creditId).toBe('c2');
      // Freshness <= 5 minutes
      const observed = Date.parse(writtenEnvelope.inventory.observedAt);
      const expires = Date.parse(writtenEnvelope.inventory.expiresAt);
      expect(expires - observed).toBeLessThanOrEqual(5 * 60_000);
    });

    it('rejects request with mismatched producerPublicKey, targetDeviceId, userId, backendId, or expired lease without mutation', async () => {
      const executeCommand = vi.fn();

      // Wrong public key
      const badKeyRequest = { ...validRequest, producerPublicKey: otherKeys.publicKey };
      await runResetCommandSync({
        env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1' },
        now,
        backendId: 'test_backend',
        userId: 'test_user',
        deviceId: 'test_device',
        keys,
        readRequest: vi.fn().mockResolvedValue(badKeyRequest),
        executeCommand,
      });
      expect(executeCommand).not.toHaveBeenCalled();

      // Wrong device
      const badDeviceRequest = { ...validRequest, command: { ...validCommand, targetDeviceId: 'wrong_dev' } };
      await runResetCommandSync({
        env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1' },
        now,
        backendId: 'test_backend',
        userId: 'test_user',
        deviceId: 'test_device',
        keys,
        readRequest: vi.fn().mockResolvedValue(badDeviceRequest),
        executeCommand,
      });
      expect(executeCommand).not.toHaveBeenCalled();

      // Expired lease
      const expiredRequest = {
        ...validRequest,
        leaseExpiresAt: '2026-09-12T09:59:00.000Z',
        command: { ...validCommand, expiresAt: '2026-09-12T09:59:00.000Z' },
      };
      await runResetCommandSync({
        env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1' },
        now,
        backendId: 'test_backend',
        userId: 'test_user',
        deviceId: 'test_device',
        keys,
        readRequest: vi.fn().mockResolvedValue(expiredRequest),
        executeCommand,
      });
      expect(executeCommand).not.toHaveBeenCalled();
    });

    it('republishes signed terminal result without provider mutation when terminal journal entry exists', async () => {
      // Setup prior terminal in journal
      await journal.prepareCommand(validCommand);
      await journal.transitionToExecuting(validCommand.commandId);
      const terminalOutcome: ResetCreditResult = {
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
        executedAt: '2026-09-12T10:01:00.000Z',
        completedAt: '2026-09-12T10:01:02.000Z',
      };
      await journal.transitionToTerminal(validCommand.commandId, terminalOutcome);

      const writeTerminalResult = vi.fn().mockResolvedValue(undefined);
      const executeCommand = vi.fn();

      const result = await runResetCommandSync({
        env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1' },
        now,
        backendId: 'test_backend',
        userId: 'test_user',
        deviceId: 'test_device',
        keys,
        journal,
        readRequest: vi.fn().mockResolvedValue(validRequest),
        writeTerminalResult,
        executeCommand,
      });

      expect(executeCommand).not.toHaveBeenCalled();
      expect(result.status).toBe('command_replayed');
      expect(writeTerminalResult).toHaveBeenCalledTimes(1);
      const receipt = writeTerminalResult.mock.calls[0]![0];
      expect(receipt.type).toBe('terminal');
      expect(receipt.result).toEqual(terminalOutcome);
      expect(receipt.publicKey).toBe(keys.publicKey);
    });

    it('blocks new command with signed reconcile_required without provider or journal mutation when unresolved reconciliation exists', async () => {
      // Cause unresolved reconciliation in journal with a prior command
      const priorCommand = { ...validCommand, commandId: 'cmd_prior', idempotencyKey: 'idem_prior' };
      await journal.prepareCommand(priorCommand);
      await journal.transitionToExecuting(priorCommand.commandId);
      await journal.transitionToTerminal(priorCommand.commandId, {
        version: 1,
        commandId: priorCommand.commandId,
        idempotencyKey: priorCommand.idempotencyKey,
        creditId: priorCommand.creditId,
        accountId: priorCommand.accountId,
        targetDeviceId: priorCommand.targetDeviceId,
        userId: priorCommand.userId,
        backendId: priorCommand.backendId,
        state: 'unknown',
        code: 'unknown_outcome',
        executedAt: '2026-09-12T10:00:30.000Z',
        completedAt: '2026-09-12T10:00:35.000Z',
      });
      expect(await journal.hasUnresolvedReconciliation()).toBe(true);

      const writeTerminalResult = vi.fn().mockResolvedValue(undefined);
      const executeCommand = vi.fn();

      const result = await runResetCommandSync({
        env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1' },
        now,
        backendId: 'test_backend',
        userId: 'test_user',
        deviceId: 'test_device',
        keys,
        journal,
        readRequest: vi.fn().mockResolvedValue(validRequest),
        writeTerminalResult,
        deleteInventory: vi.fn().mockResolvedValue(undefined),
        executeCommand,
      });

      expect(executeCommand).not.toHaveBeenCalled();
      expect(result.status).toBe('command_blocked');
      expect(writeTerminalResult).toHaveBeenCalledTimes(1);
      const receipt = writeTerminalResult.mock.calls[0]![0];
      expect(receipt.type).toBe('terminal');
      expect(receipt.result.code).toBe('reconcile_required');
      expect(receipt.result.state).toBe('failed');
      expect(receipt.result.commandId).toBe(validCommand.commandId);

      // Verify journal does NOT have an entry for the blocked new command
      expect(await journal.getEntry(validCommand.commandId)).toBeUndefined();
    });

    it('fails closed when replay or blocked branches cannot publish their terminal receipt', async () => {
      await journal.prepareCommand(validCommand);
      await journal.transitionToExecuting(validCommand.commandId);
      await journal.transitionToTerminal(validCommand.commandId, {
        version: 1, commandId: validCommand.commandId, idempotencyKey: validCommand.idempotencyKey,
        creditId: validCommand.creditId, accountId: validCommand.accountId, targetDeviceId: validCommand.targetDeviceId,
        userId: validCommand.userId, backendId: validCommand.backendId, state: 'success', code: 'reset',
        executedAt: '2026-09-12T10:01:00.000Z', completedAt: '2026-09-12T10:01:02.000Z',
      });
      await expect(runResetCommandSync({
        env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1' }, now, backendId: 'test_backend', userId: 'test_user',
        deviceId: 'test_device', keys, journal, readRequest: vi.fn().mockResolvedValue(validRequest),
      })).rejects.toThrow(/terminal.*required/i);

      const blockedDir = fs.mkdtempSync(path.join(os.tmpdir(), '94ai-reset-blocked-'));
      const blockedJournal = new ResetCommandJournal({ rootDir: blockedDir, backendId: 'test_backend', userId: 'test_user', deviceId: 'test_device', accountId: 'test_account' });
      const prior = { ...validCommand, commandId: 'prior_unresolved', idempotencyKey: 'prior_unresolved_idem' };
      await blockedJournal.prepareCommand(prior);
      await blockedJournal.transitionToExecuting(prior.commandId);
      await expect(runResetCommandSync({
        env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1' }, now, backendId: 'test_backend', userId: 'test_user',
        deviceId: 'test_device', keys, journal: blockedJournal, readRequest: vi.fn().mockResolvedValue(validRequest),
      })).rejects.toThrow(/terminal.*required/i);
    });

    it('does not publish actionable inventory while any journal mutation remains unresolved', async () => {
      const prior = { ...validCommand, commandId: 'prior_inventory_block', idempotencyKey: 'prior_inventory_block_idem' };
      await journal.prepareCommand(prior);
      await journal.transitionToExecuting(prior.commandId);
      const writeInventory = vi.fn();
      const deleteInventory = vi.fn().mockResolvedValue(undefined);
      const result = await runResetCommandSync({
        env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1' }, now, backendId: 'test_backend', userId: 'test_user',
        deviceId: 'test_device', keys, journal, readRequest: vi.fn().mockResolvedValue(undefined),
        readRateLimits: vi.fn().mockResolvedValue({ accountId: 'test_account', availableCount: 1, credits: [
          { creditId: 'c_safe', expiresAt: '2026-09-12T11:00:00.000Z', status: 'available', resetType: 'codexRateLimits' },
        ] }),
        writeInventory, deleteInventory,
      });
      expect(result.status).toBe('idle');
      expect(writeInventory).not.toHaveBeenCalled();
      expect(deleteInventory).toHaveBeenCalledTimes(1);
    });

    it('does not publish actionable inventory when device-wide interlock reports unresolved work in another account', async () => {
      const writeInventory = vi.fn();
      const deleteInventory = vi.fn().mockResolvedValue(undefined);
      const hasGlobalUnresolved = vi.fn().mockResolvedValue(true);
      const result = await runResetCommandSync({
        env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1' },
        now,
        backendId: 'test_backend',
        userId: 'test_user',
        deviceId: 'test_device',
        keys,
        journal,
        readRequest: vi.fn().mockResolvedValue(undefined),
        readRateLimits: vi.fn().mockResolvedValue({
          accountId: 'test_account',
          availableCount: 1,
          credits: [
            { creditId: 'c_safe', expiresAt: '2026-09-12T11:00:00.000Z', status: 'available', resetType: 'codexRateLimits' },
          ],
        }),
        writeInventory,
        deleteInventory,
        hasGlobalUnresolved,
      });
      expect(hasGlobalUnresolved).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('idle');
      expect(writeInventory).not.toHaveBeenCalled();
      expect(deleteInventory).toHaveBeenCalledTimes(1);
    });

    it('rejects a replay whose commandId matches but immutable command fields were mutated', async () => {
      await journal.prepareCommand(validCommand);
      await journal.transitionToExecuting(validCommand.commandId);
      await journal.transitionToTerminal(validCommand.commandId, {
        version: 1, commandId: validCommand.commandId, idempotencyKey: validCommand.idempotencyKey,
        creditId: validCommand.creditId, accountId: validCommand.accountId, targetDeviceId: validCommand.targetDeviceId,
        userId: validCommand.userId, backendId: validCommand.backendId, state: 'success', code: 'reset',
        executedAt: '2026-09-12T10:01:00.000Z', completedAt: '2026-09-12T10:01:02.000Z',
      });
      const mutatedRequest = { ...validRequest, command: { ...validCommand, idempotencyKey: 'idem_mutated' } };
      const writeTerminalResult = vi.fn();
      await expect(runResetCommandSync({
        env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1' }, now, backendId: 'test_backend', userId: 'test_user',
        deviceId: 'test_device', keys, journal, readRequest: vi.fn().mockResolvedValue(mutatedRequest), writeTerminalResult,
      })).resolves.toMatchObject({ status: 'command_rejected', error: 'command_mutation_rejected' });
      expect(writeTerminalResult).not.toHaveBeenCalled();
    });

    it('blocks accepted command before any provider mutation when the R3 real-consume gate is not enabled', async () => {
      const writeExecutingResult = vi.fn();
      const deleteInventory = vi.fn();
      const executeCommand = vi.fn().mockResolvedValue({
        version: 1, commandId: validCommand.commandId, idempotencyKey: validCommand.idempotencyKey,
        creditId: validCommand.creditId, accountId: validCommand.accountId, targetDeviceId: validCommand.targetDeviceId,
        userId: validCommand.userId, backendId: validCommand.backendId, state: 'success', code: 'reset',
        executedAt: '2026-09-12T10:01:00.000Z', completedAt: '2026-09-12T10:01:02.000Z',
      });
      const writeTerminalResult = vi.fn().mockResolvedValue(undefined);

      const result = await runResetCommandSync({
        env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1' },
        now, backendId: 'test_backend', userId: 'test_user', deviceId: 'test_device', keys, journal,
        readRequest: vi.fn().mockResolvedValue(validRequest),
        writeExecutingResult, deleteInventory, executeCommand, writeTerminalResult,
      });

      expect(result.status).toBe('command_blocked');
      expect(result.outcome?.code).toBe('r3_authorization_required');
      expect(writeExecutingResult).not.toHaveBeenCalled();
      expect(deleteInventory).not.toHaveBeenCalled();
      expect(executeCommand).not.toHaveBeenCalled();
      expect(writeTerminalResult).toHaveBeenCalledTimes(1);
    });

    it('blocks a new command when the device-wide interlock reports unresolved work in another account', async () => {
      const executeCommand = vi.fn();
      const writeTerminalResult = vi.fn().mockResolvedValue(undefined);
      const deleteInventory = vi.fn().mockResolvedValue(undefined);
      const hasGlobalUnresolved = vi.fn().mockResolvedValue(true);

      const result = await runResetCommandSync({
        env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1', AI_USAGE_RESET_REAL_CONSUME_ENABLED: '1' },
        now, backendId: 'test_backend', userId: 'test_user', deviceId: 'test_device', keys, journal,
        readRequest: vi.fn().mockResolvedValue(validRequest),
        writeTerminalResult, deleteInventory, executeCommand,
        hasGlobalUnresolved,
      });

      expect(hasGlobalUnresolved).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('command_blocked');
      expect(result.outcome?.code).toBe('reconcile_required');
      expect(executeCommand).not.toHaveBeenCalled();
    });

    it('executes accepted command with strict sequence: executing receipt -> delete inventory -> provider execution -> terminal receipt -> fresh inventory read', async () => {
      const callSequence: string[] = [];

      const writeExecutingResult = vi.fn().mockImplementation(async () => {
        const persisted = await journal.getEntry(validCommand.commandId);
        expect(persisted?.state).toBe('prepared');
        callSequence.push('writeExecutingResult');
      });
      const deleteInventory = vi.fn().mockImplementation(async () => {
        callSequence.push('deleteInventory');
      });
      const executeCommand = vi.fn().mockImplementation(async () => {
        callSequence.push('executeCommand');
        return {
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
          executedAt: '2026-09-12T10:01:00.000Z',
          completedAt: '2026-09-12T10:01:02.000Z',
        };
      });
      const writeTerminalResult = vi.fn().mockImplementation(async () => {
        callSequence.push('writeTerminalResult');
      });
      const readRateLimits = vi.fn().mockImplementation(async () => {
        callSequence.push('readRateLimits');
        return {
          accountId: 'test_account',
          availableCount: 0,
          credits: [],
        };
      });
      const writeInventory = vi.fn().mockImplementation(async () => {
        callSequence.push('writeInventory');
      });

      const result = await runResetCommandSync({
        env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1', AI_USAGE_RESET_REAL_CONSUME_ENABLED: '1' },
        now,
        backendId: 'test_backend',
        userId: 'test_user',
        deviceId: 'test_device',
        keys,
        journal,
        readRequest: vi.fn().mockResolvedValue(validRequest),
        writeExecutingResult,
        deleteInventory,
        executeCommand,
        writeTerminalResult,
        readRateLimits,
        writeInventory,
      });

      expect(result.status).toBe('command_executed');
      expect(callSequence).toEqual([
        'writeExecutingResult',
        'deleteInventory',
        'executeCommand',
        'writeTerminalResult',
        'readRateLimits',
        'writeInventory',
      ]);
    });

    it('fails closed when mandatory executing receipt or inventory invalidation transports are missing', async () => {
      const executeCommand = vi.fn().mockResolvedValue({
        version: 1, commandId: validCommand.commandId, idempotencyKey: validCommand.idempotencyKey,
        creditId: validCommand.creditId, accountId: validCommand.accountId, targetDeviceId: validCommand.targetDeviceId,
        userId: validCommand.userId, backendId: validCommand.backendId, state: 'success', code: 'reset',
        executedAt: '2026-09-12T10:01:00.000Z', completedAt: '2026-09-12T10:01:02.000Z',
      });
      const base = {
        env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1' }, now, backendId: 'test_backend', userId: 'test_user',
        deviceId: 'test_device', keys, journal, readRequest: vi.fn().mockResolvedValue(validRequest), executeCommand,
      };
      await expect(runResetCommandSync({ ...base, deleteInventory: vi.fn() })).rejects.toThrow(/executing.*required|transport.*required/i);
      await expect(runResetCommandSync({ ...base, writeExecutingResult: vi.fn() })).rejects.toThrow(/inventory.*required|transport.*required/i);
      await expect(runResetCommandSync({ ...base, writeExecutingResult: vi.fn(), deleteInventory: vi.fn() })).rejects.toThrow(/terminal.*required|transport.*required/i);
      expect(executeCommand).not.toHaveBeenCalled();
    });

    it('if executing receipt write fails, does NOT delete inventory and does NOT execute command', async () => {
      const writeExecutingResult = vi.fn().mockRejectedValue(new Error('firestore_error'));
      const deleteInventory = vi.fn();
      const executeCommand = vi.fn();

      await expect(
        runResetCommandSync({
          env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1', AI_USAGE_RESET_REAL_CONSUME_ENABLED: '1' },
          now,
          backendId: 'test_backend',
          userId: 'test_user',
          deviceId: 'test_device',
          keys,
          journal,
          readRequest: vi.fn().mockResolvedValue(validRequest),
          writeExecutingResult,
          deleteInventory,
          writeTerminalResult: vi.fn(),
          executeCommand,
        }),
      ).rejects.toThrow('firestore_error');

      expect(deleteInventory).not.toHaveBeenCalled();
      expect(executeCommand).not.toHaveBeenCalled();
    });

    it('if delete inventory fails, does NOT execute command', async () => {
      const writeExecutingResult = vi.fn().mockResolvedValue(undefined);
      const deleteInventory = vi.fn().mockRejectedValue(new Error('delete_failed'));
      const executeCommand = vi.fn();

      await expect(
        runResetCommandSync({
          env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1', AI_USAGE_RESET_REAL_CONSUME_ENABLED: '1' },
          now,
          backendId: 'test_backend',
          userId: 'test_user',
          deviceId: 'test_device',
          keys,
          journal,
          readRequest: vi.fn().mockResolvedValue(validRequest),
          writeExecutingResult,
          deleteInventory,
          writeTerminalResult: vi.fn(),
          executeCommand,
        }),
      ).rejects.toThrow('delete_failed');

      expect(executeCommand).not.toHaveBeenCalled();
    });

    it('if terminal write fails, journal retains terminal state and next sync replays it without re-execution', async () => {
      // Ensure the journal has terminal state saved
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
        executedAt: '2026-09-12T10:01:00.000Z',
        completedAt: '2026-09-12T10:01:02.000Z',
      });

      // Second sync attempt: terminal write succeeds
      const writeTerminalResultSucceeds = vi.fn().mockResolvedValue(undefined);
      const executeCommand2 = vi.fn();

      const result = await runResetCommandSync({
        env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1' },
        now,
        backendId: 'test_backend',
        userId: 'test_user',
        deviceId: 'test_device',
        keys,
        journal,
        readRequest: vi.fn().mockResolvedValue(validRequest),
        writeTerminalResult: writeTerminalResultSucceeds,
        executeCommand: executeCommand2,
      });

      expect(executeCommand2).not.toHaveBeenCalled();
      expect(result.status).toBe('command_replayed');
      expect(writeTerminalResultSucceeds).toHaveBeenCalledTimes(1);
    });

    it('does not republish actionable inventory when terminal receipt publication fails', async () => {
      const writeExecutingResult = vi.fn().mockResolvedValue(undefined);
      const deleteInventory = vi.fn().mockResolvedValue(undefined);
      const executeCommand = vi.fn().mockResolvedValue({
        version: 1, commandId: validCommand.commandId, idempotencyKey: validCommand.idempotencyKey,
        creditId: validCommand.creditId, accountId: validCommand.accountId, targetDeviceId: validCommand.targetDeviceId,
        userId: validCommand.userId, backendId: validCommand.backendId, state: 'success', code: 'reset',
        executedAt: '2026-09-12T10:01:00.000Z', completedAt: '2026-09-12T10:01:02.000Z',
      });
      const writeTerminalResult = vi.fn().mockRejectedValue(new Error('terminal_publish_failed'));
      const readRateLimits = vi.fn();
      const writeInventory = vi.fn();
      const result = await runResetCommandSync({
        env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1', AI_USAGE_RESET_REAL_CONSUME_ENABLED: '1' }, now, backendId: 'test_backend', userId: 'test_user',
        deviceId: 'test_device', keys, journal, readRequest: vi.fn().mockResolvedValue(validRequest),
        writeExecutingResult, deleteInventory, executeCommand, writeTerminalResult, readRateLimits, writeInventory,
      });
      expect(result.status).toBe('command_executed');
      expect(readRateLimits).not.toHaveBeenCalled();
      expect(writeInventory).not.toHaveBeenCalled();
    });

    it('if fresh provider read fails after command attempt, leaves inventory absent and does not write stale inventory', async () => {
      const writeExecutingResult = vi.fn().mockResolvedValue(undefined);
      const deleteInventory = vi.fn().mockResolvedValue(undefined);
      const executeCommand = vi.fn().mockResolvedValue({
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
        executedAt: '2026-09-12T10:01:00.000Z',
        completedAt: '2026-09-12T10:01:02.000Z',
      });
      const writeTerminalResult = vi.fn().mockResolvedValue(undefined);
      const readRateLimits = vi.fn().mockRejectedValue(new Error('codex_read_failed'));
      const writeInventory = vi.fn();

      const result = await runResetCommandSync({
        env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1', AI_USAGE_RESET_REAL_CONSUME_ENABLED: '1' },
        now,
        backendId: 'test_backend',
        userId: 'test_user',
        deviceId: 'test_device',
        keys,
        journal,
        readRequest: vi.fn().mockResolvedValue(validRequest),
        writeExecutingResult,
        deleteInventory,
        executeCommand,
        writeTerminalResult,
        readRateLimits,
        writeInventory,
      });

      expect(writeInventory).not.toHaveBeenCalled();
      expect(result.status).toBe('command_executed');
    });
  });
});
