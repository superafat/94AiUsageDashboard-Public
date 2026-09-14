import {
  createECDH,
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';
import {
  canonicalResetInventoryPayload,
  canonicalResetReceiptPayload,
  validatePushKey,
  type ResetCreditInventory,
  type ResetCreditResult,
  type ResetExecutingReceipt,
  type ResetInventoryEnvelope,
  type ResetTerminalReceipt,
} from '@94ai/core';
import type { VapidKeys } from './local-push-keys';

export type { VapidKeys };

export interface ReceiptIdentityFields {
  readonly backendId: string;
  readonly userId: string;
  readonly targetDeviceId: string;
  readonly accountId: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly creditId: string;
  readonly executedAt: string;
}

const PLACEHOLDER_SIG_64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export function buildP256PrivateKey(keys: VapidKeys): KeyObject {
  if (!keys || typeof keys !== 'object') {
    throw new Error('invalid_keys');
  }
  const publicKey = validatePushKey(keys.publicKey, 65);
  const privateKey = validatePushKey(keys.privateKey, 32);

  const ec = createECDH('prime256v1');
  ec.setPrivateKey(Buffer.from(privateKey, 'base64url'));
  const derivedPublic = ec.getPublicKey();
  const expectedPublic = Buffer.from(publicKey, 'base64url');

  if (!timingSafeEqual(derivedPublic, expectedPublic)) {
    throw new Error('push_key_pair_mismatch');
  }

  const x = expectedPublic.subarray(1, 33).toString('base64url');
  const y = expectedPublic.subarray(33, 65).toString('base64url');

  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x,
    y,
    d: privateKey,
  };

  return createPrivateKey({ key: jwk, format: 'jwk' });
}

export function signResetPayload(payload: string, keys: VapidKeys): string {
  const privateKey = buildP256PrivateKey(keys);
  const sigBuf = sign('SHA256', Buffer.from(payload, 'utf8'), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  if (sigBuf.length !== 64) {
    throw new Error('invalid_signature_length');
  }
  return sigBuf.toString('base64url');
}

export function verifyResetSignature(payload: string, signature: string, publicKey: string): boolean {
  try {
    const pubBuf = Buffer.from(publicKey, 'base64url');
    if (pubBuf.length !== 65 || pubBuf[0] !== 0x04) {
      return false;
    }
    const sigBuf = Buffer.from(signature, 'base64url');
    if (sigBuf.length !== 64) {
      return false;
    }
    const x = pubBuf.subarray(1, 33).toString('base64url');
    const y = pubBuf.subarray(33, 65).toString('base64url');
    const jwk = {
      kty: 'EC',
      crv: 'P-256',
      x,
      y,
    };
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    return verify('SHA256', Buffer.from(payload, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, sigBuf);
  } catch {
    return false;
  }
}

export async function createSignedResetInventory(
  inventory: ResetCreditInventory,
  keys: VapidKeys,
): Promise<ResetInventoryEnvelope> {
  const payload = await canonicalResetInventoryPayload(inventory);
  const signature = signResetPayload(payload, keys);
  return {
    version: 1,
    type: 'inventory',
    inventory,
    publicKey: keys.publicKey,
    signature,
  };
}

export function createSignedExecutingReceipt(
  identity: ReceiptIdentityFields,
  keys: VapidKeys,
): ResetExecutingReceipt {
  const placeholder: ResetExecutingReceipt = {
    version: 1,
    type: 'executing',
    publicKey: keys.publicKey,
    signature: PLACEHOLDER_SIG_64,
    backendId: identity.backendId,
    userId: identity.userId,
    targetDeviceId: identity.targetDeviceId,
    accountId: identity.accountId,
    commandId: identity.commandId,
    idempotencyKey: identity.idempotencyKey,
    creditId: identity.creditId,
    executedAt: identity.executedAt,
  };
  const payload = canonicalResetReceiptPayload(placeholder);
  const signature = signResetPayload(payload, keys);
  return {
    ...placeholder,
    signature,
  };
}

export function createSignedTerminalReceipt(
  identity: ReceiptIdentityFields,
  result: ResetCreditResult,
  keys: VapidKeys,
): ResetTerminalReceipt {
  const placeholder: ResetTerminalReceipt = {
    version: 1,
    type: 'terminal',
    publicKey: keys.publicKey,
    signature: PLACEHOLDER_SIG_64,
    backendId: identity.backendId,
    userId: identity.userId,
    targetDeviceId: identity.targetDeviceId,
    accountId: identity.accountId,
    commandId: identity.commandId,
    idempotencyKey: identity.idempotencyKey,
    creditId: identity.creditId,
    executedAt: identity.executedAt,
    result,
  };
  const payload = canonicalResetReceiptPayload(placeholder);
  const signature = signResetPayload(payload, keys);
  return {
    ...placeholder,
    signature,
  };
}
