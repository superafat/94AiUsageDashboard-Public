import {
  parseResetCreditCommand,
  type ResetCreditCommand,
  type ResetCreditResult,
  type ResetCreditResultCode,
} from '@94ai/core';
import type { ResetCommandJournal } from './reset-command-journal';
import {
  PreWriteTransportError,
  type ConsumeResetCreditParams,
  type ConsumeResetCreditResult,
} from './codex-reset-adapter';

export interface CodexResetAdapterLike {
  consumeResetCredit(params: ConsumeResetCreditParams): Promise<ConsumeResetCreditResult>;
}

export interface ExecuteResetCreditCommandOptions {
  journal: ResetCommandJournal;
  adapter: CodexResetAdapterLike;
  command: ResetCreditCommand;
  now?: Date | string | number | undefined;
}

const journalFlightMaps = new WeakMap<ResetCommandJournal, Map<string, Promise<ResetCreditResult>>>();

function getInFlightMap(journal: ResetCommandJournal): Map<string, Promise<ResetCreditResult>> {
  let map = journalFlightMaps.get(journal);
  if (!map) {
    map = new Map();
    journalFlightMaps.set(journal, map);
  }
  return map;
}

export async function executeResetCreditCommand(
  options: ExecuteResetCreditCommandOptions,
): Promise<ResetCreditResult> {
  const { journal, adapter, command, now } = options;
  const parsedCmd = parseResetCreditCommand(command);
  const snapshotCmd = Object.freeze({ ...parsedCmd });

  const nowMs =
    now instanceof Date
      ? now.getTime()
      : typeof now === 'string'
        ? Date.parse(now)
        : typeof now === 'number'
          ? now
          : Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // Durably prepare in journal before possible mutation
  const entry = await journal.prepareCommand(snapshotCmd);

  // If existing terminal return prior exact bounded result
  if (entry.state === 'terminal') {
    if (entry.result) {
      return entry.result;
    }
    throw new Error('terminal_result_missing');
  }

  const inFlightExecutions = getInFlightMap(journal);
  const flightKey = JSON.stringify([
    snapshotCmd.backendId,
    snapshotCmd.userId,
    snapshotCmd.targetDeviceId,
    snapshotCmd.accountId,
    snapshotCmd.commandId,
    snapshotCmd.idempotencyKey,
    snapshotCmd.creditId,
    snapshotCmd.requestedAt,
    snapshotCmd.expiresAt,
  ]);

  const existingFlight = inFlightExecutions.get(flightKey);
  if (existingFlight) {
    return existingFlight;
  }

  // If existing executing/unknown never call adapter
  if (entry.state === 'executing') {
    if (entry.result) {
      return entry.result;
    }
    // Bounded poll in case another process is currently executing
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
      const latest = await journal.getEntry(snapshotCmd.commandId);
      if (latest?.state === 'terminal' && latest.result) {
        return latest.result;
      }
      if (!latest || latest.state !== 'executing') {
        break;
      }
    }
    throw new Error('command_already_executing');
  }

  // Check expiry after idempotency is recorded
  const expMs = Date.parse(snapshotCmd.expiresAt);
  if (expMs <= nowMs) {
    const expiredResult: ResetCreditResult = {
      version: 1,
      commandId: snapshotCmd.commandId,
      idempotencyKey: snapshotCmd.idempotencyKey,
      creditId: snapshotCmd.creditId,
      accountId: snapshotCmd.accountId,
      targetDeviceId: snapshotCmd.targetDeviceId,
      userId: snapshotCmd.userId,
      backendId: snapshotCmd.backendId,
      state: 'failed',
      code: 'command_expired',
      executedAt: nowIso,
      completedAt: nowIso,
    };
    await journal.transitionToExpired(snapshotCmd.commandId, expiredResult);
    return expiredResult;
  }

  const flightPromise = (async () => {
    // Transition to executing before calling adapter
    const executingEntry = await journal.transitionToExecuting(snapshotCmd.commandId);
    if (!executingEntry.executionClaim) {
      throw new Error('execution_claim_required');
    }
    const executedAt = new Date().toISOString();

    // Call adapter once with exclusive execution claim and trusted adapter clock
    let adapterOutcome: ConsumeResetCreditResult;
    try {
      adapterOutcome = await adapter.consumeResetCredit({
        expectedAccountId: snapshotCmd.accountId,
        creditId: snapshotCmd.creditId,
        idempotencyKey: snapshotCmd.idempotencyKey,
        executionClaim: executingEntry.executionClaim,
        journal,
        command: snapshotCmd,
      });
    } catch (err: unknown) {
      const isProvenPreWrite =
        err instanceof PreWriteTransportError ||
        (err && typeof err === 'object' && (err as { isPreWrite?: boolean }).isPreWrite === true);

      if (isProvenPreWrite) {
        adapterOutcome = { state: 'failed', code: 'transport_error' };
      } else {
        adapterOutcome = { state: 'unknown', code: 'unknown_outcome' };
      }
    }

    const completedAt = new Date().toISOString();
    const terminalResult: ResetCreditResult = {
      version: 1,
      commandId: parsedCmd.commandId,
      idempotencyKey: parsedCmd.idempotencyKey,
      creditId: parsedCmd.creditId,
      accountId: parsedCmd.accountId,
      targetDeviceId: parsedCmd.targetDeviceId,
      userId: parsedCmd.userId,
      backendId: parsedCmd.backendId,
      state: adapterOutcome.state,
      code: adapterOutcome.code as ResetCreditResultCode,
      executedAt,
      completedAt,
    };

    await journal.transitionToTerminal(parsedCmd.commandId, terminalResult);
    return terminalResult;
  })();

  inFlightExecutions.set(flightKey, flightPromise);
  try {
    return await flightPromise;
  } finally {
    inFlightExecutions.delete(flightKey);
  }
}
