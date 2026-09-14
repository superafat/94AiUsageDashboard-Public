import {
  parseResetCreditCommand,
  parseResetCreditInventory,
  parseResetCreditResult,
  validateResetIdentifier,
  type ResetCreditCommand,
  type ResetCreditInventory,
  type ResetCreditItem,
  type ResetCreditResult,
} from './reset-credit-command';
import { validatePushKey } from './push-notifications';
import { isValidCalendarDate } from './schema';

const DOMAIN = '94AI_RESET_R2_V1';
const INVENTORY_MAX_MS = 5 * 60_000;
const REQUEST_MAX_MS = 10 * 60_000;
const CLOCK_SKEW_MS = 60_000;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/;

export interface ResetInventoryEnvelope {
  version: 1;
  type: 'inventory';
  inventory: ResetCreditInventory;
  publicKey: string;
  signature: string;
}

export interface ResetCommandRequestRecord {
  version: 1;
  browserId: string;
  producerPublicKey: string;
  leaseExpiresAt: string;
  command: ResetCreditCommand;
}

export interface ResetExecutingReceipt {
  version: 1;
  type: 'executing';
  publicKey: string;
  signature: string;
  backendId: string;
  userId: string;
  targetDeviceId: string;
  accountId: string;
  commandId: string;
  idempotencyKey: string;
  creditId: string;
  executedAt: string;
}

export interface ResetTerminalReceipt extends Omit<ResetExecutingReceipt, 'type'> {
  type: 'terminal';
  result: ResetCreditResult;
}

export type ResetCommandReceipt = ResetExecutingReceipt | ResetTerminalReceipt;

function invalid(tag: string): never {
  throw new Error(`invalid_${tag}`);
}

function object(value: unknown, keys: readonly string[], tag: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return invalid(tag);
  }
  const row = value as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    if (DANGEROUS_KEYS.has(key) || !keys.includes(key)) invalid(tag);
  }
  return row;
}

function iso(value: unknown, tag: string): string {
  if (typeof value !== 'string' || value.length > 35) return invalid(tag);
  const match = ISO_DATE.exec(value);
  if (!match || !isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])) || !Number.isFinite(Date.parse(value))) {
    return invalid(tag);
  }
  return value;
}

function signature64(value: unknown, tag: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return invalid(tag);
  let decoded: string;
  try {
    decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return invalid(tag);
  }
  const canonical = btoa(decoded).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (decoded.length !== 64 || canonical !== value) return invalid(tag);
  return value;
}

function parseR2Inventory(value: unknown, tag: string): ResetCreditInventory {
  let parsed: ResetCreditInventory;
  try {
    parsed = parseResetCreditInventory(value);
  } catch {
    return invalid(tag);
  }
  const observed = Date.parse(parsed.observedAt);
  const expires = Date.parse(parsed.expiresAt);
  if (expires - observed > INVENTORY_MAX_MS) return invalid(tag);
  return parsed;
}

function nowMs(value: number | Date = Date.now()): number {
  const result = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(result)) throw new Error('invalid_transport_clock');
  return result;
}

export function parseResetInventoryEnvelope(value: unknown, now: number | Date = Date.now()): ResetInventoryEnvelope {
  const tag = 'reset_inventory_envelope';
  const row = object(value, ['version', 'type', 'inventory', 'publicKey', 'signature'], tag);
  if (row.version !== 1 || row.type !== 'inventory') return invalid(tag);
  const inventory = parseR2Inventory(row.inventory, tag);
  const clock = nowMs(now);
  const observed = Date.parse(inventory.observedAt);
  const expires = Date.parse(inventory.expiresAt);
  if (observed > clock + CLOCK_SKEW_MS || expires <= clock) return invalid(tag);
  let publicKey: string;
  try {
    publicKey = validatePushKey(row.publicKey, 65);
  } catch {
    return invalid(tag);
  }
  const signature = signature64(row.signature, tag);
  return { version: 1, type: 'inventory', inventory, publicKey, signature };
}

export function parseResetCommandRequestRecord(value: unknown, now: number | Date = Date.now()): ResetCommandRequestRecord {
  const tag = 'reset_command_request';
  const row = object(value, ['version', 'browserId', 'producerPublicKey', 'leaseExpiresAt', 'command'], tag);
  if (row.version !== 1) return invalid(tag);
  let command: ResetCreditCommand;
  try {
    command = parseResetCreditCommand(row.command);
  } catch {
    return invalid(tag);
  }
  let browserId: string;
  try {
    browserId = validateResetIdentifier(row.browserId, tag);
  } catch {
    return invalid(tag);
  }
  let producerPublicKey: string;
  try {
    producerPublicKey = validatePushKey(row.producerPublicKey, 65);
  } catch {
    return invalid(tag);
  }
  const leaseExpiresAt = iso(row.leaseExpiresAt, tag);
  if (leaseExpiresAt !== command.expiresAt) return invalid(tag);
  const requested = Date.parse(command.requestedAt);
  const expires = Date.parse(leaseExpiresAt);
  const clock = nowMs(now);
  if (expires - requested > REQUEST_MAX_MS || requested > clock + CLOCK_SKEW_MS || expires <= clock) return invalid(tag);
  return { version: 1, browserId, producerPublicKey, leaseExpiresAt, command };
}

const RECEIPT_KEYS = [
  'version', 'type', 'publicKey', 'signature', 'backendId', 'userId', 'targetDeviceId', 'accountId',
  'commandId', 'idempotencyKey', 'creditId', 'executedAt', 'result',
] as const;

function receiptIdentity(row: Record<string, unknown>, tag: string): Omit<ResetExecutingReceipt, 'version' | 'type' | 'publicKey' | 'signature'> {
  let publicFields: [string, string, string, string, string, string, string];
  try {
    publicFields = [
      validateResetIdentifier(row.backendId, tag),
      validateResetIdentifier(row.userId, tag),
      validateResetIdentifier(row.targetDeviceId, tag),
      validateResetIdentifier(row.accountId, tag),
      validateResetIdentifier(row.commandId, tag),
      validateResetIdentifier(row.idempotencyKey, tag),
      validateResetIdentifier(row.creditId, tag),
    ];
  } catch {
    return invalid(tag);
  }
  return {
    backendId: publicFields[0], userId: publicFields[1], targetDeviceId: publicFields[2], accountId: publicFields[3],
    commandId: publicFields[4], idempotencyKey: publicFields[5], creditId: publicFields[6], executedAt: iso(row.executedAt, tag),
  };
}

export function parseResetCommandReceipt(value: unknown): ResetCommandReceipt {
  const tag = 'reset_command_receipt';
  const row = object(value, RECEIPT_KEYS, tag);
  if (row.version !== 1 || (row.type !== 'executing' && row.type !== 'terminal')) return invalid(tag);
  let publicKey: string;
  try {
    publicKey = validatePushKey(row.publicKey, 65);
  } catch {
    return invalid(tag);
  }
  const signature = signature64(row.signature, tag);
  const identity = receiptIdentity(row, tag);
  if (row.type === 'executing') {
    if (row.result !== undefined) return invalid(tag);
    return { version: 1, type: 'executing', publicKey, signature, ...identity };
  }
  if (row.result === undefined) return invalid(tag);
  let result: ResetCreditResult;
  try {
    result = parseResetCreditResult(row.result);
  } catch {
    return invalid(tag);
  }
  if (
    result.backendId !== identity.backendId || result.userId !== identity.userId || result.targetDeviceId !== identity.targetDeviceId ||
    result.accountId !== identity.accountId || result.commandId !== identity.commandId || result.idempotencyKey !== identity.idempotencyKey ||
    result.creditId !== identity.creditId || result.executedAt !== identity.executedAt
  ) return invalid(tag);
  return { version: 1, type: 'terminal', publicKey, signature, ...identity, result };
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function digestResetCredits(credits: readonly ResetCreditItem[]): Promise<string> {
  if (!Array.isArray(credits)) return invalid('credits_digest');
  let validated: readonly ResetCreditItem[];
  try {
    validated = parseResetCreditInventory({
      version: 1,
      backendId: 'digest_backend',
      userId: 'digest_user',
      targetDeviceId: 'digest_device',
      accountId: 'digest_account',
      observedAt: '2000-01-01T00:00:00.000Z',
      expiresAt: '2000-01-01T00:01:00.000Z',
      availableCount: credits.length,
      credits: [...credits],
    }).credits ?? [];
  } catch {
    return invalid('credits_digest');
  }
  const rows = [...validated]
    .map((credit) => [credit.creditId, credit.expiresAt ?? '', credit.status, credit.resetType] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const data = new TextEncoder().encode(JSON.stringify(rows));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return base64url(new Uint8Array(digest));
}

export async function canonicalResetInventoryPayload(inventoryValue: ResetCreditInventory): Promise<string> {
  const inventory = parseR2Inventory(inventoryValue, 'reset_inventory_payload');
  const digest = await digestResetCredits(inventory.credits ?? []);
  return JSON.stringify([
    DOMAIN, 'inventory', inventory.backendId, inventory.userId, inventory.targetDeviceId, inventory.accountId,
    inventory.observedAt, inventory.expiresAt, inventory.availableCount, digest,
  ]);
}

export function canonicalResetReceiptPayload(receiptValue: ResetCommandReceipt): string {
  const receipt = parseResetCommandReceipt(receiptValue);
  if (receipt.type === 'executing') {
    return JSON.stringify([
      DOMAIN, 'executing', receipt.backendId, receipt.userId, receipt.targetDeviceId, receipt.accountId,
      receipt.commandId, receipt.idempotencyKey, receipt.creditId, receipt.executedAt,
    ]);
  }
  return JSON.stringify([
    DOMAIN, 'terminal', receipt.backendId, receipt.userId, receipt.targetDeviceId, receipt.accountId,
    receipt.commandId, receipt.idempotencyKey, receipt.creditId, receipt.result.state, receipt.result.code,
    receipt.result.executedAt, receipt.result.completedAt ?? '',
  ]);
}
