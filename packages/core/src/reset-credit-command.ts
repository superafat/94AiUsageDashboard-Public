import { SENSITIVE_PATTERN } from './diagnostics';
import { isValidCalendarDate } from './schema';

export type ResetCreditStatus = 'available' | 'redeeming' | 'redeemed' | 'unknown';
export type ResetCreditType = 'codexRateLimits' | 'unknown';

export interface ResetCreditItem {
  creditId: string;
  expiresAt: string | null;
  status: ResetCreditStatus;
  resetType: ResetCreditType;
}

export interface ResetCreditInventory {
  version: 1;
  backendId: string;
  userId: string;
  targetDeviceId: string;
  accountId: string;
  observedAt: string;
  expiresAt: string;
  availableCount: number;
  credits: ResetCreditItem[] | null;
}

export interface ResetCreditCommand {
  version: 1;
  commandId: string;
  idempotencyKey: string;
  creditId: string;
  accountId: string;
  targetDeviceId: string;
  userId: string;
  backendId: string;
  requestedAt: string;
  expiresAt: string;
}

export type ResetCreditResultState = 'success' | 'failed' | 'unknown';

export const RESET_CREDIT_RESULT_CODES = [
  'reset',
  'nothingToReset',
  'noCredit',
  'alreadyRedeemed',
  'account_mismatch',
  'credit_expired',
  'credit_missing',
  'credit_status_invalid',
  'credit_ambiguous',
  'idempotency_conflict',
  'command_expired',
  'command_mutation_rejected',
  'unknown_outcome',
  'timeout',
  'protocol_error',
  'transport_error',
  'reconcile_required',
] as const;

export type ResetCreditResultCode = (typeof RESET_CREDIT_RESULT_CODES)[number];

export interface ResetCreditResult {
  version: 1;
  commandId: string;
  idempotencyKey: string;
  creditId: string;
  accountId: string;
  targetDeviceId: string;
  userId: string;
  backendId: string;
  state: ResetCreditResultState;
  code: ResetCreditResultCode;
  executedAt: string;
  completedAt?: string | undefined;
}

const INVENTORY_KEYS = [
  'version',
  'backendId',
  'userId',
  'targetDeviceId',
  'accountId',
  'observedAt',
  'expiresAt',
  'availableCount',
  'credits',
] as const;

const CREDIT_ITEM_KEYS = ['creditId', 'expiresAt', 'status', 'resetType'] as const;

const COMMAND_KEYS = [
  'version',
  'commandId',
  'idempotencyKey',
  'creditId',
  'accountId',
  'targetDeviceId',
  'userId',
  'backendId',
  'requestedAt',
  'expiresAt',
] as const;

const RESULT_KEYS = [
  'version',
  'commandId',
  'idempotencyKey',
  'creditId',
  'accountId',
  'targetDeviceId',
  'userId',
  'backendId',
  'state',
  'code',
  'executedAt',
  'completedAt',
] as const;

const ALLOWED_STATUSES = new Set<ResetCreditStatus>(['available', 'redeeming', 'redeemed', 'unknown']);
const ALLOWED_TYPES = new Set<ResetCreditType>(['codexRateLimits', 'unknown']);
const ALLOWED_RESULT_STATES = new Set<ResetCreditResultState>(['success', 'failed', 'unknown']);
const ALLOWED_RESULT_CODES = new Set<string>(RESET_CREDIT_RESULT_CODES);

const DANGEROUS_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const FORBIDDEN_AUTH_PREFIX_REGEX =
  /^(?:authorization|basic|bearer|cookie|token|auth|credential|session)(?:[:=\s_/-]|$)/i;
const FORBIDDEN_SESSION_PATTERN_REGEX = /(?:session=)/i;

function hasForbiddenIdentifierChars(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
    const ch = str[i]!;
    if (ch === '@' || ch === '/' || ch === '\\' || /\s/.test(ch)) return true;
  }
  return false;
}

const ISO_DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/;

function invalid(tag: string): never {
  throw new Error(`invalid_${tag}`);
}

export function validateResetIdentifier(value: unknown, tag = 'reset_identifier'): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    DANGEROUS_PROTO_KEYS.has(value) ||
    hasForbiddenIdentifierChars(value) ||
    FORBIDDEN_AUTH_PREFIX_REGEX.test(value) ||
    FORBIDDEN_SESSION_PATTERN_REGEX.test(value) ||
    SENSITIVE_PATTERN.test(value)
  ) {
    invalid(tag);
  }
  return value;
}

function checkRecord(value: unknown, allowedKeys: readonly string[], tag: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    invalid(tag);
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  for (const k of keys) {
    if (DANGEROUS_PROTO_KEYS.has(k) || !allowedKeys.includes(k)) {
      invalid(tag);
    }
  }
  return obj;
}

function safeText(value: unknown, maxLen = 128, tag: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLen ||
    value.split('').some((c) => c.charCodeAt(0) < 32) ||
    SENSITIVE_PATTERN.test(value)
  ) {
    invalid(tag);
  }
  return value;
}

function parseIsoDate(value: unknown, tag: string): string {
  const str = safeText(value, 35, tag);
  const match = ISO_DATE_REGEX.exec(str);
  if (!match) invalid(tag);
  const year = Number(match![1]);
  const month = Number(match![2]);
  const day = Number(match![3]);
  if (!isValidCalendarDate(year, month, day) || !Number.isFinite(Date.parse(str))) {
    invalid(tag);
  }
  return str;
}

function safeInteger(value: unknown, min = 0, max = 1_000_000, tag: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(tag);
  }
  return value;
}

export function parseResetCreditInventory(value: unknown): ResetCreditInventory {
  const tag = 'reset_credit_inventory';
  const row = checkRecord(value, INVENTORY_KEYS, tag);

  if (row.version !== 1) invalid(tag);

  const backendId = validateResetIdentifier(row.backendId, tag);
  const userId = validateResetIdentifier(row.userId, tag);
  const targetDeviceId = validateResetIdentifier(row.targetDeviceId, tag);
  const accountId = validateResetIdentifier(row.accountId, tag);
  const observedAt = parseIsoDate(row.observedAt, tag);
  const expiresAt = parseIsoDate(row.expiresAt, tag);
  if (Date.parse(observedAt) >= Date.parse(expiresAt)) invalid(tag);
  const availableCount = safeInteger(row.availableCount, 0, 1_000_000, tag);

  let credits: ResetCreditItem[] | null = null;
  if (row.credits !== null && row.credits !== undefined) {
    if (!Array.isArray(row.credits) || row.credits.length > 500) invalid(tag);
    const seenCreditIds = new Set<string>();
    credits = row.credits.map((itemRaw) => {
      const itemRow = checkRecord(itemRaw, CREDIT_ITEM_KEYS, tag);
      const creditId = validateResetIdentifier(itemRow.creditId, tag);
      if (seenCreditIds.has(creditId)) invalid(tag);
      seenCreditIds.add(creditId);

      const itemExpiresAt = itemRow.expiresAt === null ? null : parseIsoDate(itemRow.expiresAt, tag);
      const status = itemRow.status as ResetCreditStatus;
      if (!ALLOWED_STATUSES.has(status)) invalid(tag);

      const resetType = itemRow.resetType as ResetCreditType;
      if (!ALLOWED_TYPES.has(resetType)) invalid(tag);

      return {
        creditId,
        expiresAt: itemExpiresAt,
        status,
        resetType,
      };
    });

    const availableCreditsCount = credits.filter((c) => c.status === 'available').length;
    if (availableCount === 0 && availableCreditsCount > 0) invalid(tag);
    if (availableCount < availableCreditsCount) invalid(tag);
  }

  return {
    version: 1,
    backendId,
    userId,
    targetDeviceId,
    accountId,
    observedAt,
    expiresAt,
    availableCount,
    credits,
  };
}

export function parseResetCreditCommand(value: unknown): ResetCreditCommand {
  const tag = 'reset_credit_command';
  const row = checkRecord(value, COMMAND_KEYS, tag);

  if (row.version !== 1) invalid(tag);

  const requestedAt = parseIsoDate(row.requestedAt, tag);
  const expiresAt = parseIsoDate(row.expiresAt, tag);
  if (Date.parse(requestedAt) >= Date.parse(expiresAt)) invalid(tag);

  return {
    version: 1,
    commandId: validateResetIdentifier(row.commandId, tag),
    idempotencyKey: validateResetIdentifier(row.idempotencyKey, tag),
    creditId: validateResetIdentifier(row.creditId, tag),
    accountId: validateResetIdentifier(row.accountId, tag),
    targetDeviceId: validateResetIdentifier(row.targetDeviceId, tag),
    userId: validateResetIdentifier(row.userId, tag),
    backendId: validateResetIdentifier(row.backendId, tag),
    requestedAt,
    expiresAt,
  };
}

export function parseResetCreditResult(value: unknown): ResetCreditResult {
  const tag = 'reset_credit_result';
  const row = checkRecord(value, RESULT_KEYS, tag);

  if (row.version !== 1) invalid(tag);

  const state = row.state as ResetCreditResultState;
  if (!ALLOWED_RESULT_STATES.has(state)) invalid(tag);

  const code = safeText(row.code, 64, tag) as ResetCreditResultCode;
  if (!ALLOWED_RESULT_CODES.has(code)) invalid(tag);

  const executedAt = parseIsoDate(row.executedAt, tag);
  let completedAt: string | undefined;
  if (row.completedAt !== undefined) {
    completedAt = parseIsoDate(row.completedAt, tag);
    if (Date.parse(completedAt) < Date.parse(executedAt)) invalid(tag);
  }

  return {
    version: 1,
    commandId: validateResetIdentifier(row.commandId, tag),
    idempotencyKey: validateResetIdentifier(row.idempotencyKey, tag),
    creditId: validateResetIdentifier(row.creditId, tag),
    accountId: validateResetIdentifier(row.accountId, tag),
    targetDeviceId: validateResetIdentifier(row.targetDeviceId, tag),
    userId: validateResetIdentifier(row.userId, tag),
    backendId: validateResetIdentifier(row.backendId, tag),
    state,
    code,
    executedAt,
    ...(completedAt !== undefined ? { completedAt } : {}),
  };
}

export function selectActionableResetCredit(
  inventory: ResetCreditInventory,
  now: Date | string | number = new Date(),
): ResetCreditItem | null {
  if (!inventory.accountId || inventory.accountId.trim().length === 0) {
    return null;
  }
  if (!inventory.credits || inventory.credits.length === 0) {
    return null;
  }

  const nowMs = now instanceof Date ? now.getTime() : typeof now === 'string' ? Date.parse(now) : now;
  if (!Number.isFinite(nowMs)) {
    return null;
  }

  const observedAtMs = Date.parse(inventory.observedAt);
  const inventoryExpiresAtMs = Date.parse(inventory.expiresAt);
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(inventoryExpiresAtMs)) {
    return null;
  }

  // Inventory freshness requirement: observedAt <= now < inventory.expiresAt
  if (nowMs < observedAtMs || nowMs >= inventoryExpiresAtMs) {
    return null;
  }

  const eligible = inventory.credits.filter((credit) => {
    if (credit.status !== 'available' || credit.resetType !== 'codexRateLimits') {
      return false;
    }
    if (credit.expiresAt !== null) {
      const expMs = Date.parse(credit.expiresAt);
      if (!Number.isFinite(expMs) || expMs <= nowMs) {
        return false;
      }
    }
    return true;
  });

  if (eligible.length === 0) {
    return null;
  }

  const withKnownExpiry = eligible.filter((c) => c.expiresAt !== null);
  const withUnknownExpiry = eligible.filter((c) => c.expiresAt === null);

  if (withKnownExpiry.length > 0) {
    // Sort by expiresAt ascending
    withKnownExpiry.sort((a, b) => Date.parse(a.expiresAt!) - Date.parse(b.expiresAt!));
    const first = withKnownExpiry[0];
    if (!first || first.expiresAt === null) {
      return null;
    }
    const earliestMs = Date.parse(first.expiresAt);
    const ties = withKnownExpiry.filter((c) => c.expiresAt !== null && Date.parse(c.expiresAt) === earliestMs);
    if (ties.length > 1) {
      // Expiry tie makes identity ambiguous -> never synthesize/select
      return null;
    }
    return first;
  }

  // All eligible have unknown expiry
  if (withUnknownExpiry.length === 1) {
    const single = withUnknownExpiry[0];
    return single ?? null;
  }

  // Multiple unknown expiry credits make identity ambiguous
  return null;
}
