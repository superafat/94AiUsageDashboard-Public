import * as fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  parseResetCreditCommand,
  parseResetCreditResult,
  validateResetIdentifier,
  SENSITIVE_PATTERN,
  type ResetCreditCommand,
  type ResetCreditResult,
} from '@94ai/core';

export interface ExecutionClaim {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly creditId: string;
  readonly accountId: string;
  readonly expiresAt: string;
  readonly backendId?: string | undefined;
  readonly userId?: string | undefined;
  readonly targetDeviceId?: string | undefined;
}

interface ClaimRecord {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly creditId: string;
  readonly accountId: string;
  readonly expiresAt: string;
  readonly backendId: string;
  readonly userId: string;
  readonly targetDeviceId: string;
  readonly journal: object;
}

const VALID_CLAIMS = new WeakMap<object, ClaimRecord>();
const SPENT_CLAIMS = new WeakSet<object>();

function mintExecutionClaim(
  journal: object,
  payload: {
    commandId: string;
    idempotencyKey: string;
    creditId: string;
    accountId: string;
    expiresAt: string;
    backendId: string;
    userId: string;
    targetDeviceId: string;
  },
): ExecutionClaim {
  const claim: ExecutionClaim = Object.freeze({
    commandId: payload.commandId,
    idempotencyKey: payload.idempotencyKey,
    creditId: payload.creditId,
    accountId: payload.accountId,
    expiresAt: payload.expiresAt,
    backendId: payload.backendId,
    userId: payload.userId,
    targetDeviceId: payload.targetDeviceId,
  });

  VALID_CLAIMS.set(claim, {
    commandId: payload.commandId,
    idempotencyKey: payload.idempotencyKey,
    creditId: payload.creditId,
    accountId: payload.accountId,
    expiresAt: payload.expiresAt,
    backendId: payload.backendId,
    userId: payload.userId,
    targetDeviceId: payload.targetDeviceId,
    journal,
  });

  return claim;
}

export interface ExpectedExecutionAuthority {
  readonly journal?: object | undefined;
  readonly command?: ResetCreditCommand | undefined;
  readonly accountId?: string | undefined;
  readonly creditId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
}

export function verifyAndConsumeExecutionClaim(
  claim: unknown,
  expected: ExpectedExecutionAuthority,
): void {
  if (!claim || typeof claim !== 'object') {
    throw new Error('execution_claim_required');
  }
  if (SPENT_CLAIMS.has(claim)) {
    throw new Error('execution_claim_spent');
  }
  const record = VALID_CLAIMS.get(claim);
  if (!record) {
    throw new Error('execution_claim_required');
  }

  if (!expected || !expected.journal || record.journal !== expected.journal) {
    throw new Error('execution_claim_mismatch');
  }

  if (
    !expected.command ||
    record.commandId !== expected.command.commandId ||
    record.idempotencyKey !== expected.command.idempotencyKey ||
    record.creditId !== expected.command.creditId ||
    record.accountId !== expected.command.accountId ||
    record.expiresAt !== expected.command.expiresAt ||
    record.backendId !== expected.command.backendId ||
    record.userId !== expected.command.userId ||
    record.targetDeviceId !== expected.command.targetDeviceId
  ) {
    throw new Error('execution_claim_mismatch');
  }

  if (
    (expected.accountId !== undefined && record.accountId !== expected.accountId) ||
    (expected.creditId !== undefined && record.creditId !== expected.creditId) ||
    (expected.idempotencyKey !== undefined && record.idempotencyKey !== expected.idempotencyKey)
  ) {
    throw new Error('execution_claim_mismatch');
  }

  SPENT_CLAIMS.add(claim);
  VALID_CLAIMS.delete(claim);
}

export interface ResetCommandJournalOptions {
  rootDir: string;
  backendId: string;
  userId: string;
  deviceId: string;
  accountId: string;
  maxBytes?: number | undefined;
  maxItems?: number | undefined;
}

export type JournalCommandState = 'prepared' | 'executing' | 'terminal';

export interface JournalEntry {
  state: JournalCommandState;
  command: ResetCreditCommand;
  result?: ResetCreditResult | undefined;
  preparedAt: string;
  executingAt?: string | undefined;
  terminalAt?: string | undefined;
  reconcileRequired?: boolean | undefined;
  executionClaim?: ExecutionClaim | undefined;
}

interface JournalStorage {
  schemaVersion: 1;
  backendId: string;
  userId: string;
  deviceId: string;
  accountId: string;
  entries: Record<string, JournalEntry>;
  idempotencyMap: Record<string, string>;
}

const CAP_BYTES = 512 * 1024;
const CAP_ITEMS = 500;
const DANGEROUS_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function fail(code = 'invalid_journal'): never {
  throw new Error(code);
}

function bounded(value: number | undefined, fallback: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n <= 0 || n > fallback) return fail();
  return n;
}

function safeIdentifier(value: unknown): string {
  try {
    return validateResetIdentifier(value, 'invalid_journal');
  } catch {
    return fail('invalid_journal');
  }
}

function safeText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > 128 ||
    value.split('').some((char) => char.charCodeAt(0) < 32) ||
    SENSITIVE_PATTERN.test(value)
  ) {
    return fail();
  }
  return value;
}

function checkObject(value: unknown, allowed?: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  for (const k of Object.getOwnPropertyNames(value)) {
    if (DANGEROUS_PROTO_KEYS.has(k)) return fail();
  }
  if (allowed && Object.keys(value).some((key) => !allowed.includes(key))) return fail();
  return value as Record<string, unknown>;
}

export class ResetCommandJournal {
  private readonly rootDir: string;
  private readonly rootIdentity: fs.Stats;
  private readonly file: string;
  private readonly lock: string;
  private readonly maxBytes: number;
  private readonly maxItems: number;
  private readonly options: Readonly<{
    backendId: string;
    userId: string;
    deviceId: string;
    accountId: string;
  }>;

  constructor(options: ResetCommandJournalOptions) {
    this.options = Object.freeze({
      backendId: safeIdentifier(options.backendId),
      userId: safeIdentifier(options.userId),
      deviceId: safeIdentifier(options.deviceId),
      accountId: safeIdentifier(options.accountId),
    });
    this.maxBytes = bounded(options.maxBytes, CAP_BYTES);
    this.maxItems = bounded(options.maxItems, CAP_ITEMS);

    const stat = fs.lstatSync(options.rootDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail('invalid_journal_root_symlink');
    }
    this.rootDir = fs.realpathSync(options.rootDir);
    this.rootIdentity = stat;
    this.file = path.join(this.rootDir, 'reset-journal.json');
    this.lock = path.join(this.rootDir, 'reset-journal.lock');

    const dirEntries = fs.readdirSync(this.rootDir);
    const tempFiles = dirEntries.filter((name) => name.startsWith('reset-journal.tmp.'));
    if (tempFiles.length > 32) {
      fail('journal_too_many_temp_files');
    }

    // Run recovery on startup if journal file exists
    try {
      this.locked(() => {
        this.recoverOnStartup();
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'journal_too_many_temp_files') {
        throw err;
      }
      if (message !== 'ENOENT' && message !== 'journal_locked') {
        // Corrupt files or errors will be handled during explicit operations
      }
    }
  }

  private checkRoot(): void {
    const stat = fs.lstatSync(this.rootDir);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== this.rootIdentity.dev ||
      stat.ino !== this.rootIdentity.ino
    ) {
      fail('journal_root_changed');
    }
  }

  private matches(value: { backendId: string; userId: string; deviceId: string; accountId: string }): boolean {
    return (
      value.backendId === this.options.backendId &&
      value.userId === this.options.userId &&
      value.deviceId === this.options.deviceId &&
      value.accountId === this.options.accountId
    );
  }

  private empty(): JournalStorage {
    return {
      schemaVersion: 1,
      backendId: this.options.backendId,
      userId: this.options.userId,
      deviceId: this.options.deviceId,
      accountId: this.options.accountId,
      entries: Object.create(null),
      idempotencyMap: Object.create(null),
    };
  }

  private validate(value: unknown): JournalStorage {
    const row = checkObject(value, [
      'schemaVersion',
      'backendId',
      'userId',
      'deviceId',
      'accountId',
      'entries',
      'idempotencyMap',
    ]);
    if (row.schemaVersion !== 1 || !this.matches(row as unknown as JournalStorage)) {
      return fail('journal_identity_mismatch');
    }

    const rawEntries = checkObject(row.entries);
    const rawIdemMap = checkObject(row.idempotencyMap);

    const entryKeys = Object.keys(rawEntries);
    const idemKeys = Object.keys(rawIdemMap);
    if (entryKeys.length > this.maxItems || idemKeys.length > this.maxItems) {
      return fail('journal_item_limit');
    }

    const entries: Record<string, JournalEntry> = Object.create(null);
    for (const [cmdId, rawEntry] of Object.entries(rawEntries)) {
      if (DANGEROUS_PROTO_KEYS.has(cmdId)) fail('invalid_journal');
      safeIdentifier(cmdId);
      const e = checkObject(rawEntry, [
        'state',
        'command',
        'result',
        'preparedAt',
        'executingAt',
        'terminalAt',
        'reconcileRequired',
      ]);
      const state = e.state as JournalCommandState;
      if (!['prepared', 'executing', 'terminal'].includes(state)) fail('invalid_journal');

      const command = parseResetCreditCommand(e.command);
      if (
        command.commandId !== cmdId ||
        command.backendId !== this.options.backendId ||
        command.userId !== this.options.userId ||
        command.targetDeviceId !== this.options.deviceId ||
        command.accountId !== this.options.accountId
      ) {
        fail('journal_identity_mismatch');
      }

      let result: ResetCreditResult | undefined;
      if (e.result !== undefined && e.result !== null) {
        result = parseResetCreditResult(e.result);
        if (
          result.commandId !== cmdId ||
          result.idempotencyKey !== command.idempotencyKey ||
          result.creditId !== command.creditId ||
          result.backendId !== this.options.backendId ||
          result.userId !== this.options.userId ||
          result.targetDeviceId !== this.options.deviceId ||
          result.accountId !== this.options.accountId
        ) {
          fail('journal_identity_mismatch');
        }
      }

      const preparedAt = safeText(e.preparedAt);
      const executingAt = e.executingAt !== undefined ? safeText(e.executingAt) : undefined;
      const terminalAt = e.terminalAt !== undefined ? safeText(e.terminalAt) : undefined;
      const reconcileRequired = typeof e.reconcileRequired === 'boolean' ? e.reconcileRequired : undefined;

      if (state === 'prepared') {
        if (result !== undefined || executingAt !== undefined) {
          fail('invalid_journal');
        }
      } else if (state === 'executing') {
        if (executingAt === undefined) {
          fail('invalid_journal');
        }
      } else if (state === 'terminal') {
        if (!result) {
          fail('invalid_journal');
        }
        if (result.state === 'failed' && result.code === 'command_expired') {
          // Explicit command_expired is allowed only without executingAt (from prepared)
          if (executingAt !== undefined) {
            fail('invalid_journal');
          }
        } else if (executingAt === undefined) {
          fail('invalid_journal');
        }
      }

      entries[cmdId] = {
        state,
        command,
        ...(result ? { result } : {}),
        preparedAt,
        ...(executingAt ? { executingAt } : {}),
        ...(terminalAt ? { terminalAt } : {}),
        ...(reconcileRequired !== undefined ? { reconcileRequired } : {}),
      };
    }

    const idempotencyMap: Record<string, string> = Object.create(null);
    for (const [idemKey, cmdId] of Object.entries(rawIdemMap)) {
      if (DANGEROUS_PROTO_KEYS.has(idemKey)) fail('invalid_journal');
      safeIdentifier(idemKey);
      safeIdentifier(cmdId);
      idempotencyMap[idemKey] = String(cmdId);
    }

    // Validate true bijection between entries and idempotencyMap using own properties
    const validEntryKeys = Object.keys(entries);
    const validIdemKeys = Object.keys(idempotencyMap);
    if (validIdemKeys.length !== validEntryKeys.length) {
      fail('invalid_journal');
    }
    for (const cmdId of validEntryKeys) {
      if (!Object.prototype.hasOwnProperty.call(entries, cmdId)) {
        fail('invalid_journal');
      }
      const entry = entries[cmdId];
      if (!entry) fail('invalid_journal');
      if (!Object.prototype.hasOwnProperty.call(idempotencyMap, entry.command.idempotencyKey)) {
        fail('invalid_journal');
      }
      const mappedCmdId = idempotencyMap[entry.command.idempotencyKey];
      if (mappedCmdId !== cmdId) {
        fail('invalid_journal');
      }
    }
    for (const idemKey of validIdemKeys) {
      if (!Object.prototype.hasOwnProperty.call(idempotencyMap, idemKey)) {
        fail('invalid_journal');
      }
      const cmdId = idempotencyMap[idemKey];
      if (!cmdId || !Object.prototype.hasOwnProperty.call(entries, cmdId)) {
        fail('invalid_journal');
      }
      const entry = entries[cmdId];
      if (!entry || entry.command.idempotencyKey !== idemKey) {
        fail('invalid_journal');
      }
    }

    return {
      schemaVersion: 1,
      backendId: this.options.backendId,
      userId: this.options.userId,
      deviceId: this.options.deviceId,
      accountId: this.options.accountId,
      entries,
      idempotencyMap,
    };
  }

  private cleanTempFilesUnderLock(): void {
    const dirEntries = fs.readdirSync(this.rootDir);
    const tempFiles = dirEntries.filter((name) => name.startsWith('reset-journal.tmp.'));
    if (tempFiles.length > 32) {
      fail('journal_too_many_temp_files');
    }
    for (const name of tempFiles) {
      const tempPath = path.join(this.rootDir, name);
      try {
        const stat = fs.lstatSync(tempPath);
        if (
          stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.nlink === 1 &&
          (typeof process.getuid === 'function' ? stat.uid === process.getuid() : true)
        ) {
          fs.unlinkSync(tempPath);
        }
      } catch {
        // ignore
      }
    }
  }

  private locked<T>(action: () => T): T {
    this.checkRoot();
    let fd: number;
    const lockPayload = Buffer.from(
      JSON.stringify({
        pid: process.pid,
        nonce: randomUUID(),
        createdAt: new Date().toISOString(),
      }) + '\n',
      'utf8',
    );

    const tryAcquire = (): number | null => {
      try {
        const openedFd = fs.openSync(
          this.lock,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
          0o600,
        );
        fs.writeFileSync(openedFd, lockPayload);
        fs.fsyncSync(openedFd);
        return openedFd;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          return null;
        }
        throw error;
      }
    };

    const initialFd = tryAcquire();
    if (initialFd !== null) {
      fd = initialFd;
    } else {
      return fail('journal_locked');
    }

    const identity = fs.fstatSync(fd);
    try {
      this.cleanTempFilesUnderLock();
      return action();
    } finally {
      fs.closeSync(fd);
      try {
        const current = fs.lstatSync(this.lock);
        if (
          current.ino === identity.ino &&
          current.dev === identity.dev &&
          current.isFile() &&
          !current.isSymbolicLink()
        ) {
          fs.unlinkSync(this.lock);
        }
      } catch {
        // ignore unlock error
      }
    }
  }

  private recoverOnStartup(): void {
    let fd: number;
    try {
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      return fail('journal_read_rejected');
    }
    fs.closeSync(fd);

    const storage = this.read();
    let recoveredAny = false;
    const nowIso = new Date().toISOString();
    for (const [cmdId, entry] of Object.entries(storage.entries)) {
      if (entry.state === 'executing') {
        entry.state = 'terminal';
        entry.reconcileRequired = true;
        entry.terminalAt = nowIso;
        entry.result = {
          version: 1,
          commandId: cmdId,
          idempotencyKey: entry.command.idempotencyKey,
          creditId: entry.command.creditId,
          accountId: entry.command.accountId,
          targetDeviceId: entry.command.targetDeviceId,
          userId: entry.command.userId,
          backendId: entry.command.backendId,
          state: 'unknown',
          code: 'reconcile_required',
          executedAt: entry.executingAt ?? nowIso,
          completedAt: nowIso,
        };
        recoveredAny = true;
      }
    }
    if (recoveredAny) {
      this.write(storage);
    }
  }

  private read(): JournalStorage {
    this.checkRoot();
    let fd: number;
    try {
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.empty();
      return fail('journal_read_rejected');
    }
    let rawParsed: unknown;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > this.maxBytes) return fail('journal_file_rejected');
      const bytes = Buffer.alloc(this.maxBytes + 1);
      let count = 0;
      while (count < bytes.length) {
        const size = fs.readSync(fd, bytes, count, bytes.length - count, null);
        if (!size) break;
        count += size;
      }
      if (count > this.maxBytes) return fail('journal_byte_limit');
      const current = fs.lstatSync(this.file);
      if (
        current.ino !== stat.ino ||
        current.dev !== stat.dev ||
        !current.isFile() ||
        current.isSymbolicLink()
      ) {
        return fail('journal_file_changed');
      }

      try {
        rawParsed = JSON.parse(bytes.subarray(0, count).toString('utf8'));
      } catch {
        return fail('invalid_journal');
      }
    } finally {
      fs.closeSync(fd);
    }

    return this.validate(rawParsed);
  }

  private write(value: JournalStorage): void {
    this.checkRoot();
    const storage = this.validate(value);
    const bytes = Buffer.from(JSON.stringify(storage));
    if (bytes.length > this.maxBytes) return fail('journal_byte_limit');

    try {
      const stat = fs.lstatSync(this.file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) return fail('journal_file_rejected');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const temp = path.join(this.rootDir, 'reset-journal.tmp.' + randomUUID());
    const fd = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    let renamed = false;
    try {
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      this.checkRoot();
      fs.renameSync(temp, this.file);
      renamed = true;
      const directory = fs.openSync(this.rootDir, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } finally {
      if (!renamed) {
        try {
          fs.unlinkSync(temp);
        } catch {
          // ignore
        }
      }
    }
  }

  public async prepareCommand(command: ResetCreditCommand): Promise<JournalEntry> {
    const parsedCmd = parseResetCreditCommand(command);
    if (
      DANGEROUS_PROTO_KEYS.has(parsedCmd.commandId) ||
      DANGEROUS_PROTO_KEYS.has(parsedCmd.idempotencyKey)
    ) {
      fail('invalid_journal');
    }
    safeIdentifier(parsedCmd.commandId);
    safeIdentifier(parsedCmd.idempotencyKey);
    if (
      parsedCmd.backendId !== this.options.backendId ||
      parsedCmd.userId !== this.options.userId ||
      parsedCmd.targetDeviceId !== this.options.deviceId ||
      parsedCmd.accountId !== this.options.accountId
    ) {
      fail('journal_identity_mismatch');
    }

    return this.locked(() => {
      const storage = this.read();

      const existingById = Object.prototype.hasOwnProperty.call(storage.entries, parsedCmd.commandId)
        ? storage.entries[parsedCmd.commandId]
        : undefined;
      if (existingById) {
        // Compare commands
        const matches =
          existingById.command.version === parsedCmd.version &&
          existingById.command.commandId === parsedCmd.commandId &&
          existingById.command.idempotencyKey === parsedCmd.idempotencyKey &&
          existingById.command.creditId === parsedCmd.creditId &&
          existingById.command.accountId === parsedCmd.accountId &&
          existingById.command.targetDeviceId === parsedCmd.targetDeviceId &&
          existingById.command.userId === parsedCmd.userId &&
          existingById.command.backendId === parsedCmd.backendId &&
          existingById.command.requestedAt === parsedCmd.requestedAt &&
          existingById.command.expiresAt === parsedCmd.expiresAt;

        if (matches) {
          return existingById;
        }
        fail('command_mutation_rejected');
      }

      const existingCmdIdForIdem = Object.prototype.hasOwnProperty.call(storage.idempotencyMap, parsedCmd.idempotencyKey)
        ? storage.idempotencyMap[parsedCmd.idempotencyKey]
        : undefined;
      if (existingCmdIdForIdem && existingCmdIdForIdem !== parsedCmd.commandId) {
        fail('idempotency_conflict');
      }

      if (Object.keys(storage.entries).length >= this.maxItems) {
        fail('journal_item_limit');
      }

      const entry: JournalEntry = {
        state: 'prepared',
        command: parsedCmd,
        preparedAt: new Date().toISOString(),
      };

      storage.entries[parsedCmd.commandId] = entry;
      storage.idempotencyMap[parsedCmd.idempotencyKey] = parsedCmd.commandId;
      this.write(storage);
      return entry;
    });
  }

  public async transitionToExecuting(commandId: string): Promise<JournalEntry> {
    if (DANGEROUS_PROTO_KEYS.has(commandId)) fail('invalid_journal');
    safeIdentifier(commandId);
    return this.locked(() => {
      const storage = this.read();
      const entry = Object.prototype.hasOwnProperty.call(storage.entries, commandId)
        ? storage.entries[commandId]
        : undefined;
      if (!entry) fail('command_not_found');

      if (entry.state === 'terminal') {
        fail('terminal_state_immutable');
      }
      if (entry.state !== 'prepared') {
        fail('command_already_executing');
      }

      entry.state = 'executing';
      entry.executingAt = new Date().toISOString();
      this.write(storage);

      const executionClaim = mintExecutionClaim(this, {
        commandId: entry.command.commandId,
        idempotencyKey: entry.command.idempotencyKey,
        creditId: entry.command.creditId,
        accountId: entry.command.accountId,
        expiresAt: entry.command.expiresAt,
        backendId: entry.command.backendId,
        userId: entry.command.userId,
        targetDeviceId: entry.command.targetDeviceId,
      });

      return {
        ...entry,
        executionClaim,
      };
    });
  }

  public async transitionToTerminal(commandId: string, result: ResetCreditResult): Promise<JournalEntry> {
    if (DANGEROUS_PROTO_KEYS.has(commandId)) fail('invalid_journal');
    safeIdentifier(commandId);
    const parsedResult = parseResetCreditResult(result);
    if (parsedResult.code === 'command_expired') {
      fail('invalid_transition');
    }

    return this.locked(() => {
      const storage = this.read();
      const entry = Object.prototype.hasOwnProperty.call(storage.entries, commandId)
        ? storage.entries[commandId]
        : undefined;
      if (!entry) fail('command_not_found');

      if (entry.state === 'terminal') {
        if (
          entry.result &&
          entry.result.commandId === parsedResult.commandId &&
          entry.result.code === parsedResult.code &&
          entry.result.state === parsedResult.state
        ) {
          return entry;
        }
        fail('terminal_state_immutable');
      }

      if (entry.state !== 'executing') {
        fail('invalid_transition');
      }

      if (parsedResult.code === 'command_expired') {
        fail('invalid_transition');
      }

      // Check identity against command
      if (
        parsedResult.commandId !== entry.command.commandId ||
        parsedResult.idempotencyKey !== entry.command.idempotencyKey ||
        parsedResult.creditId !== entry.command.creditId ||
        parsedResult.accountId !== entry.command.accountId ||
        parsedResult.userId !== entry.command.userId ||
        parsedResult.backendId !== entry.command.backendId ||
        parsedResult.targetDeviceId !== entry.command.targetDeviceId
      ) {
        fail('journal_identity_mismatch');
      }

      entry.state = 'terminal';
      entry.result = parsedResult;
      entry.terminalAt = new Date().toISOString();
      this.write(storage);
      return entry;
    });
  }

  public async transitionToExpired(commandId: string, result: ResetCreditResult): Promise<JournalEntry> {
    if (DANGEROUS_PROTO_KEYS.has(commandId)) fail('invalid_journal');
    safeIdentifier(commandId);
    const parsedResult = parseResetCreditResult(result);
    if (parsedResult.state !== 'failed' || parsedResult.code !== 'command_expired') {
      fail('invalid_transition');
    }

    return this.locked(() => {
      const storage = this.read();
      const entry = Object.prototype.hasOwnProperty.call(storage.entries, commandId)
        ? storage.entries[commandId]
        : undefined;
      if (!entry) fail('command_not_found');

      if (entry.state === 'terminal') {
        if (
          entry.result &&
          entry.result.commandId === parsedResult.commandId &&
          entry.result.code === parsedResult.code &&
          entry.result.state === parsedResult.state
        ) {
          return entry;
        }
        fail('terminal_state_immutable');
      }

      if (entry.state !== 'prepared') {
        fail('invalid_transition');
      }

      // Check identity against command
      if (
        parsedResult.commandId !== entry.command.commandId ||
        parsedResult.idempotencyKey !== entry.command.idempotencyKey ||
        parsedResult.creditId !== entry.command.creditId ||
        parsedResult.accountId !== entry.command.accountId ||
        parsedResult.userId !== entry.command.userId ||
        parsedResult.backendId !== entry.command.backendId ||
        parsedResult.targetDeviceId !== entry.command.targetDeviceId
      ) {
        fail('journal_identity_mismatch');
      }

      entry.state = 'terminal';
      entry.result = parsedResult;
      entry.terminalAt = new Date().toISOString();
      this.write(storage);
      return entry;
    });
  }

  public async getEntry(commandId: string): Promise<JournalEntry | undefined> {
    if (DANGEROUS_PROTO_KEYS.has(commandId)) fail('invalid_journal');
    safeIdentifier(commandId);
    return this.locked(() => {
      const storage = this.read();
      return Object.prototype.hasOwnProperty.call(storage.entries, commandId)
        ? storage.entries[commandId]
        : undefined;
    });
  }

  public async markReconciled(commandId: string, result: ResetCreditResult): Promise<JournalEntry> {
    if (DANGEROUS_PROTO_KEYS.has(commandId)) fail('invalid_journal');
    safeIdentifier(commandId);
    const parsedResult = parseResetCreditResult(result);

    return this.locked(() => {
      const storage = this.read();
      const entry = Object.prototype.hasOwnProperty.call(storage.entries, commandId)
        ? storage.entries[commandId]
        : undefined;
      if (!entry) fail('command_not_found');

      if (entry.state !== 'terminal' || !entry.reconcileRequired) {
        fail('reconcile_not_allowed');
      }

      if (
        parsedResult.commandId !== entry.command.commandId ||
        parsedResult.idempotencyKey !== entry.command.idempotencyKey ||
        parsedResult.creditId !== entry.command.creditId ||
        parsedResult.accountId !== entry.command.accountId ||
        parsedResult.targetDeviceId !== entry.command.targetDeviceId ||
        parsedResult.userId !== entry.command.userId ||
        parsedResult.backendId !== entry.command.backendId
      ) {
        fail('journal_identity_mismatch');
      }

      entry.result = parsedResult;
      entry.reconcileRequired = false;
      entry.terminalAt = new Date().toISOString();
      this.write(storage);
      return entry;
    });
  }
}
