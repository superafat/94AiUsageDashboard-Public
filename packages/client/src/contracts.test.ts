import { describe, expect, it } from 'vitest';
import type { AppClientServices, AppLocation, BackendProfile } from './contracts';

describe('app-ready client contracts', () => {
  it('models self-hosted and future official backends without Firebase types', () => {
    const profiles: BackendProfile[] = [
      { mode: 'self-hosted', label: 'My Firebase' },
      { mode: 'official-app', label: 'Official App' },
    ];
    expect(profiles.map((item) => item.mode)).toEqual(['self-hosted', 'official-app']);
    const compileOnly = (services: AppClientServices) => services.backendProfile.mode;
    expect(typeof compileOnly).toBe('function');
    const location: AppLocation = { route: 'provider', providerId: 'codex' };
    expect(location.providerId).toBe('codex');
  });
});
