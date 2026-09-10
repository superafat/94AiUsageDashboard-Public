import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserNavigation } from './platform';

afterEach(() => { history.replaceState(null, '', '#/'); vi.restoreAllMocks(); });

describe('browser navigation adapter', () => {
  it('attaches global listeners only while subscribers exist and removes them on teardown', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const navigation = createBrowserNavigation();
    expect(add.mock.calls.filter(([name]) => name === 'popstate' || name === 'hashchange')).toHaveLength(0);
    const unsubscribe = navigation.subscribe(() => undefined);
    expect(add.mock.calls.filter(([name]) => name === 'popstate' || name === 'hashchange')).toHaveLength(2);
    unsubscribe();
    expect(remove.mock.calls.filter(([name]) => name === 'popstate' || name === 'hashchange')).toHaveLength(2);
  });

  it('round-trips provider navigation parameters without reading browser globals in shared UI', () => {
    const navigation = createBrowserNavigation();
    navigation.navigate({ route: 'provider', providerId: 'codex' });
    expect(navigation.current()).toEqual({ route: 'provider', providerId: 'codex' });
  });

  it('round-trips provider navigation with safely encoded deviceId across reload and bookmark', () => {
    const navigation = createBrowserNavigation();
    navigation.navigate({ route: 'provider', providerId: 'codex', deviceId: 'mac-mini/m4 work' });
    expect(window.location.hash).toBe('#/provider?providerId=codex&deviceId=mac-mini%2Fm4+work');
    expect(navigation.current()).toEqual({ route: 'provider', providerId: 'codex', deviceId: 'mac-mini/m4 work' });


    // Bookmark direct navigation
    window.location.hash = '#/provider?providerId=codex&deviceId=mac-studio%20m2';
    expect(navigation.current()).toEqual({ route: 'provider', providerId: 'codex', deviceId: 'mac-studio m2' });
  });
});
