import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalResetInventoryPayload,
  canonicalResetReceiptPayload,
  type PushProducerRecord,
  type ResetCommandReceipt,
  type ResetCommandRequestRecord,
  type ResetInventoryEnvelope,
} from '@94ai/core';
import { createResetCommandService } from './reset-commands';

const NOW = Date.parse('2026-09-13T00:00:00.000Z');

async function keyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const publicKey = btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { pair, publicKey };
}

function b64url(bytes: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signedInventory(keys: Awaited<ReturnType<typeof keyPair>>, overrides: Record<string, unknown> = {}): Promise<ResetInventoryEnvelope> {
  const inventory = {
    version: 1 as const,
    backendId: 'demo-backend', userId: 'alice', targetDeviceId: 'mac-1', accountId: 'acct-1',
    observedAt: new Date(NOW - 30_000).toISOString(), expiresAt: new Date(NOW + 4 * 60_000).toISOString(),
    availableCount: 1,
    credits: [{ creditId: 'credit-1', expiresAt: new Date(NOW + 86_400_000).toISOString(), status: 'available' as const, resetType: 'codexRateLimits' as const }],
    ...overrides,
  };
  const payload = await canonicalResetInventoryPayload(inventory);
  const signature = b64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.pair.privateKey, new TextEncoder().encode(payload)));
  return { version: 1, type: 'inventory', inventory, publicKey: keys.publicKey, signature };
}

function producer(publicKey: string): PushProducerRecord {
  return { schemaVersion: 1, userId: 'alice', deviceId: 'mac-1', publicKey, updatedAt: new Date(NOW).toISOString() };
}

async function signedTerminal(keys: Awaited<ReturnType<typeof keyPair>>, request: ResetCommandRequestRecord): Promise<ResetCommandReceipt> {
  const result = {
    version: 1 as const, commandId: request.command.commandId, idempotencyKey: request.command.idempotencyKey,
    creditId: request.command.creditId, accountId: request.command.accountId, targetDeviceId: request.command.targetDeviceId,
    userId: request.command.userId, backendId: request.command.backendId, state: 'success' as const, code: 'reset' as const,
    executedAt: new Date(NOW + 1_000).toISOString(), completedAt: new Date(NOW + 2_000).toISOString(),
  };
  const placeholder: ResetCommandReceipt = {
    version: 1, type: 'terminal', publicKey: keys.publicKey,
    signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    backendId: result.backendId, userId: result.userId, targetDeviceId: result.targetDeviceId, accountId: result.accountId,
    commandId: result.commandId, idempotencyKey: result.idempotencyKey, creditId: result.creditId, executedAt: result.executedAt, result,
  };
  const signature = b64url(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.pair.privateKey, new TextEncoder().encode(canonicalResetReceiptPayload(placeholder))));
  return { ...placeholder, signature };
}

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
  clear() { this.data.clear(); }
}

describe('ResetCommandService', () => {
  let storage: MemoryStorage;
  beforeEach(() => { storage = new MemoryStorage(); vi.useRealTimers(); });

  it('requires explicit TOFU pairing and isolates pins by backend, uid, and device', async () => {
    const keys = await keyPair();
    const service = createResetCommandService({ backendId: 'demo-backend', storage, now: () => NOW });
    expect(service.getPairing('alice', 'mac-1')).toBeNull();
    const pin = service.pair('alice', producer(keys.publicKey));
    expect(pin).toMatchObject({ backendId: 'demo-backend', userId: 'alice', deviceId: 'mac-1', publicKey: keys.publicKey });
    expect(service.getPairing('alice', 'mac-1')).toEqual(pin);
    expect(createResetCommandService({ backendId: 'other-backend', storage }).getPairing('alice', 'mac-1')).toBeNull();
    storage.setItem('94ai.reset.r2.demo-backend.alice.bad-device', '{bad json');
    expect(service.getPairing('alice', 'bad-device')).toBeNull();
  });

  it('accepts only fresh signed inventory matching both TOFU pin and current producer key', async () => {
    const keys = await keyPair(); const other = await keyPair();
    const service = createResetCommandService({ backendId: 'demo-backend', storage, now: () => NOW });
    service.pair('alice', producer(keys.publicKey));
    const envelope = await signedInventory(keys);
    const verified = await service.verifyInventory('alice', producer(keys.publicKey), envelope);
    expect(verified.status).toBe('ready');
    expect(verified.credit?.creditId).toBe('credit-1');
    expect((await service.verifyInventory('alice', producer(other.publicKey), envelope)).status).toBe('key_mismatch');
    const stale = await signedInventory(keys, { observedAt: new Date(NOW - 10 * 60_000).toISOString(), expiresAt: new Date(NOW - 5 * 60_000).toISOString() });
    expect((await service.verifyInventory('alice', producer(keys.publicKey), stale)).status).not.toBe('ready');
  });

  it('creates an exact short-lived request and double dispatch writes only once', async () => {
    const keys = await keyPair(); const writes: ResetCommandRequestRecord[] = [];
    const service = createResetCommandService({
      backendId: 'demo-backend', storage, now: () => NOW,
      randomId: (() => { let n = 0; return () => `id-${++n}`; })(),
      writeRequest: async (_uid, request) => { writes.push(request); },
    });
    service.pair('alice', producer(keys.publicKey));
    const verified = await service.verifyInventory('alice', producer(keys.publicKey), await signedInventory(keys));
    const [a, b] = await Promise.all([service.dispatch(verified), service.dispatch(verified)]);
    expect(writes).toHaveLength(1); expect(a).toEqual(b);
    expect(a.command).toMatchObject({ backendId: 'demo-backend', userId: 'alice', targetDeviceId: 'mac-1', accountId: 'acct-1', creditId: 'credit-1' });
    expect(a.producerPublicKey).toBe(keys.publicKey);
    expect(Date.parse(a.leaseExpiresAt) - Date.parse(a.command.requestedAt)).toBeLessThanOrEqual(10 * 60_000);
  });

  it('rechecks inventory freshness at dispatch time so an old confirmation cannot consume a voucher', async () => {
    const keys = await keyPair(); let clock = NOW; const writeRequest = vi.fn(async () => undefined);
    const service = createResetCommandService({ backendId: 'demo-backend', storage, now: () => clock, writeRequest });
    service.pair('alice', producer(keys.publicKey));
    const verified = await service.verifyInventory('alice', producer(keys.publicKey), await signedInventory(keys));
    expect(verified.status).toBe('ready');
    clock = NOW + 6 * 60_000;
    await expect(service.dispatch(verified)).rejects.toThrow(/fresh|actionable|expired/i);
    expect(writeRequest).not.toHaveBeenCalled();
  });

  it('never trusts forged same-UID success and accepts only exact signed receipt', async () => {
    const keys = await keyPair();
    const service = createResetCommandService({ backendId: 'demo-backend', storage, now: () => NOW, writeRequest: async () => undefined });
    service.pair('alice', producer(keys.publicKey));
    const verified = await service.verifyInventory('alice', producer(keys.publicKey), await signedInventory(keys));
    const request = await service.dispatch(verified);
    const valid = await signedTerminal(keys, request);
    expect((await service.verifyReceipt('alice', producer(keys.publicKey), request, valid)).status).toBe('terminal');
    const forged = { ...valid, signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
    expect((await service.verifyReceipt('alice', producer(keys.publicKey), request, forged)).status).toBe('unverified');
  });

  it('marks waiting as uncertain after timeout and never retries the request', async () => {
    vi.useFakeTimers();
    const keys = await keyPair(); const writeRequest = vi.fn(async () => undefined);
    const service = createResetCommandService({ backendId: 'demo-backend', storage, now: () => NOW, writeRequest, resultTimeoutMs: 1000 });
    service.pair('alice', producer(keys.publicKey));
    const verified = await service.verifyInventory('alice', producer(keys.publicKey), await signedInventory(keys));
    const request = await service.dispatch(verified);
    const states: string[] = [];
    const stop = service.watchResult('alice', producer(keys.publicKey), request, (s) => states.push(s.status));
    await vi.advanceTimersByTimeAsync(1001);
    expect(states).toContain('uncertain');
    expect(writeRequest).toHaveBeenCalledTimes(1);
    stop();
  });
});
