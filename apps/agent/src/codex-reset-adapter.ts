import { spawn, type ChildProcess } from 'node:child_process';
import {
  parseResetCreditInventory,
  validateResetIdentifier,
  SENSITIVE_PATTERN,
  type ResetCreditCommand,
  type ResetCreditItem,
  type ResetCreditStatus,
  type ResetCreditType,
} from '@94ai/core';
import {
  verifyAndConsumeExecutionClaim,
  type ExecutionClaim,
} from './reset-command-journal';

export type { ExecutionClaim };

async function safeClose(target: { close?: () => unknown } | null | undefined): Promise<void> {
  if (!target || typeof target.close !== 'function') return;
  try {
    const res = target.close();
    if (res && typeof (res as Promise<void>).then === 'function') {
      await (res as Promise<void>).catch(() => {});
    }
  } catch {
    // completely isolate synchronous throws
  }
}

export class PreWriteTransportError extends Error {
  public readonly isPreWrite = true;
  constructor(message = 'transport_error') {
    super(message);
    this.name = 'PreWriteTransportError';
  }
}

export interface CodexRpcTransport {
  send(message: string): Promise<void> | void;
  onMessage(handler: (message: string) => void): void;
  onError(handler: (error: Error) => void): void;
  onClose(handler: (code: number | null, signal: string | null) => void): void;
  close(): Promise<void> | void;
}

export type SpawnFunction = (
  command: string,
  args: string[],
  options: { stdio: ['pipe', 'pipe', 'pipe']; shell: false },
) => ChildProcess;

export interface CodexResetAdapterOptions {
  spawnProcess?: SpawnFunction | undefined;
  transport?: CodexRpcTransport | undefined;
  timeoutMs?: number | undefined;
  maxLineBytes?: number | undefined;
  maxMessages?: number | undefined;
  clock?: (() => Date | string | number) | undefined;
}

export interface SanitizedRateLimitsReadResult {
  accountId: string;
  availableCount: number;
  credits: ResetCreditItem[] | null;
}

export interface ConsumeResetCreditParams {
  expectedAccountId: string;
  creditId: string;
  idempotencyKey: string;
  executionClaim: ExecutionClaim;
  journal?: object | undefined;
  command?: ResetCreditCommand | undefined;
}

export interface ConsumeResetCreditResult {
  state: 'success' | 'failed' | 'unknown';
  code: string;
}

const ALLOWED_METHODS = new Set([
  'initialize',
  'initialized',
  'account/rateLimits/read',
  'account/rateLimitResetCredit/consume',
]);

const ALLOWED_OUTCOMES = new Set(['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed']);

class ProcessTransport implements CodexRpcTransport {
  private readonly child: ChildProcess;
  private buffer = '';
  private readonly maxLineBytes: number;
  private messageHandlers: ((msg: string) => void)[] = [];
  private errorHandlers: ((err: Error) => void)[] = [];
  private closeHandlers: ((code: number | null, signal: string | null) => void)[] = [];

  constructor(child: ChildProcess, maxLineBytes: number) {
    this.child = child;
    this.maxLineBytes = maxLineBytes;

    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      if (this.buffer.length > this.maxLineBytes * 2) {
        for (const h of this.errorHandlers) h(new Error('protocol_error'));
        this.close();
        return;
      }
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (Buffer.byteLength(trimmed, 'utf8') > this.maxLineBytes) {
          for (const h of this.errorHandlers) h(new Error('protocol_error'));
          this.close();
          return;
        }
        for (const h of this.messageHandlers) h(trimmed);
      }
    });

    this.child.stderr?.on('data', () => {
      // Drain stderr without logging raw provider data
    });

    this.child.on('error', (err) => {
      for (const h of this.errorHandlers) h(err);
    });

    this.child.on('close', (code, signal) => {
      for (const h of this.closeHandlers) h(code, signal);
    });
  }

  public async send(message: string): Promise<void> {
    if (!this.child.stdin || this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new PreWriteTransportError('transport_error');
    }
    return new Promise<void>((resolve, reject) => {
      this.child.stdin!.write(message + '\n', 'utf8', (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
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
    if (this.child.killed || this.child.exitCode !== null) {
      return;
    }
    try {
      this.child.kill('SIGTERM');
    } catch {
      // ignore
    }
    await new Promise<void>((resolve) => {
      let resolved = false;
      const onExit = () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(killTimer);
          resolve();
        }
      };
      const killTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try {
            this.child.kill('SIGKILL');
          } catch {
            // ignore
          }
          resolve();
        }
      }, 500);
      this.child.once('exit', onExit);
    });
  }
}

function parseProviderRateLimitsResult(
  res: unknown,
  context?: {
    backendId?: string | undefined;
    userId?: string | undefined;
    targetDeviceId?: string | undefined;
    now?: Date | string | number | undefined;
  },
): SanitizedRateLimitsReadResult {
  if (
    !res ||
    typeof res !== 'object' ||
    Array.isArray(res) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(res))
  ) {
    throw new Error('protocol_error');
  }
  const obj = res as Record<string, unknown>;
  const allowedResKeys = new Set(['accountId', 'rateLimitResetCredits', 'rateLimits']);
  if (Object.keys(obj).some((k) => !allowedResKeys.has(k))) {
    throw new Error('protocol_error');
  }
  const rawAccountId = obj.accountId;
  if (
    typeof rawAccountId !== 'string' ||
    rawAccountId.length === 0 ||
    rawAccountId.length > 128 ||
    SENSITIVE_PATTERN.test(rawAccountId)
  ) {
    throw new Error('protocol_error');
  }
  const accountId = rawAccountId;

  const rlc = obj.rateLimitResetCredits;
  if (
    !rlc ||
    typeof rlc !== 'object' ||
    Array.isArray(rlc) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(rlc))
  ) {
    throw new Error('protocol_error');
  }
  const rlcObj = rlc as Record<string, unknown>;
  const allowedRlcKeys = new Set(['availableCount', 'credits']);
  if (Object.keys(rlcObj).some((k) => !allowedRlcKeys.has(k))) {
    throw new Error('protocol_error');
  }

  if (
    typeof rlcObj.availableCount !== 'number' ||
    !Number.isSafeInteger(rlcObj.availableCount) ||
    rlcObj.availableCount < 0 ||
    rlcObj.availableCount > 1_000_000
  ) {
    throw new Error('protocol_error');
  }
  const availableCount = rlcObj.availableCount;

  let credits: ResetCreditItem[] | null = null;
  if (rlcObj.credits === null) {
    credits = null;
  } else if (Array.isArray(rlcObj.credits)) {
    if (rlcObj.credits.length > 500) {
      throw new Error('protocol_error');
    }
    const seenIds = new Set<string>();
    let availableDetailCount = 0;
    credits = rlcObj.credits.map((itemRaw) => {
      if (
        !itemRaw ||
        typeof itemRaw !== 'object' ||
        Array.isArray(itemRaw) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(itemRaw))
      ) {
        throw new Error('protocol_error');
      }
      const item = itemRaw as Record<string, unknown>;
      const allowedItemKeys = new Set(['id', 'status', 'resetType', 'grantedAt', 'expiresAt']);
      if (Object.keys(item).some((k) => !allowedItemKeys.has(k))) {
        throw new Error('protocol_error');
      }
      if (
        typeof item.id !== 'string' ||
        item.id.length === 0 ||
        item.id.length > 128 ||
        SENSITIVE_PATTERN.test(item.id)
      ) {
        throw new Error('protocol_error');
      }
      if (seenIds.has(item.id)) {
        throw new Error('protocol_error');
      }
      seenIds.add(item.id);

      if (item.status !== 'available' && item.status !== 'redeeming' && item.status !== 'redeemed') {
        throw new Error('protocol_error');
      }
      if (item.status === 'available') {
        availableDetailCount++;
      }

      if (item.resetType !== 'codexRateLimits') {
        throw new Error('protocol_error');
      }

      if (
        typeof item.grantedAt !== 'number' ||
        !Number.isSafeInteger(item.grantedAt) ||
        item.grantedAt <= 0 ||
        item.grantedAt > 253402300799
      ) {
        throw new Error('protocol_error');
      }

      let expiresAtIso: string | null = null;
      if (item.expiresAt !== null && item.expiresAt !== undefined) {
        if (
          typeof item.expiresAt !== 'number' ||
          !Number.isSafeInteger(item.expiresAt) ||
          item.expiresAt <= 0 ||
          item.expiresAt > 253402300799
        ) {
          throw new Error('protocol_error');
        }
        const d = new Date(item.expiresAt * 1000);
        if (!Number.isFinite(d.getTime())) {
          throw new Error('protocol_error');
        }
        expiresAtIso = d.toISOString();
      }

      return {
        creditId: item.id,
        expiresAt: expiresAtIso,
        status: item.status as ResetCreditStatus,
        resetType: item.resetType as ResetCreditType,
      };
    });

    if (availableCount === 0 && availableDetailCount > 0) {
      throw new Error('protocol_error');
    }
    if (availableCount < availableDetailCount) {
      throw new Error('protocol_error');
    }
  } else {
    throw new Error('protocol_error');
  }

  const nowMs =
    context?.now instanceof Date
      ? context.now.getTime()
      : typeof context?.now === 'string'
        ? Date.parse(context.now)
        : typeof context?.now === 'number'
          ? context.now
          : Date.now();
  const observedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + 3600_000).toISOString();

  // Validate complete sanitized transformed inventory
  const inventory = parseResetCreditInventory({
    version: 1,
    backendId: context?.backendId ?? 'codex-local',
    userId: context?.userId ?? 'local-user',
    targetDeviceId: context?.targetDeviceId ?? 'local-device',
    accountId,
    observedAt,
    expiresAt,
    availableCount,
    credits,
  });

  return {
    accountId: inventory.accountId,
    availableCount: inventory.availableCount,
    credits: inventory.credits,
  };
}

interface AdapterConfig {
  spawnProcess: SpawnFunction;
  injectedTransport: CodexRpcTransport | undefined;
  timeoutMs: number;
  maxLineBytes: number;
  maxMessages: number;
  clock: () => number;
}

const ADAPTER_CONFIGS = new WeakMap<CodexResetAdapter, AdapterConfig>();

function getAdapterConfig(adapter: CodexResetAdapter): AdapterConfig {
  const cfg = ADAPTER_CONFIGS.get(adapter);
  if (!cfg) {
    throw new Error('invalid_adapter_instance');
  }
  return cfg;
}

function sanitizeErrorMessage(raw: string): string {
  if (SENSITIVE_PATTERN.test(raw)) {
    return 'provider_error';
  }
  return raw;
}

interface AdapterSession {
  transport: CodexRpcTransport;
  request: (
    method: string,
    params?: Record<string, unknown>,
    onDispatched?: () => void,
  ) => Promise<unknown>;
  notify: (method: string, params?: Record<string, unknown>) => Promise<void>;
  close: () => Promise<void>;
  isConsumeDispatched: () => boolean;
  setConsumeDispatched: () => void;
}

function createSession(adapter: CodexResetAdapter): AdapterSession {
  const config = getAdapterConfig(adapter);
  let transport: CodexRpcTransport;
  if (config.injectedTransport) {
    transport = config.injectedTransport;
  } else {
    const child = config.spawnProcess('codex', ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    transport = new ProcessTransport(child, config.maxLineBytes);
  }

  let nextId = 1;
  let messageCount = 0;
  let consumeDispatched = false;
  let handshakeState: 'uninitialized' | 'initializing' | 'initialized' = 'uninitialized';
  let sessionFatalError: Error | null = null;
  const pendingRequests = new Map<
    number | string,
    { resolve: (val: unknown) => void; reject: (err: Error) => void; timer?: NodeJS.Timeout | undefined }
  >();

  const cleanup = async () => {
    for (const [, req] of pendingRequests) {
      if (req.timer) {
        clearTimeout(req.timer);
      }
    }
    pendingRequests.clear();
    await safeClose(transport);
  };

  let isClosing = false;
  const latchFailure = (err: Error) => {
    if (!sessionFatalError) {
      sessionFatalError = err;
    }
    for (const [, req] of pendingRequests) {
      if (req.timer) {
        clearTimeout(req.timer);
      }
      req.reject(err);
    }
    pendingRequests.clear();
    if (!isClosing) {
      isClosing = true;
      safeClose(transport).catch(() => {});
    }
  };

  transport.onMessage((raw) => {
    if (sessionFatalError) return;

    messageCount++;
    if (messageCount > config.maxMessages) {
      latchFailure(new Error('protocol_error'));
      return;
    }

    if (Buffer.byteLength(raw, 'utf8') > config.maxLineBytes) {
      latchFailure(new Error('protocol_error'));
      return;
    }

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      latchFailure(new Error('protocol_error'));
      return;
    }

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(parsed))
    ) {
      latchFailure(new Error('protocol_error'));
      return;
    }

    if (parsed.jsonrpc !== '2.0') {
      latchFailure(new Error('protocol_error'));
      return;
    }

    // Check if message is a response
    if (parsed.id !== undefined) {
      const allowedResponseKeys = new Set(['jsonrpc', 'id', 'result', 'error']);
      if (Object.keys(parsed).some((k) => !allowedResponseKeys.has(k))) {
        latchFailure(new Error('protocol_error'));
        return;
      }

      if (typeof parsed.id !== 'number' && typeof parsed.id !== 'string') {
        latchFailure(new Error('protocol_error'));
        return;
      }

      const pending = pendingRequests.get(parsed.id);
      if (!pending) {
        // Unexpected or mismatched/duplicate response ID
        latchFailure(new Error('protocol_error'));
        return;
      }

      const hasResult = parsed.result !== undefined;
      const hasError = parsed.error !== undefined;
      if ((hasResult && hasError) || (!hasResult && !hasError)) {
        latchFailure(new Error('protocol_error'));
        return;
      }

      if (hasError) {
        if (
          !parsed.error ||
          typeof parsed.error !== 'object' ||
          Array.isArray(parsed.error) ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(parsed.error))
        ) {
          latchFailure(new Error('protocol_error'));
          return;
        }
        pendingRequests.delete(parsed.id);
        const errObj = parsed.error as Record<string, unknown>;
        const safeMsg = sanitizeErrorMessage(
          typeof errObj.message === 'string' ? errObj.message : 'rpc_error',
        );
        pending.reject(new Error(safeMsg));
      } else {
        pendingRequests.delete(parsed.id);
        pending.resolve(parsed.result);
      }
      return;
    }

    // Notification (id is undefined)
    const allowedNotificationKeys = new Set(['jsonrpc', 'method', 'params']);
    if (Object.keys(parsed).some((k) => !allowedNotificationKeys.has(k))) {
      latchFailure(new Error('protocol_error'));
      return;
    }

    if (
      typeof parsed.method !== 'string' ||
      parsed.method.length === 0 ||
      parsed.method.length > 64 ||
      SENSITIVE_PATTERN.test(parsed.method)
    ) {
      latchFailure(new Error('protocol_error'));
      return;
    }

    if (
      parsed.params !== undefined &&
      (!parsed.params ||
        typeof parsed.params !== 'object' ||
        Array.isArray(parsed.params) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(parsed.params)))
    ) {
      latchFailure(new Error('protocol_error'));
      return;
    }
  });

  transport.onError((err) => {
    if (!sessionFatalError) {
      latchFailure(new Error(sanitizeErrorMessage(err.message)));
    }
  });

  transport.onClose(() => {
    if (!sessionFatalError) {
      latchFailure(new Error(consumeDispatched ? 'unknown_outcome' : 'transport_closed'));
    }
  });

  const request = async (
    method: string,
    params: Record<string, unknown> = {},
    onDispatched?: () => void,
  ): Promise<unknown> => {
    if (sessionFatalError) {
      throw sessionFatalError;
    }

    if (!ALLOWED_METHODS.has(method)) {
      throw new Error('disallowed_method');
    }

    if (method === 'initialize') {
      if (handshakeState !== 'uninitialized') {
        throw new Error('protocol_error');
      }
      handshakeState = 'initializing';
    } else if (handshakeState !== 'initialized') {
      throw new Error('protocol_error');
    }

    const id = nextId++;
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });

    const isConsume = method === 'account/rateLimitResetCredit/consume';
    let consumeSendStarted = false;
    if (isConsume) {
      consumeSendStarted = true;
    }

    let timeoutTimer: NodeJS.Timeout | undefined;
    let rejectResponse!: (err: Error) => void;
    let resolveResponse!: (val: unknown) => void;

    const responsePromise = new Promise((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    // Attach rejection handler immediately to avoid unhandled rejections
    responsePromise.catch(() => {});

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
        }
        if (isConsume && consumeSendStarted) {
          consumeDispatched = true;
        }
        const safeError = new Error(
          isConsume && consumeSendStarted ? 'unknown_outcome' : 'timeout',
        );
        reject(safeError);
      }, config.timeoutMs);
    });
    // Attach rejection handler immediately
    timeoutPromise.catch(() => {});

    pendingRequests.set(id, {
      resolve: (val) => {
        // Do NOT clear timeoutTimer here — single deadline covers the entire request lifecycle of send + response
        resolveResponse(val);
      },
      reject: (err) => {
        rejectResponse(err);
      },
      timer: timeoutTimer,
    });

    const sendAndAwaitResponse = async (): Promise<unknown> => {
      try {
        await transport.send(payload);
        if (onDispatched) {
          onDispatched();
        }
      } catch (err: unknown) {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
        }
        const isPreWrite =
          err instanceof PreWriteTransportError ||
          (err && typeof err === 'object' && (err as { isPreWrite?: boolean }).isPreWrite === true);

        if (isConsume && !isPreWrite) {
          consumeDispatched = true;
          throw new Error('unknown_outcome');
        }
        const msg = err instanceof Error ? err.message : 'transport_error';
        throw new PreWriteTransportError(sanitizeErrorMessage(msg));
      }

      return await responsePromise;
    };

    try {
      return await Promise.race([sendAndAwaitResponse(), timeoutPromise]);
    } finally {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
    }
  };

  const notify = async (method: string, params: Record<string, unknown> = {}): Promise<void> => {
    if (sessionFatalError) {
      throw sessionFatalError;
    }

    if (!ALLOWED_METHODS.has(method)) {
      throw new Error('disallowed_method');
    }
    if (method === 'initialized') {
      if (handshakeState !== 'initializing') {
        throw new Error('protocol_error');
      }
      handshakeState = 'initialized';
    }
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    });

    let notifTimer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      notifTimer = setTimeout(() => reject(new Error('timeout')), config.timeoutMs);
    });
    timeoutPromise.catch(() => {});

    try {
      await Promise.race([Promise.resolve(transport.send(payload)), timeoutPromise]);
    } finally {
      if (notifTimer) {
        clearTimeout(notifTimer);
      }
    }
  };

  return {
    transport,
    request,
    notify,
    close: cleanup,
    isConsumeDispatched: () => consumeDispatched,
    setConsumeDispatched: () => {
      consumeDispatched = true;
    },
  };
}

async function performHandshake(session: AdapterSession): Promise<void> {
  await session.request('initialize', {
    clientInfo: {
      name: '94AiUsageDashboard',
      version: '0.1.4',
    },
  });
  await session.notify('initialized', {});
}

export class CodexResetAdapter {
  constructor(options: CodexResetAdapterOptions = {}) {
    const rawClock = options.clock;
    const clockFn = rawClock
      ? () => {
          const val = rawClock();
          return val instanceof Date
            ? val.getTime()
            : typeof val === 'string'
              ? Date.parse(val)
              : typeof val === 'number'
                ? val
                : Date.now();
        }
      : () => Date.now();

    ADAPTER_CONFIGS.set(this, {
      spawnProcess: options.spawnProcess ?? ((cmd, args, opts) => spawn(cmd, args, opts)),
      injectedTransport: options.transport,
      timeoutMs: options.timeoutMs ?? 15000,
      maxLineBytes: options.maxLineBytes ?? 64 * 1024,
      maxMessages: options.maxMessages ?? 50,
      clock: clockFn,
    });
  }

  public testSpawnConfig(): void {
    const config = getAdapterConfig(this);
    config.spawnProcess('codex', ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
  }

  public callMethod(method: string, params?: Record<string, unknown>): never {
    void params;
    if (!ALLOWED_METHODS.has(method)) {
      throw new Error('disallowed_method');
    }
    throw new Error('method_not_callable_directly');
  }

  public async readRateLimits(): Promise<SanitizedRateLimitsReadResult> {
    const config = getAdapterConfig(this);
    const session = createSession(this);
    try {
      await performHandshake(session);
      const res = await session.request('account/rateLimits/read', {});
      return parseProviderRateLimitsResult(res, { now: config.clock() });
    } finally {
      await safeClose(session);
    }
  }

  public async consumeResetCredit(params: ConsumeResetCreditParams): Promise<ConsumeResetCreditResult> {
    if (!params || typeof params !== 'object') {
      throw new Error('invalid_params');
    }
    const claim = params.executionClaim;
    if (!claim || typeof claim !== 'object') {
      throw new Error('execution_claim_required');
    }

    // Snapshot and freeze before first await
    const snapshot = Object.freeze({
      expectedAccountId: validateResetIdentifier(params.expectedAccountId, 'expected_account_id'),
      creditId: validateResetIdentifier(params.creditId, 'credit_id'),
      idempotencyKey: validateResetIdentifier(params.idempotencyKey, 'idempotency_key'),
      claimCommandId: (claim as ExecutionClaim).commandId,
      claimIdempotencyKey: (claim as ExecutionClaim).idempotencyKey,
      claimCreditId: (claim as ExecutionClaim).creditId,
      claimAccountId: (claim as ExecutionClaim).accountId,
      claimExpiresAt: (claim as ExecutionClaim).expiresAt,
    });

    verifyAndConsumeExecutionClaim(claim, {
      journal: params.journal!,
      command: params.command!,
      accountId: snapshot.expectedAccountId,
      creditId: snapshot.creditId,
      idempotencyKey: snapshot.idempotencyKey,
    });

    const config = getAdapterConfig(this);
    const session = createSession(this);
    let outcomeResult: ConsumeResetCreditResult | undefined;

    try {
      await performHandshake(session);

      // Re-read inventory in the same session with strict parsing and trusted clock
      const readRes = await session.request('account/rateLimits/read', {});
      const inventory = parseProviderRateLimitsResult(readRes, { now: config.clock() });

      if (!inventory.accountId || inventory.accountId !== snapshot.expectedAccountId) {
        outcomeResult = { state: 'failed', code: 'account_mismatch' };
        return outcomeResult;
      }

      if (!inventory.credits) {
        outcomeResult = { state: 'failed', code: 'credit_missing' };
        return outcomeResult;
      }

      const matched = inventory.credits.find((c) => c.creditId === snapshot.creditId);
      if (!matched) {
        outcomeResult = { state: 'failed', code: 'credit_missing' };
        return outcomeResult;
      }

      if (matched.status !== 'available' || matched.resetType !== 'codexRateLimits') {
        outcomeResult = { state: 'failed', code: 'credit_status_invalid' };
        return outcomeResult;
      }

      const currentNowMs = config.clock();

      if (matched.expiresAt !== null) {
        const expMs = Date.parse(matched.expiresAt);
        if (Number.isFinite(expMs) && expMs <= currentNowMs) {
          outcomeResult = { state: 'failed', code: 'credit_expired' };
          return outcomeResult;
        }
      }

      // Re-check command authorization expiry immediately before consume dispatch using trusted clock
      const cmdExpiresAtMs = Date.parse(snapshot.claimExpiresAt);
      if (Number.isFinite(cmdExpiresAtMs) && currentNowMs >= cmdExpiresAtMs) {
        outcomeResult = { state: 'failed', code: 'command_expired' };
        return outcomeResult;
      }

      // Dispatch consume: mark dispatched ONLY after send resolves
      let consumeRes: unknown;
      try {
        consumeRes = await session.request(
          'account/rateLimitResetCredit/consume',
          {
            idempotencyKey: snapshot.idempotencyKey,
            creditId: snapshot.creditId,
          },
          () => {
            session.setConsumeDispatched();
          },
        );
      } catch (consumeErr: unknown) {
        if (session.isConsumeDispatched()) {
          outcomeResult = { state: 'unknown', code: 'unknown_outcome' };
          return outcomeResult;
        }
        const isPreWrite =
          consumeErr instanceof PreWriteTransportError ||
          (consumeErr && typeof consumeErr === 'object' && (consumeErr as { isPreWrite?: boolean }).isPreWrite === true);
        if (isPreWrite) {
          outcomeResult = { state: 'failed', code: 'transport_error' };
          return outcomeResult;
        }
        outcomeResult = { state: 'unknown', code: 'unknown_outcome' };
        return outcomeResult;
      }

      const consumeObj = (consumeRes && typeof consumeRes === 'object' ? consumeRes : {}) as Record<string, unknown>;
      const outcome = typeof consumeObj.outcome === 'string' ? consumeObj.outcome : '';
      if (outcome === 'reset') {
        outcomeResult = { state: 'success', code: 'reset' };
        return outcomeResult;
      }
      if (ALLOWED_OUTCOMES.has(outcome)) {
        outcomeResult = { state: 'failed', code: outcome };
        return outcomeResult;
      }

      outcomeResult = { state: 'unknown', code: 'unknown_outcome' };
      return outcomeResult;
    } catch (err: unknown) {
      if (session.isConsumeDispatched()) {
        outcomeResult = { state: 'unknown', code: 'unknown_outcome' };
        return outcomeResult;
      }
      const isPreWrite =
        err instanceof PreWriteTransportError ||
        (err && typeof err === 'object' && (err as { isPreWrite?: boolean }).isPreWrite === true);
      if (isPreWrite) {
        outcomeResult = { state: 'failed', code: 'transport_error' };
        return outcomeResult;
      }
      const msg = err instanceof Error ? err.message : 'adapter_error';
      throw new Error(sanitizeErrorMessage(msg));
    } finally {
      await safeClose(session);
    }
  }
}
