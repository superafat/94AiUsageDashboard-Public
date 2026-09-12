import { describe, expect, it } from 'vitest';
import type { AppClientServices } from '@94ai/client';
import { createWebClientServices } from './services';

function fakeDependencies(): Omit<AppClientServices, 'backendProfile'> {
  return {
    auth: { observe: () => () => undefined, signIn: async () => undefined, signOut: async () => undefined },
    usage: { subscribe: () => () => undefined },
    history: { subscribe: () => () => undefined },
    connectivity: { current: () => 'online', subscribe: () => () => undefined },
    clock: { now: () => 123, every: () => () => undefined },
    navigation: { current: () => ({ route: 'dashboard' }), navigate: () => undefined, subscribe: () => () => undefined },
  };
}

describe('Web client adapter', () => {
  it('composes shared services with a self-hosted backend profile', () => {
    const services = createWebClientServices(fakeDependencies());
    expect(services.backendProfile).toEqual({ mode: 'self-hosted', label: 'Self-hosted Firebase' });
    expect(services.connectivity.current()).toBe('online');
    expect(services.clock.now()).toBe(123);
    expect(typeof services.navigation.navigate).toBe('function');
  });
});

describe('e2e-fixtures history generation', () => {
  it('derives 31-day period token values from generated rows', async () => {
    const { histories } = await import('./e2e-fixtures');
    const list = histories(false);
    const codex = list.find((h) => h.providerId === 'codex')!;
    const ag = list.find((h) => h.providerId === 'antigravity')!;

    expect(codex.daily).toHaveLength(31);
    expect(codex.periods.today?.tokens).toBe(31_000_000);
    expect(codex.periods.yesterday?.tokens).toBe(30_000_000);
    expect(codex.periods.last30Days?.tokens).toBe(495_000_000);

    expect(ag.daily).toHaveLength(31);
    expect(ag.periods.today?.tokens).toBe(15_500_000);
    expect(ag.periods.yesterday?.tokens).toBe(15_000_000);
    expect(ag.periods.last30Days?.tokens).toBe(247_500_000);
  });

  it('derives dense180 period token values from generated rows instead of fixed 31-day constants', async () => {
    const { histories } = await import('./e2e-fixtures');
    const list = histories(true);
    const codex = list.find((h) => h.providerId === 'codex')!;
    const ag = list.find((h) => h.providerId === 'antigravity')!;

    expect(codex.daily).toHaveLength(180);
    // Derived from 180 rows, not fixed 31M/30M/495M
    expect(codex.periods.today?.tokens).toBe(180_000_000);
    expect(codex.periods.yesterday?.tokens).toBe(179_000_000);
    expect(codex.periods.last30Days?.tokens).toBe(4_965_000_000);

    expect(ag.daily).toHaveLength(180);
    // Derived from 180 rows, not fixed 15.5M/15M/247.5M
    expect(ag.periods.today?.tokens).toBe(90_000_000);
    expect(ag.periods.yesterday?.tokens).toBe(89_500_000);
    expect(ag.periods.last30Days?.tokens).toBe(2_482_500_000);

    // Keep existing intentional cost-incomplete behavior
    expect(ag.periods.yesterday?.estimatedCostUsd).toBeUndefined();
    expect(ag.daily.every((d) => d.estimatedCostUsd === undefined)).toBe(true);
  });
});
