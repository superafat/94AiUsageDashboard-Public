import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import webPush from 'web-push';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc, deleteDoc, type DocumentData, type Firestore } from 'firebase/firestore';
import {
  resetCloudInventoryEnvelope,
  type PushProducerRecord,
  type ResetCommandRequestRecord,
  type ResetCreditInventory,
  type ResetCreditItem,
  type ResetCreditResult,
  type ResetExecutingReceipt,
  type ResetTerminalReceipt,
} from '@94ai/core';
import {
  pushProducerDocPath,
  resetInventoryDocPath,
  resetRequestDocPath,
  resetResultDocPath,
  writeResetCommandRequest,
} from '@94ai/firebase';
import {
  createSignedResetInventory,
  createSignedTerminalReceipt,
} from '../apps/agent/src/reset-command-signature';
import { ResetCommandJournal } from '../apps/agent/src/reset-command-journal';
import {
  projectActionableCredits,
  runResetCommandSync,
  type ResetAdapterLike,
} from '../apps/agent/src/reset-command-runtime';
import { createResetCommandService } from '../apps/web/src/reset-commands';

let env: RulesTestEnvironment;

function makeKeys() {
  const generated = webPush.generateVAPIDKeys();
  return {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
  };
}

function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
  };
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-94aiusage',
    firestore: { rules: fs.readFileSync('firestore.rules', 'utf8') },
  });
});

afterAll(async () => {
  await env.cleanup();
});

describe('Issue #30 R2 Reset Credit Paired Transport Acceptance', () => {
  const uid = 'alice-r2';
  const backendId = 'demo-94aiusage';
  const accountId = 'codex-acc-1';

  async function seedProducer(db: Firestore, deviceId: string, publicKey: string) {
    const producer: PushProducerRecord = {
      schemaVersion: 1,
      userId: uid,
      deviceId,
      publicKey,
      updatedAt: new Date().toISOString(),
    };
    await setDoc(doc(db, pushProducerDocPath(uid, deviceId)), producer);
    return producer;
  }

  // 1. Two phones one fixed slot
  it('1. two phones one fixed slot: second phone cannot overwrite an active unexpired request', async () => {
    const aliceContext = env.authenticatedContext(uid);
    const db = aliceContext.firestore();
    const mac1Keys = makeKeys();
    await seedProducer(db, 'mac-slot', mac1Keys.publicKey);

    const now = Date.now();
    const requestedAt = new Date(now).toISOString();
    const leaseExpiresAt = new Date(now + 8 * 60_000).toISOString();

    const phone1Request: ResetCommandRequestRecord = {
      version: 1,
      browserId: 'phone-1-browser',
      producerPublicKey: mac1Keys.publicKey,
      leaseExpiresAt,
      command: {
        version: 1,
        commandId: 'cmd-phone-1',
        idempotencyKey: 'idem-phone-1',
        creditId: 'credit-1',
        accountId,
        targetDeviceId: 'mac-slot',
        userId: uid,
        backendId,
        requestedAt,
        expiresAt: leaseExpiresAt,
      },
    };

    // Phone 1 writes request via writeResetCommandRequest
    await assertSucceeds(writeResetCommandRequest(db, uid, phone1Request));

    // Phone 2 tries to write another request to the same slot while Phone 1 lease is still active
    const phone2Request: ResetCommandRequestRecord = {
      version: 1,
      browserId: 'phone-2-browser',
      producerPublicKey: mac1Keys.publicKey,
      leaseExpiresAt: new Date(now + 9 * 60_000).toISOString(),
      command: {
        version: 1,
        commandId: 'cmd-phone-2',
        idempotencyKey: 'idem-phone-2',
        creditId: 'credit-1',
        accountId,
        targetDeviceId: 'mac-slot',
        userId: uid,
        backendId,
        requestedAt,
        expiresAt: new Date(now + 9 * 60_000).toISOString(),
      },
    };

    // Phone 2 client write throws active_request_lease_active
    await expect(writeResetCommandRequest(db, uid, phone2Request)).rejects.toThrow('active_request_lease_active');

    // Direct Firestore write without slot release is rejected by Rules
    await assertFails(setDoc(doc(db, resetRequestDocPath(uid, 'mac-slot')), {
      ...phone2Request,
      requestedAtTimestamp: new Date(),
      leaseExpiresAtTimestamp: new Date(now + 9 * 60_000),
    }));
  });

  // 2. Two Macs isolation
  it('2. two Macs isolation: requests and runtimes for mac-1 and mac-2 never cross-talk', async () => {
    const aliceContext = env.authenticatedContext(uid);
    const db = aliceContext.firestore();
    const mac1Keys = makeKeys();
    const mac2Keys = makeKeys();
    await seedProducer(db, 'mac-iso-1', mac1Keys.publicKey);
    await seedProducer(db, 'mac-iso-2', mac2Keys.publicKey);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-iso-'));
    const journal1 = new ResetCommandJournal({ rootDir: tempDir, backendId, accountId, userId: uid, deviceId: 'mac-iso-1' });
    const journal2 = new ResetCommandJournal({ rootDir: tempDir, backendId, accountId, userId: uid, deviceId: 'mac-iso-2' });

    let mac1ProviderCalls = 0;
    let mac2ProviderCalls = 0;

    const adapter1: ResetAdapterLike = {
      consumeResetCredit: async () => { mac1ProviderCalls++; return { state: 'success', code: 'reset', completedAt: new Date().toISOString() }; },
    };
    const adapter2: ResetAdapterLike = {
      consumeResetCredit: async () => { mac2ProviderCalls++; return { state: 'success', code: 'reset', completedAt: new Date().toISOString() }; },
    };

    const now = Date.now();
    const leaseExpiresAt = new Date(now + 8 * 60_000).toISOString();
    const reqForMac1: ResetCommandRequestRecord = {
      version: 1,
      browserId: 'browser-iso',
      producerPublicKey: mac1Keys.publicKey,
      leaseExpiresAt,
      command: {
        version: 1,
        commandId: 'cmd-iso-1',
        idempotencyKey: 'idem-iso-1',
        creditId: 'credit-1',
        accountId,
        targetDeviceId: 'mac-iso-1',
        userId: uid,
        backendId,
        requestedAt: new Date(now).toISOString(),
        expiresAt: leaseExpiresAt,
      },
    };

    await writeResetCommandRequest(db, uid, reqForMac1);

    const extractRequest = (data: DocumentData | undefined): ResetCommandRequestRecord | undefined => {
      if (!data) return undefined;
      return {
        version: data.version,
        browserId: data.browserId,
        producerPublicKey: data.producerPublicKey,
        leaseExpiresAt: data.leaseExpiresAt,
        command: data.command,
      };
    };

    // Mac 2 runtime runs: reads its own device slot, should find no request for mac-iso-2
    const mac2Result = await runResetCommandSync({
      env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1' },
      backendId,
      userId: uid,
      deviceId: 'mac-iso-2',
      keys: mac2Keys,
      readRequest: async (_u, d) => {
        const snap = await getDoc(doc(db, resetRequestDocPath(uid, d)));
        return snap.exists() ? extractRequest(snap.data()) : undefined;
      },
      writeExecutingResult: async () => undefined,
      writeTerminalResult: async () => undefined,
      deleteInventory: async () => undefined,
      journal: journal2,
      adapter: adapter2,
    });
    expect(mac2Result.status).toBe('idle');
    expect(mac2ProviderCalls).toBe(0);

    // Mac 1 runtime runs: executes cmd-iso-1 successfully
    const mac1Result = await runResetCommandSync({
      env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1', AI_USAGE_RESET_REAL_CONSUME_ENABLED: '1' },
      backendId,
      userId: uid,
      deviceId: 'mac-iso-1',
      keys: mac1Keys,
      readRequest: async (_u, d) => {
        const snap = await getDoc(doc(db, resetRequestDocPath(uid, d)));
        return snap.exists() ? extractRequest(snap.data()) : undefined;
      },
      writeExecutingResult: async (receipt) => {
        await setDoc(doc(db, resetResultDocPath(uid, 'mac-iso-1', receipt.commandId)), receipt);
      },
      writeTerminalResult: async (receipt) => {
        await setDoc(doc(db, resetResultDocPath(uid, 'mac-iso-1', receipt.commandId)), receipt);
      },
      deleteInventory: async () => undefined,
      journal: journal1,
      adapter: adapter1,
    });
    expect(mac1Result.status).toBe('command_executed');
    expect(mac1ProviderCalls).toBe(1);
  });

  // 3. Wrong UID/device/key
  it('3. wrong UID/device/key: rejected closed at rules, runtime, and web client boundaries', async () => {
    const aliceDb = env.authenticatedContext(uid).firestore();
    const bobDb = env.authenticatedContext('bob-attacker').firestore();
    const macKeys = makeKeys();
    await seedProducer(aliceDb, 'mac-reject', macKeys.publicKey);

    const now = Date.now();
    const leaseExpiresAt = new Date(now + 8 * 60_000).toISOString();
    const req: ResetCommandRequestRecord = {
      version: 1,
      browserId: 'browser-good',
      producerPublicKey: macKeys.publicKey,
      leaseExpiresAt,
      command: {
        version: 1,
        commandId: 'cmd-wrong-uid',
        idempotencyKey: 'idem-wrong-uid',
        creditId: 'credit-1',
        accountId,
        targetDeviceId: 'mac-reject',
        userId: uid,
        backendId,
        requestedAt: new Date(now).toISOString(),
        expiresAt: leaseExpiresAt,
      },
    };

    // Bob cannot write to Alice's reset request slot
    await assertFails(writeResetCommandRequest(bobDb, uid, req));

    // Wrong deviceId on request:
    const wrongDeviceReq: ResetCommandRequestRecord = {
      ...req,
      command: { ...req.command, targetDeviceId: 'mac-other' },
    };
    await assertFails(writeResetCommandRequest(aliceDb, uid, wrongDeviceReq));

    // Wrong producer public key: Mac runtime rejects request
    const wrongKeyReq: ResetCommandRequestRecord = {
      ...req,
      producerPublicKey: makeKeys().publicKey,
    };
    const runtimeResult = await runResetCommandSync({
      env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1' },
      backendId,
      userId: uid,
      deviceId: 'mac-reject',
      keys: macKeys,
      readRequest: async () => wrongKeyReq,
      writeTerminalResult: async () => undefined,
    });
    expect(runtimeResult.status).toBe('command_rejected');
  });

  // 4. Expired request and expired inventory
  it('4. expired request and expired inventory: fail closed and reject stale actions', async () => {
    const macKeys = makeKeys();
    const pastTime = Date.now() - 600_000;
    const expiredReq: ResetCommandRequestRecord = {
      version: 1,
      browserId: 'browser-exp',
      producerPublicKey: macKeys.publicKey,
      leaseExpiresAt: new Date(pastTime + 60_000).toISOString(),
      command: {
        version: 1,
        commandId: 'cmd-expired',
        idempotencyKey: 'idem-expired',
        creditId: 'credit-1',
        accountId,
        targetDeviceId: 'mac-exp',
        userId: uid,
        backendId,
        requestedAt: new Date(pastTime).toISOString(),
        expiresAt: new Date(pastTime + 60_000).toISOString(),
      },
    };

    // Runtime rejects expired request
    const runtimeRes = await runResetCommandSync({
      env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1' },
      backendId,
      userId: uid,
      deviceId: 'mac-exp',
      keys: macKeys,
      readRequest: async () => expiredReq,
      writeTerminalResult: async () => undefined,
    });
    expect(runtimeRes.status).toBe('command_rejected');

    // Web client rejects expired inventory
    const webService = createResetCommandService({
      backendId,
      storage: makeStorage(),
      now: () => Date.now(),
    });
    const producerRecord: PushProducerRecord = {
      schemaVersion: 1,
      userId: uid,
      deviceId: 'mac-exp',
      publicKey: macKeys.publicKey,
      updatedAt: new Date().toISOString(),
    };
    webService.pair(uid, producerRecord);

    const expiredInventory: ResetCreditInventory = {
      version: 1,
      backendId,
      userId: uid,
      targetDeviceId: 'mac-exp',
      accountId,
      observedAt: new Date(pastTime).toISOString(),
      expiresAt: new Date(pastTime + 300_000).toISOString(),
      availableCount: 1,
      credits: [{ creditId: 'c1', expiresAt: null, status: 'available', resetType: 'codexRateLimits' }],
    };
    const signedExpiredEnvelope = await createSignedResetInventory(expiredInventory, macKeys);
    const verified = await webService.verifyInventory(uid, producerRecord, signedExpiredEnvelope);
    expect(verified.status).toBe('unavailable');
  });

  // 5. Forged same-UID result
  it('5. forged same-UID result: Web client rejects invalid signature and never renders success', async () => {
    const macKeys = makeKeys();
    const attackerKeys = makeKeys();
    const producerRecord: PushProducerRecord = {
      schemaVersion: 1,
      userId: uid,
      deviceId: 'mac-forge',
      publicKey: macKeys.publicKey,
      updatedAt: new Date().toISOString(),
    };

    const webService = createResetCommandService({
      backendId,
      storage: makeStorage(),
      now: () => Date.now(),
    });
    webService.pair(uid, producerRecord);

    const nowIso = new Date().toISOString();
    const request: ResetCommandRequestRecord = {
      version: 1,
      browserId: 'browser-forge',
      producerPublicKey: macKeys.publicKey,
      leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      command: {
        version: 1,
        commandId: 'cmd-forge',
        idempotencyKey: 'idem-forge',
        creditId: 'credit-1',
        accountId,
        targetDeviceId: 'mac-forge',
        userId: uid,
        backendId,
        requestedAt: nowIso,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    };

    const forgedTerminalResult: ResetCreditResult = {
      version: 1,
      commandId: 'cmd-forge',
      idempotencyKey: 'idem-forge',
      creditId: 'credit-1',
      accountId,
      targetDeviceId: 'mac-forge',
      userId: uid,
      backendId,
      state: 'success',
      code: 'reset',
      executedAt: nowIso,
      completedAt: nowIso,
    };

    // Signed with attackerKeys instead of macKeys
    const forgedReceipt = createSignedTerminalReceipt({
      backendId,
      userId: uid,
      targetDeviceId: 'mac-forge',
      accountId,
      commandId: 'cmd-forge',
      idempotencyKey: 'idem-forge',
      creditId: 'credit-1',
      executedAt: nowIso,
    }, forgedTerminalResult, attackerKeys);

    const receiptState = await webService.verifyReceipt(uid, producerRecord, request, forgedReceipt);
    expect(receiptState.status).toBe('unverified');
  });

  // 6. Process death/restart before and after fake provider success
  it('6. process death/restart before and after fake provider success: safe recovery without double consume', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-crash-'));
    const journal = new ResetCommandJournal({ rootDir: tempDir, backendId, accountId, userId: uid, deviceId: 'mac-crash' });
    const macKeys = makeKeys();
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const request: ResetCommandRequestRecord = {
      version: 1,
      browserId: 'browser-crash',
      producerPublicKey: macKeys.publicKey,
      leaseExpiresAt: new Date(nowMs + 600_000).toISOString(),
      command: {
        version: 1,
        commandId: 'cmd-crash-1',
        idempotencyKey: 'idem-crash-1',
        creditId: 'credit-1',
        accountId,
        targetDeviceId: 'mac-crash',
        userId: uid,
        backendId,
        requestedAt: nowIso,
        expiresAt: new Date(nowMs + 600_000).toISOString(),
      },
    };

    // Case A: Crash before provider call (simulated by executing state left unresolved in journal)
    await journal.prepareCommand(request.command);
    await journal.transitionToExecuting(request.command.commandId);
    expect(await journal.hasUnresolvedReconciliation()).toBe(true);

    // Process restarts: a brand-new Journal instance recovers persisted executing state to terminal/reconcile_required.
    const restartedJournal = new ResetCommandJournal({ rootDir: tempDir, backendId, accountId, userId: uid, deviceId: 'mac-crash' });
    expect(await restartedJournal.hasUnresolvedReconciliation()).toBe(true);
    let deletedInventory = false;
    let terminalReceiptWritten: ResetTerminalReceipt | undefined;
    const recoveryResultA = await runResetCommandSync({
      env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1' },
      backendId,
      userId: uid,
      deviceId: 'mac-crash',
      keys: macKeys,
      readRequest: async () => request,
      deleteInventory: async () => { deletedInventory = true; },
      writeTerminalResult: async (r) => { terminalReceiptWritten = r; },
      journal: restartedJournal,
    });
    expect(recoveryResultA.status).toBe('command_replayed');
    expect(deletedInventory).toBe(false);
    expect(terminalReceiptWritten?.result.state).toBe('unknown');
    expect(terminalReceiptWritten?.result.code).toBe('reconcile_required');

    // Case B: Crash after provider call succeeded (journal has terminal result, but cloud publication failed)
    const tempDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-crash-b-'));
    const journalB = new ResetCommandJournal({ rootDir: tempDirB, backendId, accountId, userId: uid, deviceId: 'mac-crash-b' });
    let providerCallsB = 0;
    const adapterB: ResetAdapterLike = {
      consumeResetCredit: async () => {
        providerCallsB++;
        return { state: 'success', code: 'reset', completedAt: new Date().toISOString() };
      },
    };

    const requestB: ResetCommandRequestRecord = {
      ...request,
      command: { ...request.command, commandId: 'cmd-crash-b', idempotencyKey: 'idem-crash-b', targetDeviceId: 'mac-crash-b' },
    };

    // First run: execute successfully, but fail terminal write to simulate crash before upload
    let firstAttemptCompleted = false;
    await runResetCommandSync({
      env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1', AI_USAGE_RESET_REAL_CONSUME_ENABLED: '1' },
      backendId,
      userId: uid,
      deviceId: 'mac-crash-b',
      keys: macKeys,
      readRequest: async () => requestB,
      writeExecutingResult: async () => undefined,
      deleteInventory: async () => undefined,
      writeTerminalResult: async () => {
        firstAttemptCompleted = true;
        throw new Error('Simulated network crash during terminal write');
      },
      journal: journalB,
      adapter: adapterB,
    });
    expect(firstAttemptCompleted).toBe(true);
    expect(providerCallsB).toBe(1);

    // Process restarts: a new Journal instance reloads the terminal outcome from disk.
    const restartedJournalB = new ResetCommandJournal({ rootDir: tempDirB, backendId, accountId, userId: uid, deviceId: 'mac-crash-b' });
    let republishedTerminal: ResetTerminalReceipt | undefined;
    const replayResult = await runResetCommandSync({
      env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1' },
      backendId,
      userId: uid,
      deviceId: 'mac-crash-b',
      keys: macKeys,
      readRequest: async () => requestB,
      writeTerminalResult: async (r) => { republishedTerminal = r; },
      journal: restartedJournalB,
      adapter: adapterB,
    });
    expect(replayResult.status).toBe('command_replayed');
    expect(providerCallsB).toBe(1); // STILL 1! No double consumption!
    expect(republishedTerminal?.result.code).toBe('reset');
  });

  // 7. Terminal replay without reconsume
  it('7. terminal replay without reconsume: idempotent replay uses existing journal result', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-replay-'));
    const journal = new ResetCommandJournal({ rootDir: tempDir, backendId, accountId, userId: uid, deviceId: 'mac-replay' });
    const macKeys = makeKeys();
    let providerCalls = 0;
    const adapter: ResetAdapterLike = {
      consumeResetCredit: async () => {
        providerCalls++;
        return { state: 'success', code: 'reset', completedAt: new Date().toISOString() };
      },
    };

    const now = Date.now();
    const req: ResetCommandRequestRecord = {
      version: 1,
      browserId: 'browser-rep',
      producerPublicKey: macKeys.publicKey,
      leaseExpiresAt: new Date(now + 300_000).toISOString(),
      command: {
        version: 1,
        commandId: 'cmd-replay-test',
        idempotencyKey: 'idem-replay-test',
        creditId: 'credit-1',
        accountId,
        targetDeviceId: 'mac-replay',
        userId: uid,
        backendId,
        requestedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 300_000).toISOString(),
      },
    };

    // First execution
    const res1 = await runResetCommandSync({
      env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1', AI_USAGE_RESET_REAL_CONSUME_ENABLED: '1' },
      backendId,
      userId: uid,
      deviceId: 'mac-replay',
      keys: macKeys,
      readRequest: async () => req,
      writeExecutingResult: async () => undefined,
      deleteInventory: async () => undefined,
      writeTerminalResult: async () => undefined,
      journal,
      adapter,
    });
    expect(res1.status).toBe('command_executed');
    expect(providerCalls).toBe(1);

    // Second execution (replay)
    const res2 = await runResetCommandSync({
      env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1' },
      backendId,
      userId: uid,
      deviceId: 'mac-replay',
      keys: macKeys,
      readRequest: async () => req,
      writeTerminalResult: async () => undefined,
      journal,
      adapter,
    });
    expect(res2.status).toBe('command_replayed');
    expect(providerCalls).toBe(1);
  });

  // 8. Unknown/uncertain replay
  it('8. unknown/uncertain replay: uncertain terminal outcome replayed faithfully', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-uncertain-'));
    const journal = new ResetCommandJournal({ rootDir: tempDir, backendId, accountId, userId: uid, deviceId: 'mac-unc' });
    const macKeys = makeKeys();

    const req: ResetCommandRequestRecord = {
      version: 1,
      browserId: 'browser-unc',
      producerPublicKey: macKeys.publicKey,
      leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      command: {
        version: 1,
        commandId: 'cmd-unc-test',
        idempotencyKey: 'idem-unc-test',
        creditId: 'credit-1',
        accountId,
        targetDeviceId: 'mac-unc',
        userId: uid,
        backendId,
        requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    };

    // Simulate journal already having recorded unknown/uncertain result
    await journal.prepareCommand(req.command);
    await journal.transitionToExecuting(req.command.commandId);
    await journal.transitionToTerminal(req.command.commandId, {
      version: 1,
      commandId: 'cmd-unc-test',
      idempotencyKey: 'idem-unc-test',
      creditId: 'credit-1',
      accountId,
      targetDeviceId: 'mac-unc',
      userId: uid,
      backendId,
      state: 'unknown',
      code: 'unknown_outcome',
      executedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    let publishedReceipt: ResetTerminalReceipt | undefined;
    const res = await runResetCommandSync({
      env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1' },
      backendId,
      userId: uid,
      deviceId: 'mac-unc',
      keys: macKeys,
      readRequest: async () => req,
      writeTerminalResult: async (r) => { publishedReceipt = r; },
      journal,
    });
    expect(res.status).toBe('command_replayed');
    expect(publishedReceipt?.result.state).toBe('unknown');
    expect(publishedReceipt?.result.code).toBe('unknown_outcome');
  });

  // 9. Global unresolved Journal interlock
  it('9. global unresolved Journal interlock: any unresolved entry blocks all later remote provider mutations', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-interlock-'));
    const journal = new ResetCommandJournal({ rootDir: tempDir, backendId, accountId, userId: uid, deviceId: 'mac-lock' });
    const macKeys = makeKeys();

    const oldCmd = {
      version: 1 as const,
      commandId: 'cmd-old-stuck',
      idempotencyKey: 'idem-old',
      creditId: 'credit-1',
      accountId,
      targetDeviceId: 'mac-lock',
      userId: uid,
      backendId,
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    // cmd-old is left in executing state (unresolved)
    await journal.prepareCommand(oldCmd);
    await journal.transitionToExecuting(oldCmd.commandId);
    expect(await journal.hasUnresolvedReconciliation()).toBe(true);

    let providerCalled = false;
    const newReq: ResetCommandRequestRecord = {
      version: 1,
      browserId: 'browser-lock',
      producerPublicKey: macKeys.publicKey,
      leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      command: {
        version: 1,
        commandId: 'cmd-new-blocked',
        idempotencyKey: 'idem-new',
        creditId: 'credit-2',
        accountId,
        targetDeviceId: 'mac-lock',
        userId: uid,
        backendId,
        requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    };

    const res = await runResetCommandSync({
      env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1' },
      backendId,
      userId: uid,
      deviceId: 'mac-lock',
      keys: macKeys,
      readRequest: async () => newReq,
      deleteInventory: async () => undefined,
      writeTerminalResult: async () => undefined,
      journal,
      adapter: {
        consumeResetCredit: async () => {
          providerCalled = true;
          return { state: 'terminal', code: 'reset', completedAt: new Date().toISOString() };
        },
      },
    });

    expect(res.status).toBe('command_blocked');
    expect(providerCalled).toBe(false);
  });

  // 10. Cloud slot release after result but local journal still authoritative
  it('10. cloud slot release after result but local journal still authoritative: cloud slot release does not bypass local journal', async () => {
    const aliceDb = env.authenticatedContext(uid).firestore();
    const macKeys = makeKeys();
    await seedProducer(aliceDb, 'mac-slot-rel', macKeys.publicKey);

    const now = Date.now();
    const req1: ResetCommandRequestRecord = {
      version: 1,
      browserId: 'browser-slot',
      producerPublicKey: macKeys.publicKey,
      leaseExpiresAt: new Date(now + 600_000).toISOString(),
      command: {
        version: 1,
        commandId: 'cmd-prior',
        idempotencyKey: 'idem-prior',
        creditId: 'credit-1',
        accountId,
        targetDeviceId: 'mac-slot-rel',
        userId: uid,
        backendId,
        requestedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 600_000).toISOString(),
      },
    };

    // Write request 1
    await writeResetCommandRequest(aliceDb, uid, req1);

    // Write result doc for cmd-prior
    const resultDoc: ResetTerminalReceipt = {
      version: 1,
      type: 'terminal',
      publicKey: macKeys.publicKey,
      signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      backendId,
      userId: uid,
      targetDeviceId: 'mac-slot-rel',
      accountId,
      commandId: 'cmd-prior',
      idempotencyKey: 'idem-prior',
      creditId: 'credit-1',
      executedAt: new Date(now).toISOString(),
      result: {
        version: 1,
        commandId: 'cmd-prior',
        idempotencyKey: 'idem-prior',
        creditId: 'credit-1',
        accountId,
        targetDeviceId: 'mac-slot-rel',
        userId: uid,
        backendId,
        state: 'success',
        code: 'reset',
        executedAt: new Date(now).toISOString(),
        completedAt: new Date(now).toISOString(),
      },
    };
    await setDoc(doc(aliceDb, resetResultDocPath(uid, 'mac-slot-rel', 'cmd-prior')), resultDoc);

    // In Firestore rules: slot is released because result doc exists
    const req2: ResetCommandRequestRecord = {
      ...req1,
      command: { ...req1.command, commandId: 'cmd-second', idempotencyKey: 'idem-second' },
    };
    await assertSucceeds(writeResetCommandRequest(aliceDb, uid, req2));

    // BUT: if local journal still has an unresolved prior entry, Mac runtime still rejects cmd-second!
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-slot-auth-'));
    const journal = new ResetCommandJournal({ rootDir: tempDir, backendId, accountId, userId: uid, deviceId: 'mac-slot-rel' });
    await journal.prepareCommand(req1.command);
    await journal.transitionToExecuting(req1.command.commandId); // unresolved in local journal!

    let providerCalled = false;
    const res = await runResetCommandSync({
      env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1' },
      backendId,
      userId: uid,
      deviceId: 'mac-slot-rel',
      keys: macKeys,
      readRequest: async () => req2,
      deleteInventory: async () => undefined,
      writeTerminalResult: async () => undefined,
      journal,
      adapter: {
        consumeResetCredit: async () => { providerCalled = true; return { state: 'success', code: 'reset', completedAt: new Date().toISOString() }; },
      },
    });

    expect(res.status).toBe('command_blocked');
    expect(providerCalled).toBe(false);
  });

  // 11. executing->terminal and terminal immutability
  it('11. executing->terminal and terminal immutability: rules enforce state machine and reject mutation/deletion of terminal docs', async () => {
    const aliceDb = env.authenticatedContext(uid).firestore();
    const macKeys = makeKeys();
    await seedProducer(aliceDb, 'mac-imm', macKeys.publicKey);

    const now = Date.now();
    const commandId = 'cmd-imm-1';
    const idemKey = 'idem-imm-1';
    const resultDocRef = doc(aliceDb, resetResultDocPath(uid, 'mac-imm', commandId));

    // Initial state: executing
    const executingDoc: ResetExecutingReceipt = {
      version: 1,
      type: 'executing',
      publicKey: macKeys.publicKey,
      signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      backendId,
      userId: uid,
      targetDeviceId: 'mac-imm',
      accountId,
      commandId,
      idempotencyKey: idemKey,
      creditId: 'credit-1',
      executedAt: new Date(now).toISOString(),
    };

    // Producer writes executing
    await assertSucceeds(setDoc(resultDocRef, executingDoc));

    // Overwriting executing with executing again should fail (only transition to terminal allowed)
    await assertFails(setDoc(resultDocRef, { ...executingDoc, executedAt: new Date(now + 1000).toISOString() }));

    // Transition executing -> terminal with valid signed receipt
    const terminalDoc: ResetTerminalReceipt = {
      version: 1,
      type: 'terminal',
      publicKey: macKeys.publicKey,
      signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      backendId,
      userId: uid,
      targetDeviceId: 'mac-imm',
      accountId,
      commandId,
      idempotencyKey: idemKey,
      creditId: 'credit-1',
      executedAt: new Date(now).toISOString(),
      result: {
        version: 1,
        commandId,
        idempotencyKey: idemKey,
        creditId: 'credit-1',
        accountId,
        targetDeviceId: 'mac-imm',
        userId: uid,
        backendId,
        state: 'success',
        code: 'reset',
        executedAt: new Date(now).toISOString(),
        completedAt: new Date(now + 2000).toISOString(),
      },
    };
    await assertSucceeds(setDoc(resultDocRef, terminalDoc));

    // Terminal immutability: once terminal, no update or delete allowed
    await assertFails(updateDoc(resultDocRef, { 'result.code': 'tampered' }));
    await assertFails(deleteDoc(resultDocRef));
  });

  // 12. Provider no-effect outcomes nothingToReset/noCredit/expired
  it('12. provider no-effect outcomes nothingToReset/noCredit/expired: proper terminal codes without double consume', async () => {
    const macKeys = makeKeys();

    const outcomes: Array<{ code: 'nothingToReset' | 'noCredit' | 'credit_expired'; state: 'success' | 'failed' }> = [
      { code: 'nothingToReset', state: 'success' },
      { code: 'noCredit', state: 'failed' },
      { code: 'credit_expired', state: 'failed' },
    ];

    for (const item of outcomes) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `r2-ne-${item.code}-`));
      const journal = new ResetCommandJournal({ rootDir: tempDir, backendId, accountId: `acc-${item.code}`, userId: uid, deviceId: 'mac-ne' });
      let publishedReceipt: ResetTerminalReceipt | undefined;

      const req: ResetCommandRequestRecord = {
        version: 1,
        browserId: 'browser-ne',
        producerPublicKey: macKeys.publicKey,
        leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        command: {
          version: 1,
          commandId: `cmd-${item.code}`,
          idempotencyKey: `idem-${item.code}`,
          creditId: 'credit-1',
          accountId: `acc-${item.code}`,
          targetDeviceId: 'mac-ne',
          userId: uid,
          backendId,
          requestedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
      };

      const res = await runResetCommandSync({
        env: { AI_USAGE_RESET_COMMANDS_ENABLED: '1', AI_USAGE_RESET_REAL_CONSUME_ENABLED: '1' },
        backendId,
        userId: uid,
        deviceId: 'mac-ne',
        keys: macKeys,
        readRequest: async () => req,
        writeExecutingResult: async () => undefined,
        deleteInventory: async () => undefined,
        writeTerminalResult: async (r) => { publishedReceipt = r; },
        journal,
        adapter: {
          consumeResetCredit: async () => ({
            state: item.state,
            code: item.code,
            completedAt: new Date().toISOString(),
          }),
        },
      });

      expect(res.status).toBe('command_executed');
      expect(publishedReceipt?.result.code).toBe(item.code);
      expect(publishedReceipt?.result.state).toBe(item.state);
    }
  });

  // 13. Timestamp shadow mismatch rejection
  it('13. timestamp shadow mismatch rejection: mismatched native shadows fail validation', () => {
    const now = Date.now();
    const observedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + 300_000).toISOString();

    const badInventoryData = {
      version: 1,
      type: 'inventory',
      publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjGwVQxSbMuSt6',
      signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      inventory: {
        version: 1,
        backendId,
        userId: uid,
        targetDeviceId: 'mac-shadow',
        accountId,
        observedAt,
        expiresAt,
        availableCount: 1,
        credits: [{ creditId: 'c1', expiresAt: null, status: 'available', resetType: 'codexRateLimits' }],
      },
      // Intentionally mismatched timestamp shadow (1 hour in the past)
      observedAtTimestamp: new Date(now - 3600_000),
      expiresAtTimestamp: new Date(now + 300_000),
    };

    expect(() => resetCloudInventoryEnvelope(badInventoryData, now)).toThrow();
  });

  // 14. Two-candidate inventory bound
  it('14. two-candidate inventory bound: cloud projection clamps to at most two rows, and rules enforce <= 2', async () => {
    const aliceDb = env.authenticatedContext(uid).firestore();
    const macKeys = makeKeys();
    await seedProducer(aliceDb, 'mac-bound', macKeys.publicKey);

    const now = Date.now();
    const candidateList: ResetCreditItem[] = [
      { creditId: 'c-3', expiresAt: new Date(now + 300_000).toISOString(), status: 'available', resetType: 'codexRateLimits' },
      { creditId: 'c-1', expiresAt: new Date(now + 100_000).toISOString(), status: 'available', resetType: 'codexRateLimits' },
      { creditId: 'c-2', expiresAt: new Date(now + 200_000).toISOString(), status: 'available', resetType: 'codexRateLimits' },
      { creditId: 'c-4', expiresAt: null, status: 'available', resetType: 'codexRateLimits' },
      { creditId: 'c-5', expiresAt: null, status: 'available', resetType: 'codexRateLimits' },
    ];

    const projected = projectActionableCredits(candidateList, now);
    expect(projected.length).toBe(2);
    expect(projected[0]!.creditId).toBe('c-1'); // Earliest expiry first
    expect(projected[1]!.creditId).toBe('c-2'); // Second earliest

    // Firestore rules check: 3 rows in inventory is rejected by rules
    const threeRowInventory = {
      version: 1,
      type: 'inventory',
      publicKey: macKeys.publicKey,
      signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      inventory: {
        version: 1,
        backendId,
        userId: uid,
        targetDeviceId: 'mac-bound',
        accountId,
        observedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 300_000).toISOString(),
        availableCount: 5,
        credits: [
          { creditId: 'c-1', expiresAt: null, status: 'available', resetType: 'codexRateLimits' },
          { creditId: 'c-2', expiresAt: null, status: 'available', resetType: 'codexRateLimits' },
          { creditId: 'c-3', expiresAt: null, status: 'available', resetType: 'codexRateLimits' },
        ],
      },
      observedAtTimestamp: new Date(now),
      expiresAtTimestamp: new Date(now + 300_000),
    };

    await assertFails(setDoc(doc(aliceDb, resetInventoryDocPath(uid, 'mac-bound')), threeRowInventory));
  });

  // 15. Exact no-effect setup/default-disabled path
  it('15. exact no-effect setup/default-disabled path: runs without effect when flag is disabled', async () => {
    let rateLimitsCalled = false;
    let requestRead = false;

    const res = await runResetCommandSync({
      env: {}, // AI_USAGE_RESET_COMMANDS_ENABLED is undefined
      backendId,
      userId: uid,
      deviceId: 'mac-disabled',
      keys: makeKeys(),
      readRateLimits: async () => { rateLimitsCalled = true; return { accountId: 'never-read', availableCount: 0, credits: [] }; },
      readRequest: async () => { requestRead = true; return undefined; },
    });

    expect(res.status).toBe('disabled');
    expect(rateLimitsCalled).toBe(false);
    expect(requestRead).toBe(false);
  });
});
