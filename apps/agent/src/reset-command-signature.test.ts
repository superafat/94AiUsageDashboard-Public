import { describe, expect, it } from 'vitest';
import webPush from 'web-push';
import {
  canonicalResetInventoryPayload,
  canonicalResetReceiptPayload,
  parseResetCommandReceipt,
  parseResetInventoryEnvelope,
  type ResetCreditInventory,
  type ResetCreditResult,
} from '@94ai/core';
import {
  buildP256PrivateKey,
  createSignedExecutingReceipt,
  createSignedResetInventory,
  createSignedTerminalReceipt,
  signResetPayload,
  verifyResetSignature,
} from './reset-command-signature';

describe('reset-command-signature', () => {
  const keys = webPush.generateVAPIDKeys();
  const otherKeys = webPush.generateVAPIDKeys();

  const inventory: ResetCreditInventory = {
    version: 1,
    backendId: 'test_backend',
    userId: 'test_user',
    targetDeviceId: 'test_device',
    accountId: 'test_account',
    observedAt: '2026-09-12T10:00:00.000Z',
    expiresAt: '2026-09-12T10:05:00.000Z',
    availableCount: 1,
    credits: [
      {
        creditId: 'cred_1',
        expiresAt: '2026-09-12T10:05:00.000Z',
        status: 'available',
        resetType: 'codexRateLimits',
      },
    ],
  };

  const receiptIdentity = {
    backendId: 'test_backend',
    userId: 'test_user',
    targetDeviceId: 'test_device',
    accountId: 'test_account',
    commandId: 'cmd_1',
    idempotencyKey: 'idem_1',
    creditId: 'cred_1',
    executedAt: '2026-09-12T10:01:00.000Z',
  };

  const terminalResult: ResetCreditResult = {
    version: 1,
    backendId: 'test_backend',
    userId: 'test_user',
    targetDeviceId: 'test_device',
    accountId: 'test_account',
    commandId: 'cmd_1',
    idempotencyKey: 'idem_1',
    creditId: 'cred_1',
    state: 'success',
    code: 'reset',
    executedAt: '2026-09-12T10:01:00.000Z',
    completedAt: '2026-09-12T10:01:02.000Z',
  };

  it('builds private key and signs arbitrary payload as IEEE-P1363 64 bytes base64url', () => {
    const privateKey = buildP256PrivateKey(keys);
    expect(privateKey).toBeDefined();

    const payload = '["94AI_RESET_R2_V1","test"]';
    const sig = signResetPayload(payload, keys);

    expect(typeof sig).toBe('string');
    // base64url decoded length must be exactly 64 bytes
    const decoded = Buffer.from(sig, 'base64url');
    expect(decoded.length).toBe(64);

    // Node verify
    expect(verifyResetSignature(payload, sig, keys.publicKey)).toBe(true);
    // Mutation fails
    expect(verifyResetSignature(payload + 'x', sig, keys.publicKey)).toBe(false);
    // Wrong key fails
    expect(verifyResetSignature(payload, sig, otherKeys.publicKey)).toBe(false);
  });

  it('verifies signature using WebCrypto subtle crypto and rejects mutations', async () => {
    const payload = '["94AI_RESET_R2_V1","webcrypto_test"]';
    const sig = signResetPayload(payload, keys);

    // Decode public key JWK coordinates
    const pubBytes = Buffer.from(keys.publicKey, 'base64url');
    expect(pubBytes.length).toBe(65);
    expect(pubBytes[0]).toBe(0x04);
    const x = pubBytes.subarray(1, 33).toString('base64url');
    const y = pubBytes.subarray(33, 65).toString('base64url');

    const cryptoKey = await globalThis.crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x, y },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );

    const sigBytes = Buffer.from(sig, 'base64url');
    const valid = await globalThis.crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      cryptoKey,
      sigBytes,
      new TextEncoder().encode(payload),
    );
    expect(valid).toBe(true);

    const invalid = await globalThis.crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      cryptoKey,
      sigBytes,
      new TextEncoder().encode(payload + '_tampered'),
    );
    expect(invalid).toBe(false);
  });

  it('signs canonical inventory and produces valid verifiable envelope', async () => {
    const now = Date.parse('2026-09-12T10:01:00.000Z');
    const envelope = await createSignedResetInventory(inventory, keys);

    expect(envelope.version).toBe(1);
    expect(envelope.type).toBe('inventory');
    expect(envelope.publicKey).toBe(keys.publicKey);
    expect(Buffer.from(envelope.signature, 'base64url').length).toBe(64);

    // Parse with core parser
    const parsed = parseResetInventoryEnvelope(envelope, now);
    expect(parsed).toEqual(envelope);

    // Verify signature over canonical payload
    const canonicalPayload = await canonicalResetInventoryPayload(envelope.inventory);
    expect(verifyResetSignature(canonicalPayload, envelope.signature, keys.publicKey)).toBe(true);

    // Mutation of accountId fails
    const tamperedPayload = await canonicalResetInventoryPayload({
      ...envelope.inventory,
      accountId: 'other_account',
    });
    expect(verifyResetSignature(tamperedPayload, envelope.signature, keys.publicKey)).toBe(false);
  });

  it('signs executing receipt and produces valid verifiable receipt', () => {
    const receipt = createSignedExecutingReceipt(receiptIdentity, keys);

    expect(receipt.version).toBe(1);
    expect(receipt.type).toBe('executing');
    expect(receipt.publicKey).toBe(keys.publicKey);
    expect(Buffer.from(receipt.signature, 'base64url').length).toBe(64);

    const parsed = parseResetCommandReceipt(receipt);
    expect(parsed).toEqual(receipt);

    const canonicalPayload = canonicalResetReceiptPayload(receipt);
    expect(verifyResetSignature(canonicalPayload, receipt.signature, keys.publicKey)).toBe(true);

    // Tampering fails
    const tamperedReceipt = { ...receipt, creditId: 'cred_other' };
    const tamperedPayload = canonicalResetReceiptPayload(tamperedReceipt);
    expect(verifyResetSignature(tamperedPayload, receipt.signature, keys.publicKey)).toBe(false);
  });

  it('signs terminal receipt and produces valid verifiable receipt', () => {
    const receipt = createSignedTerminalReceipt(receiptIdentity, terminalResult, keys);

    expect(receipt.version).toBe(1);
    expect(receipt.type).toBe('terminal');
    expect(receipt.publicKey).toBe(keys.publicKey);
    expect(Buffer.from(receipt.signature, 'base64url').length).toBe(64);
    expect(receipt.result).toEqual(terminalResult);

    const parsed = parseResetCommandReceipt(receipt);
    expect(parsed).toEqual(receipt);

    const canonicalPayload = canonicalResetReceiptPayload(receipt);
    expect(verifyResetSignature(canonicalPayload, receipt.signature, keys.publicKey)).toBe(true);

    // Tampering result state fails
    const tamperedReceipt = {
      ...receipt,
      result: { ...terminalResult, state: 'failed' as const },
    };
    const tamperedPayload = canonicalResetReceiptPayload(tamperedReceipt);
    expect(verifyResetSignature(tamperedPayload, receipt.signature, keys.publicKey)).toBe(false);
  });

  it('rejects invalid or mismatched keys when building private key', () => {
    expect(() => buildP256PrivateKey({ publicKey: 'invalid', privateKey: keys.privateKey })).toThrow();
    expect(() => buildP256PrivateKey({ publicKey: keys.publicKey, privateKey: 'invalid' })).toThrow();
    expect(() => buildP256PrivateKey({ publicKey: otherKeys.publicKey, privateKey: keys.privateKey })).toThrow();
  });
});
