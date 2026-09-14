import {
  parseResetCommandRequestRecord,
  type ResetCommandRequestRecord,
  type ResetCreditInventory,
  type ResetCreditItem,
  type ResetCreditResult,
  type ResetExecutingReceipt,
  type ResetInventoryEnvelope,
  type ResetTerminalReceipt,
} from '@94ai/core';
import {
  createSignedExecutingReceipt,
  createSignedResetInventory,
  createSignedTerminalReceipt,
  type VapidKeys,
} from './reset-command-signature';
import { ResetCommandJournal } from './reset-command-journal';
import {
  executeResetCreditCommand,
  type CodexResetAdapterLike,
  type ExecuteResetCreditCommandOptions,
} from './reset-command-executor';
import type { SanitizedRateLimitsReadResult } from './codex-reset-adapter';

export interface ResetAdapterLike extends CodexResetAdapterLike {
  readRateLimits?: () => Promise<SanitizedRateLimitsReadResult>;
}

export interface ResetCommandRuntimeOptions {
  env?: NodeJS.ProcessEnv | undefined;
  now?: (() => Date) | undefined;
  backendId: string;
  userId: string;
  deviceId: string;
  keys?: VapidKeys | undefined;
  getLocalKeys?: (() => Promise<VapidKeys | undefined>) | undefined;
  readRateLimits?: (() => Promise<SanitizedRateLimitsReadResult>) | undefined;
  readRequest?: ((uid: string, deviceId: string, signal?: AbortSignal) => Promise<ResetCommandRequestRecord | undefined>) | undefined;
  writeInventory?: ((envelope: ResetInventoryEnvelope, signal?: AbortSignal) => Promise<void>) | undefined;
  deleteInventory?: ((uid: string, deviceId: string, signal?: AbortSignal) => Promise<void>) | undefined;
  writeExecutingResult?: ((receipt: ResetExecutingReceipt, signal?: AbortSignal) => Promise<void>) | undefined;
  writeTerminalResult?: ((receipt: ResetTerminalReceipt, signal?: AbortSignal) => Promise<void>) | undefined;
  journal?: ResetCommandJournal | ((accountId: string) => Promise<ResetCommandJournal> | ResetCommandJournal) | undefined;
  adapter?: ResetAdapterLike | undefined;
  executeCommand?: ((options: ExecuteResetCreditCommandOptions) => Promise<ResetCreditResult>) | undefined;
  hasGlobalUnresolved?: (() => Promise<boolean>) | undefined;
  allowProviderMutation?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface ResetCommandRuntimeResult {
  status: 'disabled' | 'idle' | 'command_executed' | 'command_replayed' | 'command_blocked' | 'command_rejected' | 'error';
  commandId?: string;
  outcome?: ResetCreditResult;
  error?: string;
}

export function projectActionableCredits(
  credits: readonly ResetCreditItem[] | null | undefined,
  observedAtMs: number,
): ResetCreditItem[] {
  if (!credits || !Array.isArray(credits)) return [];

  const candidates = credits.filter((c) => {
    if (c.status !== 'available' || c.resetType !== 'codexRateLimits') return false;
    if (c.expiresAt !== null && c.expiresAt !== undefined) {
      const exp = Date.parse(c.expiresAt);
      if (!Number.isFinite(exp) || exp <= observedAtMs) return false;
    }
    return true;
  });

  const known: ResetCreditItem[] = [];
  const unknown: ResetCreditItem[] = [];

  for (const c of candidates) {
    if (c.expiresAt !== null && c.expiresAt !== undefined) {
      known.push(c);
    } else {
      unknown.push(c);
    }
  }

  // Known expiries ascending
  known.sort((a, b) => Date.parse(a.expiresAt!) - Date.parse(b.expiresAt!));

  if (known.length >= 2) {
    return [known[0]!, known[1]!];
  }

  if (known.length === 1) {
    if (unknown.length > 0) {
      return [known[0]!, unknown[0]!];
    }
    return [known[0]!];
  }

  return unknown.slice(0, 2);
}

function sameResetCommand(a: ResetCommandRequestRecord['command'], b: ResetCommandRequestRecord['command']): boolean {
  return a.version === b.version && a.commandId === b.commandId && a.idempotencyKey === b.idempotencyKey &&
    a.creditId === b.creditId && a.accountId === b.accountId && a.targetDeviceId === b.targetDeviceId &&
    a.userId === b.userId && a.backendId === b.backendId && a.requestedAt === b.requestedAt && a.expiresAt === b.expiresAt;
}

export async function runResetCommandSync(
  options: ResetCommandRuntimeOptions,
): Promise<ResetCommandRuntimeResult> {
  const env = options.env ?? process.env;
  if (env.AI_USAGE_RESET_COMMANDS_ENABLED !== '1') {
    return { status: 'disabled' };
  }

  const keys = options.keys ?? (await options.getLocalKeys?.());
  if (!keys) {
    return { status: 'error', error: 'local_keys_unavailable' };
  }

  const nowFn = options.now ?? (() => new Date());
  const nowMs = nowFn().getTime();
  const nowIso = new Date(nowMs).toISOString();

  const publishFreshInventory = async (): Promise<void> => {
    if (!options.writeInventory) return;
    if (options.hasGlobalUnresolved && await options.hasGlobalUnresolved()) {
      if (!options.deleteInventory) throw new Error('inventory_invalidation_transport_required');
      await options.deleteInventory(options.userId, options.deviceId, options.signal);
      return;
    }
    const readLimits = options.readRateLimits ?? (
      options.adapter && typeof options.adapter.readRateLimits === 'function'
        ? () => options.adapter!.readRateLimits!()
        : undefined
    );
    if (!readLimits) return;
    const limits = await readLimits();
    if (!limits || !limits.accountId) return;
    const inventoryJournal = await resolveJournal(limits.accountId);
    if (!inventoryJournal) throw new Error('journal_unavailable');
    if (await inventoryJournal.hasUnresolvedReconciliation()) {
      if (!options.deleteInventory) throw new Error('inventory_invalidation_transport_required');
      await options.deleteInventory(options.userId, options.deviceId, options.signal);
      return;
    }

    const observedAt = nowFn().toISOString();
    const observedAtMs = Date.parse(observedAt);
    const expiresAt = new Date(observedAtMs + 5 * 60_000).toISOString();
    const projected = projectActionableCredits(limits.credits, observedAtMs);

    const inventory: ResetCreditInventory = {
      version: 1,
      backendId: options.backendId,
      userId: options.userId,
      targetDeviceId: options.deviceId,
      accountId: limits.accountId,
      observedAt,
      expiresAt,
      availableCount: limits.availableCount,
      credits: projected,
    };

    const envelope = await createSignedResetInventory(inventory, keys);
    await options.writeInventory(envelope, options.signal);
  };

  const resolveJournal = async (accountId: string): Promise<ResetCommandJournal | undefined> => {
    if (typeof options.journal === 'function') {
      return options.journal(accountId);
    }
    return options.journal;
  };

  let request: ResetCommandRequestRecord | undefined;
  if (options.readRequest) {
    try {
      request = await options.readRequest(options.userId, options.deviceId, options.signal);
    } catch {
      return { status: 'error', error: 'request_read_failed' };
    }
  }

    if (request) {
    let parsedRequest: ResetCommandRequestRecord;
    try {
      parsedRequest = parseResetCommandRequestRecord(request, nowMs);
    } catch {
      try {
        await publishFreshInventory();
      } catch {
        // ignore best-effort inventory refresh
      }
      return { status: 'command_rejected', error: 'invalid_or_expired_request' };
    }

    const isValid =
      parsedRequest.version === 1 &&
      parsedRequest.producerPublicKey === keys.publicKey &&
      parsedRequest.command.userId === options.userId &&
      parsedRequest.command.targetDeviceId === options.deviceId &&
      parsedRequest.command.backendId === options.backendId &&
      parsedRequest.leaseExpiresAt === parsedRequest.command.expiresAt &&
      Date.parse(parsedRequest.leaseExpiresAt) > nowMs;

    if (!isValid) {
      try {
        await publishFreshInventory();
      } catch {
        // ignore best-effort inventory refresh
      }
      return { status: 'command_rejected', error: 'invalid_or_expired_request' };
    }
    if (!options.writeTerminalResult) throw new Error('terminal_result_transport_required');

    const journal = await resolveJournal(parsedRequest.command.accountId);
    if (!journal) {
      return { status: 'error', error: 'journal_unavailable' };
    }

    const existingEntry = await journal.getEntry(parsedRequest.command.commandId);
    if (existingEntry && !sameResetCommand(existingEntry.command, parsedRequest.command)) {
      return { status: 'command_rejected', commandId: parsedRequest.command.commandId, error: 'command_mutation_rejected' };
    }
    if (existingEntry?.state === 'terminal' && existingEntry.result) {
      const terminalReceipt = createSignedTerminalReceipt({
        backendId: parsedRequest.command.backendId,
        userId: parsedRequest.command.userId,
        targetDeviceId: parsedRequest.command.targetDeviceId,
        accountId: parsedRequest.command.accountId,
        commandId: parsedRequest.command.commandId,
        idempotencyKey: parsedRequest.command.idempotencyKey,
        creditId: parsedRequest.command.creditId,
        executedAt: existingEntry.result.executedAt,
      }, existingEntry.result, keys);

      await options.writeTerminalResult(terminalReceipt, options.signal);
      try {
        await publishFreshInventory();
      } catch {
        // ignore best-effort inventory refresh
      }
      return {
        status: 'command_replayed',
        commandId: parsedRequest.command.commandId,
        outcome: existingEntry.result,
      };
    }

    const hasUnresolved = Boolean(await options.hasGlobalUnresolved?.()) || await journal.hasUnresolvedReconciliation();
    if (hasUnresolved) {
      const blockedResult: ResetCreditResult = {
        version: 1,
        commandId: parsedRequest.command.commandId,
        idempotencyKey: parsedRequest.command.idempotencyKey,
        creditId: parsedRequest.command.creditId,
        accountId: parsedRequest.command.accountId,
        targetDeviceId: parsedRequest.command.targetDeviceId,
        userId: parsedRequest.command.userId,
        backendId: parsedRequest.command.backendId,
        state: 'failed',
        code: 'reconcile_required',
        executedAt: nowIso,
        completedAt: nowIso,
      };

      const blockedReceipt = createSignedTerminalReceipt({
        backendId: parsedRequest.command.backendId,
        userId: parsedRequest.command.userId,
        targetDeviceId: parsedRequest.command.targetDeviceId,
        accountId: parsedRequest.command.accountId,
        commandId: parsedRequest.command.commandId,
        idempotencyKey: parsedRequest.command.idempotencyKey,
        creditId: parsedRequest.command.creditId,
        executedAt: nowIso,
      }, blockedResult, keys);

      if (!options.deleteInventory) throw new Error('inventory_invalidation_transport_required');
      await options.deleteInventory(options.userId, options.deviceId, options.signal);
      await options.writeTerminalResult(blockedReceipt, options.signal);
      return {
        status: 'command_blocked',
        commandId: parsedRequest.command.commandId,
        outcome: blockedResult,
      };
    }

    const allowProviderMutation = options.allowProviderMutation ?? (env.AI_USAGE_RESET_REAL_CONSUME_ENABLED === '1');
    if (allowProviderMutation !== true) {
      const blockedResult: ResetCreditResult = {
        version: 1,
        commandId: parsedRequest.command.commandId,
        idempotencyKey: parsedRequest.command.idempotencyKey,
        creditId: parsedRequest.command.creditId,
        accountId: parsedRequest.command.accountId,
        targetDeviceId: parsedRequest.command.targetDeviceId,
        userId: parsedRequest.command.userId,
        backendId: parsedRequest.command.backendId,
        state: 'failed',
        code: 'r3_authorization_required',
        executedAt: nowIso,
        completedAt: nowIso,
      };
      const blockedReceipt = createSignedTerminalReceipt({
        backendId: parsedRequest.command.backendId,
        userId: parsedRequest.command.userId,
        targetDeviceId: parsedRequest.command.targetDeviceId,
        accountId: parsedRequest.command.accountId,
        commandId: parsedRequest.command.commandId,
        idempotencyKey: parsedRequest.command.idempotencyKey,
        creditId: parsedRequest.command.creditId,
        executedAt: nowIso,
      }, blockedResult, keys);
      await options.writeTerminalResult(blockedReceipt, options.signal);
      return {
        status: 'command_blocked',
        commandId: parsedRequest.command.commandId,
        outcome: blockedResult,
      };
    }

    // Accepted new command: persist the local intent before publishing cloud `executing`.
    // If the process dies after cloud publication, the prepared journal lets the next sync
    // safely resume without losing the local idempotency authority.
    if (!options.writeExecutingResult) throw new Error('executing_result_transport_required');
    if (!options.deleteInventory) throw new Error('inventory_invalidation_transport_required');
    await journal.prepareCommand(parsedRequest.command);
    const executingReceipt = createSignedExecutingReceipt({
      backendId: parsedRequest.command.backendId,
      userId: parsedRequest.command.userId,
      targetDeviceId: parsedRequest.command.targetDeviceId,
      accountId: parsedRequest.command.accountId,
      commandId: parsedRequest.command.commandId,
      idempotencyKey: parsedRequest.command.idempotencyKey,
      creditId: parsedRequest.command.creditId,
      executedAt: nowIso,
    }, keys);

    await options.writeExecutingResult(executingReceipt, options.signal);
    await options.deleteInventory(options.userId, options.deviceId, options.signal);

    const executeFn = options.executeCommand ?? (
      options.adapter
        ? (opts: ExecuteResetCreditCommandOptions) => executeResetCreditCommand(opts)
        : undefined
    );
    if (!executeFn) {
      throw new Error('executor_unavailable');
    }

    const outcome = await executeFn({
      journal,
      adapter: options.adapter!,
      command: parsedRequest.command,
      now: nowMs,
    });

    const terminalReceipt = createSignedTerminalReceipt({
      backendId: parsedRequest.command.backendId,
      userId: parsedRequest.command.userId,
      targetDeviceId: parsedRequest.command.targetDeviceId,
      accountId: parsedRequest.command.accountId,
      commandId: parsedRequest.command.commandId,
      idempotencyKey: parsedRequest.command.idempotencyKey,
      creditId: parsedRequest.command.creditId,
      executedAt: outcome.executedAt,
    }, outcome, keys);

    let terminalPublished = false;
    try {
      await options.writeTerminalResult(terminalReceipt, options.signal);
      terminalPublished = true;
    } catch {
      // Journal remains authoritative. Keep inventory absent until a later sync republishes the terminal receipt.
    }

    if (terminalPublished) {
      try {
        await publishFreshInventory();
      } catch {
        // Leave inventory absent
      }
    }

    return {
      status: 'command_executed',
      commandId: parsedRequest.command.commandId,
      outcome,
    };
  }

  // No request
  try {
    await publishFreshInventory();
  } catch {
    // ignore best-effort inventory refresh
  }

  return { status: 'idle' };
}
