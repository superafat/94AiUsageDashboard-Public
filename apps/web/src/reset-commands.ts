import {
  canonicalResetInventoryPayload,
  canonicalResetReceiptPayload,
  parsePushProducerRecord,
  parseResetCommandReceipt,
  parseResetInventoryEnvelope,
  selectActionableResetCredit,
  validatePushKey,
  validateResetIdentifier,
  type PushProducerRecord,
  type ResetCommandReceipt,
  type ResetCommandRequestRecord,
  type ResetInventoryEnvelope,
} from '@94ai/core';
import type { ResetCommandProgress as ResetResultState, ResetPairingPin, ResetVerifiedInventory as VerifiedResetInventory } from '@94ai/client';

export type { ResetPairingPin, VerifiedResetInventory, ResetResultState };

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface ResetCommandServiceDeps {
  backendId: string;
  storage?: StorageLike;
  now?: () => number;
  randomId?: () => string;
  subscribeProducers?: (uid: string, onValue: (items: PushProducerRecord[]) => void, onError?: (error: Error) => void) => () => void;
  subscribeInventory?: (uid: string, deviceId: string, onValue: (envelope: ResetInventoryEnvelope | undefined) => void, onError?: (error: Error) => void) => () => void;
  writeRequest?: (uid: string, request: ResetCommandRequestRecord) => Promise<void>;
  subscribeResult?: (
    uid: string,
    deviceId: string,
    commandId: string,
    onValue: (receipt: ResetCommandReceipt | undefined) => void,
    onError?: (error: Error) => void,
  ) => () => void;
  resultTimeoutMs?: number;
}

const PIN_KEYS = ['backendId', 'userId', 'deviceId', 'publicKey', 'browserId'] as const;

function storageKey(backendId: string, uid: string, deviceId: string): string {
  return `94ai.reset.r2.${encodeURIComponent(backendId)}.${encodeURIComponent(uid)}.${encodeURIComponent(deviceId)}`;
}

function parsePin(value: unknown, backendId: string, uid: string, deviceId: string): ResetPairingPin | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (Object.keys(row).sort().join(',') !== [...PIN_KEYS].sort().join(',')) return null;
    const parsed: ResetPairingPin = {
      backendId: validateResetIdentifier(row.backendId, 'reset_pairing'),
      userId: validateResetIdentifier(row.userId, 'reset_pairing'),
      deviceId: validateResetIdentifier(row.deviceId, 'reset_pairing'),
      publicKey: validatePushKey(row.publicKey, 65),
      browserId: validateResetIdentifier(row.browserId, 'reset_pairing'),
    };
    if (parsed.backendId !== backendId || parsed.userId !== uid || parsed.deviceId !== deviceId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function decodeBase64url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function verifyP256(payload: string, signature: string, publicKey: string): Promise<boolean> {
  try {
    const rawPublic = decodeBase64url(validatePushKey(publicKey, 65));
    const rawSignature = decodeBase64url(signature);
    if (rawSignature.length !== 64) return false;
    const key = await crypto.subtle.importKey('raw', exactArrayBuffer(rawPublic), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      exactArrayBuffer(rawSignature),
      exactArrayBuffer(new TextEncoder().encode(payload)),
    );
  } catch {
    return false;
  }
}

function sameRequestIdentity(request: ResetCommandRequestRecord, receipt: ResetCommandReceipt): boolean {
  const command = request.command;
  return receipt.backendId === command.backendId
    && receipt.userId === command.userId
    && receipt.targetDeviceId === command.targetDeviceId
    && receipt.accountId === command.accountId
    && receipt.commandId === command.commandId
    && receipt.idempotencyKey === command.idempotencyKey
    && receipt.creditId === command.creditId;
}

export function createResetCommandService(deps: ResetCommandServiceDeps) {
  const backendId = validateResetIdentifier(deps.backendId, 'reset_backend');
  const storage = deps.storage ?? localStorage;
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? (() => crypto.randomUUID());
  const pending = new Map<string, Promise<ResetCommandRequestRecord>>();
  const resultTimeoutMs = deps.resultTimeoutMs ?? 10 * 60_000;

  const getPairing = (uid: string, deviceId: string): ResetPairingPin | null => {
    const key = storageKey(backendId, uid, deviceId);
    const raw = storage.getItem(key);
    if (!raw) return null;
    try {
      const pin = parsePin(JSON.parse(raw), backendId, uid, deviceId);
      if (!pin) storage.removeItem(key);
      return pin;
    } catch {
      storage.removeItem(key);
      return null;
    }
  };

  const pair = (uid: string, producerValue: PushProducerRecord): ResetPairingPin => {
    const producer = parsePushProducerRecord(producerValue);
    const safeUid = validateResetIdentifier(uid, 'reset_pairing_uid');
    if (producer.userId !== safeUid) throw new Error('reset_pairing_uid_mismatch');
    const existing = getPairing(safeUid, producer.deviceId);
    if (existing && existing.publicKey !== producer.publicKey) throw new Error('reset_pairing_key_changed');
    const pin: ResetPairingPin = existing ?? {
      backendId,
      userId: safeUid,
      deviceId: producer.deviceId,
      publicKey: producer.publicKey,
      browserId: validateResetIdentifier(`browser-${randomId()}`, 'reset_browser_id'),
    };
    storage.setItem(storageKey(backendId, safeUid, producer.deviceId), JSON.stringify(pin));
    return pin;
  };

  const verifyInventory = async (
    uid: string,
    producerValue: PushProducerRecord,
    envelopeValue: ResetInventoryEnvelope,
  ): Promise<VerifiedResetInventory> => {
    const producer = parsePushProducerRecord(producerValue);
    const pin = getPairing(uid, producer.deviceId);
    if (!pin) return { status: 'unpaired' };
    if (producer.userId !== uid || producer.publicKey !== pin.publicKey) return { status: 'key_mismatch' };
    try {
      const envelope = parseResetInventoryEnvelope(envelopeValue, now());
      if (
        envelope.publicKey !== pin.publicKey
        || envelope.inventory.backendId !== backendId
        || envelope.inventory.userId !== uid
        || envelope.inventory.targetDeviceId !== producer.deviceId
      ) return { status: 'unverified' };
      const payload = await canonicalResetInventoryPayload(envelope.inventory);
      if (!(await verifyP256(payload, envelope.signature, pin.publicKey))) return { status: 'unverified' };
      const credit = selectActionableResetCredit(envelope.inventory, now());
      if (!credit) return { status: 'unavailable' };
      return { status: 'ready', pin, producer, envelope, credit };
    } catch {
      return { status: 'unavailable' };
    }
  };

  const dispatch = async (verified: VerifiedResetInventory): Promise<ResetCommandRequestRecord> => {
    if (verified.status !== 'ready') throw new Error('reset_inventory_not_actionable');
    let freshEnvelope: ResetInventoryEnvelope;
    try {
      freshEnvelope = parseResetInventoryEnvelope(verified.envelope, now());
    } catch {
      throw new Error('reset_inventory_not_fresh');
    }
    const freshCredit = selectActionableResetCredit(freshEnvelope.inventory, now());
    if (!freshCredit || freshCredit.creditId !== verified.credit.creditId) throw new Error('reset_inventory_not_actionable');
    if (!deps.writeRequest) throw new Error('reset_request_transport_unavailable');
    const pendingKey = `${verified.pin.userId}\u0000${verified.pin.deviceId}`;
    const existing = pending.get(pendingKey);
    if (existing) return existing;
    const operation = (async () => {
      const requestedAtMs = now();
      const requestedAt = new Date(requestedAtMs).toISOString();
      const expiresAt = new Date(requestedAtMs + 8 * 60_000).toISOString();
      const request: ResetCommandRequestRecord = {
        version: 1,
        browserId: verified.pin.browserId,
        producerPublicKey: verified.pin.publicKey,
        leaseExpiresAt: expiresAt,
        command: {
          version: 1,
          commandId: validateResetIdentifier(`cmd-${randomId()}`, 'reset_command_id'),
          idempotencyKey: validateResetIdentifier(`idem-${randomId()}`, 'reset_idempotency_key'),
          creditId: verified.credit.creditId,
          accountId: verified.envelope.inventory.accountId,
          targetDeviceId: verified.pin.deviceId,
          userId: verified.pin.userId,
          backendId,
          requestedAt,
          expiresAt,
        },
      };
      await deps.writeRequest!(verified.pin.userId, request);
      return request;
    })();
    pending.set(pendingKey, operation);
    try {
      return await operation;
    } catch (error) {
      pending.delete(pendingKey);
      throw error;
    }
  };

  const verifyReceipt = async (
    uid: string,
    producerValue: PushProducerRecord,
    request: ResetCommandRequestRecord,
    receiptValue: ResetCommandReceipt,
  ): Promise<ResetResultState> => {
    const producer = parsePushProducerRecord(producerValue);
    const pin = getPairing(uid, producer.deviceId);
    if (!pin || producer.userId !== uid || producer.publicKey !== pin.publicKey) return { status: 'unverified', request };
    try {
      const receipt = parseResetCommandReceipt(receiptValue);
      if (receipt.publicKey !== pin.publicKey || !sameRequestIdentity(request, receipt)) return { status: 'unverified', request };
      const payload = canonicalResetReceiptPayload(receipt);
      if (!(await verifyP256(payload, receipt.signature, pin.publicKey))) return { status: 'unverified', request };
      if (receipt.type === 'executing') return { status: 'executing', request, receipt };
      pending.delete(`${uid}\u0000${producer.deviceId}`);
      return { status: 'terminal', request, receipt };
    } catch {
      return { status: 'unverified', request };
    }
  };

  const watchResult = (
    uid: string,
    producer: PushProducerRecord,
    request: ResetCommandRequestRecord,
    onValue: (state: ResetResultState) => void,
    onError?: (error: Error) => void,
  ): (() => void) => {
    let active = true;
    let stopRemote: () => void = () => undefined;
    const timer = setTimeout(() => {
      if (!active) return;
      onValue({ status: 'uncertain', request });
    }, resultTimeoutMs);
    onValue({ status: 'waiting', request });
    if (deps.subscribeResult) {
      stopRemote = deps.subscribeResult(uid, request.command.targetDeviceId, request.command.commandId, (receipt) => {
        if (!active || !receipt) return;
        void verifyReceipt(uid, producer, request, receipt).then((state) => {
          if (!active) return;
          if (state.status === 'terminal' || state.status === 'unverified') clearTimeout(timer);
          onValue(state);
        }).catch((error) => onError?.(error instanceof Error ? error : new Error(String(error))));
      }, onError);
    }
    return () => { active = false; clearTimeout(timer); stopRemote(); };
  };

  const subscribeProducers = (uid: string, onValue: (items: PushProducerRecord[]) => void, onError?: (error: Error) => void): (() => void) => {
    if (!deps.subscribeProducers) { onValue([]); return () => undefined; }
    return deps.subscribeProducers(uid, onValue, onError);
  };

  const subscribeInventory = (uid: string, producer: PushProducerRecord, onValue: (value: VerifiedResetInventory) => void, onError?: (error: Error) => void): (() => void) => {
    if (!deps.subscribeInventory) { onValue({ status: 'unavailable' }); return () => undefined; }
    let active = true;
    const stop = deps.subscribeInventory(uid, producer.deviceId, (envelope) => {
      if (!active) return;
      if (!envelope) { onValue(getPairing(uid, producer.deviceId) ? { status: 'unavailable' } : { status: 'unpaired' }); return; }
      void verifyInventory(uid, producer, envelope).then((value) => { if (active) onValue(value); }).catch((error) => onError?.(error instanceof Error ? error : new Error(String(error))));
    }, onError);
    return () => { active = false; stop(); };
  };

  return { subscribeProducers, getPairing, pair, verifyInventory, subscribeInventory, dispatch, verifyReceipt, watchResult };
}
