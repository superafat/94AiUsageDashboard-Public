import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AppClientServices } from '@94ai/client';
import type { ProviderPreference } from '@94ai/core';
import { useProviderPreferences } from './useProviderPreferences';

function mockServices(overrides: Partial<AppClientServices> = {}): AppClientServices {
  return {
    backendProfile: { mode: 'self-hosted', label: 'Self-hosted' },
    auth: { observe: () => () => undefined, signIn: async () => undefined, signOut: async () => undefined },
    usage: { subscribe: () => () => undefined },
    history: { subscribe: () => () => undefined },
    connectivity: { current: () => 'online', subscribe: () => () => undefined },
    clock: { now: () => Date.now(), every: () => () => undefined },
    navigation: { current: () => ({ route: 'settings' }), navigate: () => undefined, subscribe: () => () => undefined },
    ...overrides,
  };
}

describe('useProviderPreferences hook', () => {
  it('defaults current 3 to enabled and added providers to disabled when empty', () => {
    const services = mockServices();
    const { result } = renderHook(() => useProviderPreferences(services, null));

    expect(result.current.isFamilyEnabled('codex')).toBe(true);
    expect(result.current.isFamilyEnabled('antigravity')).toBe(true);
    expect(result.current.isFamilyEnabled('claude')).toBe(true);
    expect(result.current.isFamilyEnabled('cursor')).toBe(false);
    expect(result.current.isFamilyEnabled('copilot')).toBe(false);
    expect(result.current.isFamilyEnabled('openrouter')).toBe(false);
  });

  it('subscribes to authenticated preferences and reflects saved choices', () => {
    let subscriber: ((prefs: ProviderPreference[]) => void) | undefined;
    const services = mockServices({
      preferences: {
        subscribe: (uid, onValue) => {
          subscriber = onValue;
          return () => { subscriber = undefined; };
        },
        setPreference: async () => undefined,
      },
    });

    const { result } = renderHook(() => useProviderPreferences(services, 'alice'));
    expect(subscriber).toBeDefined();

    act(() => {
      subscriber!([
        { schemaVersion: 1, userId: 'alice', family: 'codex', enabled: false, updatedAt: '2026-09-10T10:00:00Z' },
        { schemaVersion: 1, userId: 'alice', family: 'cursor', enabled: true, updatedAt: '2026-09-10T10:00:00Z' },
      ]);
    });

    expect(result.current.isFamilyEnabled('codex')).toBe(false);
    expect(result.current.isFamilyEnabled('cursor')).toBe(true);
    expect(result.current.isFamilyEnabled('antigravity')).toBe(true); // default remained
  });

  it('clears previous preferences and ignores late callbacks after account switch', () => {
    let aliceCallback: ((prefs: ProviderPreference[]) => void) | undefined;
    let bobCallback: ((prefs: ProviderPreference[]) => void) | undefined;
    const unsubAlice = vi.fn();
    const unsubBob = vi.fn();

    const services = mockServices({
      preferences: {
        subscribe: (uid, onValue) => {
          if (uid === 'alice') {
            aliceCallback = onValue;
            return unsubAlice;
          }
          bobCallback = onValue;
          return unsubBob;
        },
        setPreference: async () => undefined,
      },
    });

    let currentUid: string | null = 'alice';
    const { result, rerender } = renderHook(() => useProviderPreferences(services, currentUid));

    act(() => {
      aliceCallback!([
        { schemaVersion: 1, userId: 'alice', family: 'cursor', enabled: true, updatedAt: '2026-09-10T10:00:00Z' },
      ]);
    });
    expect(result.current.isFamilyEnabled('cursor')).toBe(true);

    // Switch account to Bob
    currentUid = 'bob';
    rerender();
    expect(unsubAlice).toHaveBeenCalled();
    // Bob has not received preferences yet, so cursor should be default (false)
    // Late callback from Alice must be ignored
    act(() => {
      aliceCallback!([
        { schemaVersion: 1, userId: 'alice', family: 'cursor', enabled: true, updatedAt: '2026-09-10T10:00:00Z' },
      ]);
    });
    expect(result.current.isFamilyEnabled('cursor')).toBe(false);

    // Bob callback takes effect for Bob
    act(() => {
      bobCallback!([
        { schemaVersion: 1, userId: 'bob', family: 'copilot', enabled: true, updatedAt: '2026-09-10T10:00:00Z' },
      ]);
    });
    expect(result.current.isFamilyEnabled('copilot')).toBe(true);
  });

  it('tracks saving state and truthful error when saving fails', async () => {
    let rejectPromise: (err: Error) => void;
    const setPreference = vi.fn(() => new Promise<void>((_, reject) => {
      rejectPromise = reject;
    }));

    const services = mockServices({
      preferences: {
        subscribe: () => () => undefined,
        setPreference,
      },
    });

    const { result } = renderHook(() => useProviderPreferences(services, 'alice'));

    let savePromise: Promise<void>;
    act(() => {
      savePromise = result.current.setFamilyEnabled('cursor', true);
    });

    // Should indicate saving is in progress
    expect(result.current.isFamilySaving('cursor')).toBe(true);

    // Fail the save
    await act(async () => {
      rejectPromise(new Error('Network error'));
      await expect(savePromise).rejects.toThrow('Network error');
    });

    expect(result.current.isFamilySaving('cursor')).toBe(false);
    expect(result.current.familyError('cursor')).toBe('Network error');
    // Enabled state should NOT be faked as true
    expect(result.current.isFamilyEnabled('cursor')).toBe(false);
  });

  it('does not default-on during initial loading or error when preferences repository is present', () => {
    let errorHandler: ((error: Error) => void) | undefined;
    const services = mockServices({
      preferences: {
        subscribe: (_uid, _onValue, onError) => {
          errorHandler = onError;
          return () => undefined;
        },
        setPreference: async () => undefined,
      },
    });

    const { result } = renderHook(() => useProviderPreferences(services, 'alice'));

    // In loading state: must NOT enable codex by default!
    expect(result.current.status).toBe('loading');
    expect(result.current.isFamilyEnabled('codex')).toBe(false);
    expect(result.current.isFamilyEnabled('claude')).toBe(false);
    expect(result.current.isFamilyEnabled('antigravity')).toBe(false);

    // In initial error state: must NOT enable codex by default!
    act(() => {
      errorHandler!(new Error('Network failure'));
    });
    expect(result.current.status).toBe('error');
    expect(result.current.isFamilyEnabled('codex')).toBe(false);
  });

  it('hides dependent source conservatively while OFF is saving, and restores valid state on failure', async () => {
    let rejectSave!: (err: Error) => void;
    let subscriber: ((prefs: ProviderPreference[]) => void) | undefined;

    const services = mockServices({
      preferences: {
        subscribe: (_uid, onValue) => {
          subscriber = onValue;
          return () => undefined;
        },
        setPreference: vi.fn(() => new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        })),
      },
    });

    const { result } = renderHook(() => useProviderPreferences(services, 'alice'));

    // Start with codex confirmed ON
    act(() => {
      subscriber!([
        { schemaVersion: 1, userId: 'alice', family: 'codex', enabled: true, updatedAt: '2026-09-10T10:00:00Z' },
      ]);
    });
    expect(result.current.isFamilyEnabled('codex')).toBe(true);

    // User toggles codex to OFF (starts saving)
    let savePromise: Promise<void>;
    act(() => {
      savePromise = result.current.setFamilyEnabled('codex', false);
    });

    // While saving to OFF: source MUST be conservatively hidden immediately!
    expect(result.current.isFamilySaving('codex')).toBe(true);
    expect(result.current.isFamilyEnabled('codex')).toBe(false);

    // Save fails: error is set and last valid state (true) is restored
    await act(async () => {
      rejectSave(new Error('Save failed'));
      await expect(savePromise).rejects.toThrow('Save failed');
    });

    expect(result.current.isFamilySaving('codex')).toBe(false);
    expect(result.current.familyError('codex')).toBe('Save failed');
    expect(result.current.isFamilyEnabled('codex')).toBe(true);
  });

  it('isolates pending saves across account changes including A -> B -> A', async () => {
    let resolveAliceSave!: () => void;
    const services = mockServices({
      preferences: {
        subscribe: () => () => undefined,
        setPreference: vi.fn(() => new Promise<void>((resolve) => {
          resolveAliceSave = resolve;
        })),
      },
    });

    let currentUid: string | null = 'alice';
    const { result, rerender } = renderHook(() => useProviderPreferences(services, currentUid));

    // Alice starts a save
    let aliceSavePromise: Promise<void>;
    act(() => {
      aliceSavePromise = result.current.setFamilyEnabled('cursor', true);
    });
    expect(result.current.isFamilySaving('cursor')).toBe(true);

    // Switch to Bob
    currentUid = 'bob';
    rerender();
    expect(result.current.isFamilySaving('cursor')).toBe(false);

    // Switch back to Alice (new generation)
    currentUid = 'alice';
    rerender();
    expect(result.current.isFamilySaving('cursor')).toBe(false);

    // Now resolve the old save from the first Alice generation
    await act(async () => {
      resolveAliceSave();
      await aliceSavePromise;
    });

    // Old save must not pollute the new Alice generation
    expect(result.current.isFamilySaving('cursor')).toBe(false);
  });

  it('clicking after offline cannot report saved and records clear error', async () => {
    const setPreference = vi.fn();
    const services = mockServices({
      connectivity: { current: () => 'offline', subscribe: () => () => undefined },
      preferences: {
        subscribe: () => () => undefined,
        setPreference,
      },
    });

    const { result } = renderHook(() => useProviderPreferences(services, 'alice'));

    await act(async () => {
      await expect(result.current.setFamilyEnabled('cursor', true)).rejects.toThrow('網路離線，無法儲存設定');
    });
    expect(setPreference).not.toHaveBeenCalled();
    expect(result.current.isFamilySaving('cursor')).toBe(false);
    expect(result.current.familyError('cursor')).toBe('網路離線，無法儲存設定');
    expect(result.current.isFamilyEnabled('cursor')).toBe(false);
  });

  it('suppresses delayed callbacks from a previous backend switch', () => {
    let backendACallback: ((prefs: ProviderPreference[]) => void) | undefined;
    const servicesA = mockServices({
      backendProfile: { mode: 'self-hosted', label: 'Backend A' },
      preferences: {
        subscribe: (_uid, onValue) => {
          backendACallback = onValue;
          return () => undefined;
        },
        setPreference: async () => undefined,
      },
    });

    let backendBCallback: ((prefs: ProviderPreference[]) => void) | undefined;
    const servicesB = mockServices({
      backendProfile: { mode: 'self-hosted', label: 'Backend B' },
      preferences: {
        subscribe: (_uid, onValue) => {
          backendBCallback = onValue;
          return () => undefined;
        },
        setPreference: async () => undefined,
      },
    });

    let activeServices = servicesA;
    const { result, rerender } = renderHook(() => useProviderPreferences(activeServices, 'alice'));

    // Switch to Backend B
    activeServices = servicesB;
    rerender();

    // Delayed callback from Backend A arrives now
    act(() => {
      backendACallback!([
        { schemaVersion: 1, userId: 'alice', family: 'cursor', enabled: true, updatedAt: '2026-09-10T10:00:00Z' },
      ]);
    });

    // Cursor must NOT be enabled in Backend B from Backend A's delayed callback
    expect(result.current.isFamilyEnabled('cursor')).toBe(false);

    // Backend B callback arrives
    act(() => {
      backendBCallback!([
        { schemaVersion: 1, userId: 'alice', family: 'copilot', enabled: true, updatedAt: '2026-09-10T10:00:00Z' },
      ]);
    });
    expect(result.current.isFamilyEnabled('copilot')).toBe(true);
    expect(result.current.isFamilyEnabled('cursor')).toBe(false);
  });
});
