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
