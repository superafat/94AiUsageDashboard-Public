import { describe, expect, it } from 'vitest';
import type { ResetCreditCommand, ResetCreditInventory, ResetCreditResult } from './reset-credit-command';
import {
  canonicalResetInventoryPayload,
  canonicalResetReceiptPayload,
  digestResetCredits,
  parseResetCommandReceipt,
  parseResetCommandRequestRecord,
  parseResetInventoryEnvelope,
} from './reset-command-transport';

const now = Date.parse('2026-09-12T12:00:00.000Z');
const publicKey = btoa(String.fromCharCode(4, ...new Array(64).fill(0))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const signature = btoa(String.fromCharCode(...new Array(64).fill(1))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const inventory: ResetCreditInventory = {
  version: 1,
  backendId: 'prod-backend',
  userId: 'user_123',
  targetDeviceId: 'mac_dev_456',
  accountId: 'acc_codex_789',
  observedAt: '2026-09-12T11:58:00.000Z',
  expiresAt: '2026-09-12T12:03:00.000Z',
  availableCount: 2,
  credits: [
    { creditId: 'credit_b', expiresAt: '2026-09-15T00:00:00.000Z', status: 'available', resetType: 'codexRateLimits' },
    { creditId: 'credit_a', expiresAt: null, status: 'available', resetType: 'codexRateLimits' },
  ],
};

const command: ResetCreditCommand = {
  version: 1,
  commandId: 'cmd_100',
  idempotencyKey: 'idem_200',
  creditId: 'credit_b',
  accountId: inventory.accountId,
  targetDeviceId: inventory.targetDeviceId,
  userId: inventory.userId,
  backendId: inventory.backendId,
  requestedAt: '2026-09-12T11:59:00.000Z',
  expiresAt: '2026-09-12T12:09:00.000Z',
};

const result: ResetCreditResult = {
  version: 1,
  commandId: command.commandId,
  idempotencyKey: command.idempotencyKey,
  creditId: command.creditId,
  accountId: command.accountId,
  targetDeviceId: command.targetDeviceId,
  userId: command.userId,
  backendId: command.backendId,
  state: 'success',
  code: 'reset',
  executedAt: '2026-09-12T12:00:05.000Z',
  completedAt: '2026-09-12T12:00:06.000Z',
};

describe('reset command R2 transport contract', () => {
  it('parses a fresh signed inventory and rejects >5 minute, expired, or unknown-key envelopes', () => {
    const value = { version: 1, type: 'inventory', inventory, publicKey, signature } as const;
    expect(parseResetInventoryEnvelope(value, now)).toEqual(value);
    expect(() => parseResetInventoryEnvelope({ ...value, extra: true }, now)).toThrow('invalid_reset_inventory_envelope');
    expect(() => parseResetInventoryEnvelope({ ...value, inventory: { ...inventory, expiresAt: '2026-09-12T12:03:00.001Z' } }, now)).toThrow('invalid_reset_inventory_envelope');
    expect(() => parseResetInventoryEnvelope({ ...value, inventory: { ...inventory, expiresAt: '2026-09-12T11:59:59.000Z' } }, now)).toThrow('invalid_reset_inventory_envelope');
  });

  it('parses one bounded request lease and rejects identity mismatch, expiry, and >10 minute TTL', () => {
    const value = { version: 1, browserId: 'browser_1', producerPublicKey: publicKey, leaseExpiresAt: command.expiresAt, command } as const;
    expect(parseResetCommandRequestRecord(value, now)).toEqual(value);
    expect(() => parseResetCommandRequestRecord({ ...value, browserId: 'bad browser' }, now)).toThrow('invalid_reset_command_request');
    expect(() => parseResetCommandRequestRecord({ ...value, extra: true }, now)).toThrow('invalid_reset_command_request');
    expect(() => parseResetCommandRequestRecord({ ...value, leaseExpiresAt: '2026-09-12T12:09:01.000Z', command: { ...command, expiresAt: '2026-09-12T12:09:01.000Z' } }, now)).toThrow('invalid_reset_command_request');
    expect(() => parseResetCommandRequestRecord({ ...value, leaseExpiresAt: '2026-09-12T11:59:59.000Z', command: { ...command, expiresAt: '2026-09-12T11:59:59.000Z' } }, now)).toThrow('invalid_reset_command_request');
    expect(() => parseResetCommandRequestRecord({ ...value, leaseExpiresAt: '2026-09-12T12:08:00.000Z' }, now)).toThrow('invalid_reset_command_request');
  });

  it('rejects malformed public keys and signatures', () => {
    expect(() => parseResetInventoryEnvelope({ version: 1, type: 'inventory', inventory, publicKey: 'not-base64!', signature }, now)).toThrow();
    expect(() => parseResetInventoryEnvelope({ version: 1, type: 'inventory', inventory, publicKey, signature: 'short' }, now)).toThrow();
  });

  it('makes the credits digest deterministic by creditId rather than input order', async () => {
    const forward = await digestResetCredits(inventory.credits!);
    const reverse = await digestResetCredits([...inventory.credits!].reverse());
    expect(forward).toBe(reverse);
    expect(forward).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('uses locale-independent binary ordering for credit IDs in the digest', async () => {
    const credits = [
      { creditId: 'credit_a', expiresAt: null, status: 'available' as const, resetType: 'codexRateLimits' as const },
      { creditId: 'credit-a', expiresAt: null, status: 'available' as const, resetType: 'codexRateLimits' as const },
    ];
    const rows = [...credits]
      .map((credit) => [credit.creditId, '', credit.status, credit.resetType] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const bytes = new TextEncoder().encode(JSON.stringify(rows));
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const expected = btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await digestResetCredits(credits)).toBe(expected);
  });

  it('fails closed when digest rows are duplicated or invalid', async () => {
    const duplicate = [inventory.credits![0]!, inventory.credits![0]!];
    await expect(digestResetCredits(duplicate)).rejects.toThrow();
    await expect(digestResetCredits([{ creditId: 'bad id', expiresAt: null, status: 'available', resetType: 'codexRateLimits' }] as never)).rejects.toThrow();
  });

  it('builds the exact scalar inventory signing payload and signs every trusted inventory field', async () => {
    const payload = JSON.parse(await canonicalResetInventoryPayload(inventory)) as unknown[];
    expect(payload).toHaveLength(10);
    expect(payload.slice(0, 9)).toEqual([
      '94AI_RESET_R2_V1', 'inventory', inventory.backendId, inventory.userId, inventory.targetDeviceId,
      inventory.accountId, inventory.observedAt, inventory.expiresAt, inventory.availableCount,
    ]);
    expect(typeof payload[9]).toBe('string');
    const changed = await canonicalResetInventoryPayload({ ...inventory, accountId: 'acc_other' });
    expect(changed).not.toBe(JSON.stringify(payload));
  });

  it('parses executing receipt and terminal receipt only when identities match nested R1 result', () => {
    const executing = {
      version: 1, type: 'executing', publicKey, signature,
      backendId: command.backendId, userId: command.userId, targetDeviceId: command.targetDeviceId,
      accountId: command.accountId, commandId: command.commandId, idempotencyKey: command.idempotencyKey,
      creditId: command.creditId, executedAt: result.executedAt,
    } as const;
    expect(parseResetCommandReceipt(executing)).toEqual(executing);
    const terminal = { ...executing, type: 'terminal' as const, result };
    expect(parseResetCommandReceipt(terminal)).toEqual(terminal);
    expect(() => parseResetCommandReceipt({ ...terminal, accountId: 'acc_other' })).toThrow('invalid_reset_command_receipt');
    expect(() => parseResetCommandReceipt({ ...terminal, result: { ...result, creditId: 'credit_other' } })).toThrow('invalid_reset_command_receipt');
    expect(() => parseResetCommandReceipt({ ...terminal, extra: 'x' })).toThrow('invalid_reset_command_receipt');
  });

  it('canonicalizes executing and terminal receipts as fixed scalar arrays with no unsigned trusted fields', () => {
    const executing = {
      version: 1 as const, type: 'executing' as const, publicKey, signature,
      backendId: command.backendId, userId: command.userId, targetDeviceId: command.targetDeviceId,
      accountId: command.accountId, commandId: command.commandId, idempotencyKey: command.idempotencyKey,
      creditId: command.creditId, executedAt: result.executedAt,
    };
    expect(JSON.parse(canonicalResetReceiptPayload(executing))).toEqual([
      '94AI_RESET_R2_V1', 'executing', command.backendId, command.userId, command.targetDeviceId,
      command.accountId, command.commandId, command.idempotencyKey, command.creditId, result.executedAt,
    ]);
    const terminal = { ...executing, type: 'terminal' as const, result };
    expect(JSON.parse(canonicalResetReceiptPayload(terminal))).toEqual([
      '94AI_RESET_R2_V1', 'terminal', command.backendId, command.userId, command.targetDeviceId,
      command.accountId, command.commandId, command.idempotencyKey, command.creditId,
      result.state, result.code, result.executedAt, result.completedAt,
    ]);
  });
});
