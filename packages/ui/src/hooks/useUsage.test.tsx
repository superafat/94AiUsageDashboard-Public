import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AppClientServices } from '@94ai/client';
import type { UsageSnapshot } from '@94ai/core';
import { useUsage } from './useUsage';

const aliceItem: UsageSnapshot = {
  schemaVersion: 1,
  userId: 'alice',
  deviceId: 'device-1',
  providerId: 'codex',
  fetchedAt: '2026-09-07T00:00:00.000Z',
  syncedAt: '2026-09-07T00:00:05.000Z',
  expiresAt: '2026-09-07T00:05:00.000Z',
  stale: false,
  resources: {},
};

const bobItem: UsageSnapshot = {
  ...aliceItem,
  userId: 'bob',
};

function createMockServices() {
  const callbacks = new Map<string, { onValue: (items: UsageSnapshot[]) => void; onError: (error: Error) => void }>();
  let activeSubscriptions = 0;

  const fake = {
    backendProfile: { mode: 'self-hosted', label: 'Backend-1' },
    usage: {
      subscribe: (uid: string, onValue: (items: UsageSnapshot[]) => void, onError: (error: Error) => void) => {
        activeSubscriptions += 1;
        callbacks.set(uid, { onValue, onError });
        return () => {
          activeSubscriptions -= 1;
          // Notice: mock does not delete from callbacks to simulate late callback delivery after unsubscribe
        };
      },
    },
  } as unknown as AppClientServices;

  return {
    services: fake,
    emit: (uid: string, items: UsageSnapshot[]) => callbacks.get(uid)?.onValue(items),
    fail: (uid: string, message: string) => callbacks.get(uid)?.onError(new Error(message)),
    subscriptionCount: () => activeSubscriptions,
  };
}

describe('useUsage account isolation and subscription lifecycle', () => {
  it('never renders previous UID data during a scope change', () => {
    const mock = createMockServices();
    const { result, rerender } = renderHook(({ uid }) => useUsage(mock.services, uid), {
      initialProps: { uid: 'alice' as string | null },
    });

    act(() => mock.emit('alice', [aliceItem]));
    expect(result.current).toMatchObject({ status: 'ready', items: [aliceItem] });

    // Switch to bob
    rerender({ uid: 'bob' });
    // Must immediately be loading with empty items, never aliceItem
    expect(result.current).toEqual({ status: 'loading', items: [] });

    act(() => mock.emit('bob', [bobItem]));
    expect(result.current).toMatchObject({ status: 'ready', items: [bobItem] });
  });

  it('drops previous UID data immediately on logout', () => {
    const mock = createMockServices();
    const { result, rerender } = renderHook(({ uid }) => useUsage(mock.services, uid), {
      initialProps: { uid: 'alice' as string | null },
    });

    act(() => mock.emit('alice', [aliceItem]));
    expect(result.current).toMatchObject({ status: 'ready', items: [aliceItem] });

    // Logout
    rerender({ uid: null });
    expect(result.current).toEqual({ status: 'idle', items: [] });
  });

  it('prevents late callbacks from inactive subscriptions from overwriting current state', () => {
    const mock = createMockServices();
    const { result, rerender } = renderHook(({ uid }) => useUsage(mock.services, uid), {
      initialProps: { uid: 'alice' as string | null },
    });

    act(() => mock.emit('alice', [aliceItem]));
    expect(result.current).toMatchObject({ status: 'ready', items: [aliceItem] });

    rerender({ uid: 'bob' });
    expect(result.current).toEqual({ status: 'loading', items: [] });

    // Late callback arrives from alice's old subscription
    act(() => mock.emit('alice', [aliceItem]));
    // Must NOT overwrite bob's loading state or inject alice's data
    expect(result.current).toEqual({ status: 'loading', items: [] });

    // Late error from alice
    act(() => mock.fail('alice', 'alice network failure'));
    expect(result.current).toEqual({ status: 'loading', items: [] });

    // Bob emits ready
    act(() => mock.emit('bob', [bobItem]));
    expect(result.current).toMatchObject({ status: 'ready', items: [bobItem] });
  });

  it('keeps last-good items only within the same active scope', () => {
    const mock = createMockServices();
    const { result, rerender } = renderHook(({ uid }) => useUsage(mock.services, uid), {
      initialProps: { uid: 'alice' as string | null },
    });

    act(() => mock.emit('alice', [aliceItem]));
    expect(result.current).toMatchObject({ status: 'ready', items: [aliceItem] });

    // Error within same active scope keeps alice's last-good
    act(() => mock.fail('alice', 'connection lost'));
    expect(result.current).toMatchObject({ status: 'error', items: [aliceItem], message: 'connection lost' });

    // Switch to bob
    rerender({ uid: 'bob' });
    expect(result.current).toEqual({ status: 'loading', items: [] });

    // Error in bob's scope before any data received must have empty items, NOT aliceItem
    act(() => mock.fail('bob', 'bob permission denied'));
    expect(result.current).toEqual({ status: 'error', items: [], message: 'bob permission denied' });
  });

  it('resets state when backend services change', () => {
    const mock1 = createMockServices();
    const mock2 = createMockServices();
    const { result, rerender } = renderHook(({ services, uid }) => useUsage(services, uid), {
      initialProps: { services: mock1.services, uid: 'alice' as string | null },
    });

    act(() => mock1.emit('alice', [aliceItem]));
    expect(result.current).toMatchObject({ status: 'ready', items: [aliceItem] });

    // Switch backend
    rerender({ services: mock2.services, uid: 'alice' });
    expect(result.current).toEqual({ status: 'loading', items: [] });

    act(() => mock2.emit('alice', [{ ...aliceItem, deviceId: 'backend-2-device' }]));
    expect(result.current).toMatchObject({ status: 'ready', items: [{ deviceId: 'backend-2-device' }] });
  });
});
