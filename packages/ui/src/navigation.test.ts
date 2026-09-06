import { describe, expect, it } from 'vitest';
import { screenForRoute } from './navigation';

describe('shared product navigation', () => {
  it('selects dashboard and provider screens from platform-neutral locations', () => {
    expect(screenForRoute({ route: 'dashboard' })).toBe('dashboard');
    expect(screenForRoute({ route: 'provider', providerId: 'codex' })).toBe('provider');
    expect(screenForRoute({ route: 'help' })).toBe('help');
    expect(screenForRoute({ route: 'settings' })).toBe('settings');
    expect(screenForRoute({ route: 'getting-started' })).toBe('getting-started');
  });
});
