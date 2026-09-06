import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AppClientServices } from '@94ai/client';
import type { UsageHistorySnapshot } from '@94ai/core';
import { useUsageHistory } from './useUsageHistory';

const item: UsageHistorySnapshot = {
  schemaVersion: 1, userId: 'alice', deviceId: 'device-1', providerId: 'codex',
  syncedAt: '2026-09-06T00:00:00.000Z', currency: 'USD', periods: {}, daily: [],
};

function services() {
  let value: ((items: UsageHistorySnapshot[]) => void) | undefined;
  let error: ((error: Error) => void) | undefined;
  let subscriptions = 0;
  const fake = {
    history: { subscribe: (_uid: string, onValue: typeof value, onError: typeof error) => { subscriptions += 1; value = onValue; error = onError; return () => undefined; } },
  } as unknown as AppClientServices;
  return { fake, emit: (items: UsageHistorySnapshot[]) => value?.(items), fail: (message: string) => error?.(new Error(message)), count: () => subscriptions };
}

describe('useUsageHistory', () => {
  it('does not subscribe signed out and preserves last-good history after an error', () => {
    const ctx = services();
    const { result, rerender } = renderHook(({ uid }) => useUsageHistory(ctx.fake, uid), { initialProps: { uid: null as string | null } });
    expect(ctx.count()).toBe(0);
    rerender({ uid: 'alice' });
    expect(ctx.count()).toBe(1);
    act(() => ctx.emit([item]));
    expect(result.current).toMatchObject({ status: 'ready', items: [item] });
    act(() => ctx.fail('offline'));
    expect(result.current).toMatchObject({ status: 'error', items: [item], message: 'offline' });
  });
});
