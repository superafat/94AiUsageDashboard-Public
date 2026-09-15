import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ResetCommandRequestRecord, ResetInventoryEnvelope, PushProducerRecord, UsageSnapshot } from '@94ai/core';
import type { ResetCommandService, ResetPairingPin, ResetVerifiedInventory } from '@94ai/client';
import { ResetCreditsScreen } from './ResetCreditsScreen';

const now = new Date('2026-09-13T00:00:00.000Z');
const producer: PushProducerRecord = {
  schemaVersion: 1, userId: 'alice', deviceId: 'mac-1',
  publicKey: 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  updatedAt: now.toISOString(),
};
const pin: ResetPairingPin = { backendId: 'demo-backend', userId: 'alice', deviceId: 'mac-1', publicKey: producer.publicKey, browserId: 'browser-1' };
const envelope: ResetInventoryEnvelope = {
  version: 1, type: 'inventory', publicKey: producer.publicKey,
  signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  inventory: {
    version: 1, backendId: 'demo-backend', userId: 'alice', targetDeviceId: 'mac-1', accountId: 'acct-1',
    observedAt: '2026-09-12T23:59:30.000Z', expiresAt: '2026-09-13T00:04:00.000Z', availableCount: 1,
    credits: [{ creditId: 'credit-1', expiresAt: '2026-09-20T00:00:00.000Z', status: 'available', resetType: 'codexRateLimits' }],
  },
};
const ready: ResetVerifiedInventory = { status: 'ready', pin, producer, envelope, credit: envelope.inventory.credits![0]! };
const request: ResetCommandRequestRecord = {
  version: 1, browserId: 'browser-1', producerPublicKey: producer.publicKey, leaseExpiresAt: '2026-09-13T00:08:00.000Z',
  command: { version: 1, commandId: 'cmd-1', idempotencyKey: 'idem-1', creditId: 'credit-1', accountId: 'acct-1', targetDeviceId: 'mac-1', userId: 'alice', backendId: 'demo-backend', requestedAt: now.toISOString(), expiresAt: '2026-09-13T00:08:00.000Z' },
};
const usage: UsageSnapshot = {
  schemaVersion: 1, userId: 'alice', deviceId: 'mac-1', providerId: 'codex', fetchedAt: now.toISOString(), syncedAt: now.toISOString(), expiresAt: '2026-09-13T00:05:00.000Z', stale: false,
  resources: { rateLimitResets: { kind: 'balance', unit: 'resets', available: 1, expiries: ['2026-09-20T00:00:00.000Z'] } },
};

function service(overrides: Partial<ResetCommandService> = {}): ResetCommandService {
  return {
    subscribeProducers: (_uid, onValue) => { onValue([producer]); return () => undefined; },
    getPairing: () => pin,
    pair: () => pin,
    verifyInventory: async () => ready,
    subscribeInventory: (_uid, _producer, onValue) => { onValue(ready); return () => undefined; },
    dispatch: async () => request,
    verifyReceipt: async () => ({ status: 'waiting', request }),
    watchResult: (_uid, _producer, req, onValue) => { onValue({ status: 'waiting', request: req }); return () => undefined; },
    ...overrides,
  };
}

describe('ResetCreditsScreen R2 command lane', () => {
  it('shows explicit second confirmation with device/account/expiry and dispatches exactly once', async () => {
    const dispatch = vi.fn(async () => request);
    render(<ResetCreditsScreen items={[usage]} now={now} userId="alice" resetCommands={service({ dispatch })} />);
    expect(await screen.findByRole('button', { name: '使用 1 張重置券' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '使用 1 張重置券' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('mac-1');
    expect(screen.getByRole('dialog')).toHaveTextContent('acct-1');
    expect(screen.getByRole('dialog')).toHaveTextContent('2026-09-20T00:00:00.000Z');
    expect(screen.getByRole('dialog')).toHaveTextContent('只會使用 1 張重置券');
    const confirm = screen.getByRole('button', { name: '確認使用 1 張重置券' });
    fireEvent.click(confirm); fireEvent.click(confirm);
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('等待 Mac')).toBeInTheDocument();
  });

  it('requires explicit pairing and key mismatch never exposes the reset action', async () => {
    const pair = vi.fn(() => pin);
    const unpaired = service({ getPairing: () => null, pair, subscribeInventory: (_u, _p, onValue) => { onValue({ status: 'unpaired' }); return () => undefined; } });
    const { rerender } = render(<ResetCreditsScreen items={[usage]} now={now} userId="alice" resetCommands={unpaired} />);
    fireEvent.click(await screen.findByRole('button', { name: /配對這台 Mac/ }));
    expect(pair).toHaveBeenCalledTimes(1);

    const mismatch = service({ subscribeInventory: (_u, _p, onValue) => { onValue({ status: 'key_mismatch' }); return () => undefined; } });
    rerender(<ResetCreditsScreen items={[usage]} now={now} userId="alice" resetCommands={mismatch} />);
    expect(await screen.findByText('無法驗證 Mac 回報')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '使用 1 張重置券' })).not.toBeInTheDocument();
  });

  it('isolates progress and result watchers per Mac when switching devices', async () => {
    const producer2: PushProducerRecord = { ...producer, deviceId: 'mac-2' };
    const pin2: ResetPairingPin = { ...pin, deviceId: 'mac-2' };
    const envelope2: ResetInventoryEnvelope = {
      ...envelope,
      inventory: { ...envelope.inventory, targetDeviceId: 'mac-2', accountId: 'acct-2' },
    };
    const ready2: ResetVerifiedInventory = {
      status: 'ready', pin: pin2, producer: producer2, envelope: envelope2, credit: envelope2.inventory.credits![0]!,
    };
    const request2: ResetCommandRequestRecord = {
      ...request,
      browserId: pin2.browserId,
      command: { ...request.command, commandId: 'cmd-2', idempotencyKey: 'idem-2', targetDeviceId: 'mac-2', accountId: 'acct-2' },
    };
    const stop1 = vi.fn();
    const stop2 = vi.fn();
    const multi = service({
      subscribeProducers: (_uid, onValue) => { onValue([producer, producer2]); return () => undefined; },
      getPairing: (_uid, deviceId) => deviceId === 'mac-1' ? pin : pin2,
      subscribeInventory: (_uid, nextProducer, onValue) => {
        onValue(nextProducer.deviceId === 'mac-1' ? ready : ready2);
        return () => undefined;
      },
      dispatch: async (value) => value.status === 'ready' && value.pin.deviceId === 'mac-2' ? request2 : request,
      watchResult: (_uid, nextProducer, req, onValue) => {
        onValue({ status: 'waiting', request: req });
        return nextProducer.deviceId === 'mac-1' ? stop1 : stop2;
      },
    });

    render(<ResetCreditsScreen items={[usage]} now={now} userId="alice" resetCommands={multi} />);
    fireEvent.click(await screen.findByRole('button', { name: '使用 1 張重置券' }));
    fireEvent.click(screen.getByRole('button', { name: '確認使用 1 張重置券' }));
    expect(await screen.findByText('等待 Mac')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: '選擇 Mac' }), { target: { value: 'mac-2' } });
    await waitFor(() => expect(screen.queryByText('等待 Mac')).not.toBeInTheDocument());
    expect(stop1).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: '使用 1 張重置券' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: '使用 1 張重置券' }));
    fireEvent.click(screen.getByRole('button', { name: '確認使用 1 張重置券' }));
    expect(await screen.findByText('等待 Mac')).toBeInTheDocument();
    expect(stop1).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('combobox', { name: '選擇 Mac' }), { target: { value: 'mac-1' } });
    expect(await screen.findByText('等待 Mac')).toBeInTheDocument();
    expect(stop1).not.toHaveBeenCalled();
    expect(stop2).not.toHaveBeenCalled();
  });


  it('never leaves Mac A actionable inventory visible while switching to Mac B before B inventory arrives', async () => {
    const producer2: PushProducerRecord = { ...producer, deviceId: 'mac-2' };
    const pin2: ResetPairingPin = { ...pin, deviceId: 'mac-2' };
    const multi = service({
      subscribeProducers: (_uid, onValue) => { onValue([producer, producer2]); return () => undefined; },
      getPairing: (_uid, deviceId) => deviceId === 'mac-1' ? pin : pin2,
      subscribeInventory: (_uid, nextProducer, onValue) => {
        if (nextProducer.deviceId === 'mac-1') onValue(ready);
        return () => undefined;
      },
    });
    render(<ResetCreditsScreen items={[usage]} now={now} userId="alice" resetCommands={multi} />);
    expect(await screen.findByRole('button', { name: '使用 1 張重置券' })).toBeEnabled();
    fireEvent.change(screen.getByRole('combobox', { name: '選擇 Mac' }), { target: { value: 'mac-2' } });
    expect(screen.queryByRole('button', { name: '使用 1 張重置券' })).not.toBeInTheDocument();
    expect(screen.queryByText('acct-1')).not.toBeInTheDocument();
    expect(screen.getByText('等待 Mac 更新可用重置券')).toBeInTheDocument();
  });

  it('invalidates an open confirmation when the signed inventory changes before confirm', async () => {
    let inventoryCallback: ((value: ResetVerifiedInventory) => void) | undefined;
    const dispatch = vi.fn(async () => request);
    const drifting = service({
      subscribeInventory: (_uid, _producer, onValue) => {
        inventoryCallback = onValue;
        onValue(ready);
        return () => undefined;
      },
      dispatch,
    });
    render(<ResetCreditsScreen items={[usage]} now={now} userId="alice" resetCommands={drifting} />);
    fireEvent.click(await screen.findByRole('button', { name: '使用 1 張重置券' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('2026-09-20T00:00:00.000Z');

    const changedEnvelope: ResetInventoryEnvelope = {
      ...envelope,
      signature: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      inventory: {
        ...envelope.inventory,
        credits: [{ creditId: 'credit-2', expiresAt: '2026-09-19T00:00:00.000Z', status: 'available', resetType: 'codexRateLimits' }],
      },
    };
    const changed: ResetVerifiedInventory = {
      status: 'ready', pin, producer, envelope: changedEnvelope, credit: changedEnvelope.inventory.credits![0]!,
    };
    inventoryCallback?.(changed);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(dispatch).not.toHaveBeenCalled();
    expect(screen.getByText(/資料已更新|重新確認/)).toBeInTheDocument();
  });


  it('explains the R3 safety gate in plain Traditional Chinese without implying a failed voucher charge', async () => {
    const terminalReceipt = {
      version: 1 as const,
      type: 'terminal' as const,
      publicKey: producer.publicKey,
      signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      backendId: request.command.backendId,
      userId: request.command.userId,
      targetDeviceId: request.command.targetDeviceId,
      accountId: request.command.accountId,
      commandId: request.command.commandId,
      idempotencyKey: request.command.idempotencyKey,
      creditId: request.command.creditId,
      executedAt: now.toISOString(),
      result: {
        version: 1 as const,
        commandId: request.command.commandId,
        idempotencyKey: request.command.idempotencyKey,
        creditId: request.command.creditId,
        accountId: request.command.accountId,
        targetDeviceId: request.command.targetDeviceId,
        userId: request.command.userId,
        backendId: request.command.backendId,
        state: 'failed' as const,
        code: 'r3_authorization_required' as const,
        executedAt: now.toISOString(),
        completedAt: now.toISOString(),
      },
    };
    const gated = service({
      watchResult: (_uid, _producer, req, onValue) => {
        onValue({ status: 'terminal', request: req, receipt: terminalReceipt });
        return () => undefined;
      },
    });
    render(<ResetCreditsScreen items={[usage]} now={now} userId="alice" resetCommands={gated} />);
    fireEvent.click(await screen.findByRole('button', { name: '使用 1 張重置券' }));
    fireEvent.click(screen.getByRole('button', { name: '確認使用 1 張重置券' }));
    expect(await screen.findByText('安全連線已驗證，尚未開放實際使用重置券')).toBeInTheDocument();
    expect(screen.queryByText('重置券未使用成功')).not.toBeInTheDocument();
  });

  it('uses Traditional Chinese plain-language labels instead of mixed English control headings', async () => {
    render(<ResetCreditsScreen items={[usage]} now={now} userId="alice" resetCommands={service()} />);
    expect(await screen.findByText('可用重置券')).toBeInTheDocument();
    expect(screen.getByText('已配對的 Mac')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '使用 1 張重置券' })).toBeEnabled();
    expect(screen.queryByText(/READ-ONLY|Read-only|PAIRED MAC|Paired Mac|Reset Credits?/i)).not.toBeInTheDocument();
  });

  it('moves off a stale mismatched pairing and selects the newest producer for explicit re-pairing', async () => {
    const oldProducer: PushProducerRecord = { ...producer, deviceId: 'mac-old', publicKey: 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', updatedAt: '2026-09-12T00:00:00.000Z' };
    const newestProducer: PushProducerRecord = { ...producer, deviceId: 'mac-new', publicKey: 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB', updatedAt: '2026-09-13T00:00:00.000Z' };
    const stalePin: ResetPairingPin = { ...pin, deviceId: 'mac-old', publicKey: 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC' };
    const rotating = service({
      subscribeProducers: (_uid, onValue) => { onValue([oldProducer, newestProducer]); return () => undefined; },
      getPairing: (_uid, deviceId) => deviceId === 'mac-old' ? stalePin : null,
      subscribeInventory: (_uid, _producer, onValue) => { onValue({ status: 'unpaired' }); return () => undefined; },
    });
    render(<ResetCreditsScreen items={[usage]} now={now} userId="alice" resetCommands={rotating} />);
    await screen.findByRole('button', { name: '配對這台 Mac' });
    expect(screen.getByRole('combobox', { name: '選擇 Mac' })).toHaveValue('mac-new');
    expect(screen.getByRole('button', { name: '配對這台 Mac' })).toBeEnabled();
  });

});
