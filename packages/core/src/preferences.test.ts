import { describe, expect, it } from 'vitest';
import {
  KNOWN_PROVIDER_FAMILIES,
  PROVIDER_CATALOG,
  isKnownProviderFamily,
  parseProviderPreference,
  providerFamilyOf,
  resolveFamilyEnabled,
  type ProviderPreference,
} from './preferences';

describe('Provider catalog and family resolution', () => {
  it('defines exactly the 11 verified OpenUsage families in stable order', () => {
    expect(KNOWN_PROVIDER_FAMILIES).toEqual([
      'codex',
      'antigravity',
      'claude',
      'copilot',
      'cursor',
      'devin',
      'grok',
      'ollama',
      'opencode',
      'openrouter',
      'zai',
    ]);
    expect(PROVIDER_CATALOG).toHaveLength(11);
    expect(PROVIDER_CATALOG.map((c) => c.family)).toEqual([...KNOWN_PROVIDER_FAMILIES]);
  });

  it('sets current-three default enabled and remaining eight default disabled', () => {
    const defaults = Object.fromEntries(PROVIDER_CATALOG.map((c) => [c.family, c.defaultEnabled]));
    expect(defaults).toEqual({
      codex: true,
      antigravity: true,
      claude: true,
      copilot: false,
      cursor: false,
      devin: false,
      grok: false,
      ollama: false,
      opencode: false,
      openrouter: false,
      zai: false,
    });
  });

  it('resolves account-scoped and device-scoped provider IDs to correct families', () => {
    expect(providerFamilyOf('codex')).toBe('codex');
    expect(providerFamilyOf('codex@work')).toBe('codex');
    expect(providerFamilyOf('antigravity@team-alpha')).toBe('antigravity');
    expect(providerFamilyOf('claude@user-1')).toBe('claude');
    expect(providerFamilyOf('copilot@github')).toBe('copilot');
    expect(providerFamilyOf('cursor@enterprise')).toBe('cursor');
    expect(providerFamilyOf('devin@sandbox')).toBe('devin');
    expect(providerFamilyOf('grok@xai')).toBe('grok');
    expect(providerFamilyOf('ollama@local')).toBe('ollama');
    expect(providerFamilyOf('opencode@team')).toBe('opencode');
    expect(providerFamilyOf('openrouter@shared')).toBe('openrouter');
    expect(providerFamilyOf('zai@test')).toBe('zai');
  });

  it('safely classifies unknown families without command execution or code evaluation', () => {
    expect(providerFamilyOf('unknown-ai')).toBe('unknown-ai');
    expect(providerFamilyOf('something$(whoami)')).toBe('something$(whoami)');
    expect(isKnownProviderFamily('unknown-ai')).toBe(false);
    expect(isKnownProviderFamily('codex')).toBe(true);
  });

  it('resolves enabled state using preferences with fallback to defaults when empty', () => {
    // Empty preferences fallback
    expect(resolveFamilyEnabled('codex', {})).toBe(true);
    expect(resolveFamilyEnabled('claude', {})).toBe(true);
    expect(resolveFamilyEnabled('cursor', {})).toBe(false);
    expect(resolveFamilyEnabled('unknown-ai', {})).toBe(false);

    // Explicit preference overrides
    const prefs: Record<string, boolean> = {
      codex: false,
      cursor: true,
    };
    expect(resolveFamilyEnabled('codex', prefs)).toBe(false);
    expect(resolveFamilyEnabled('claude', prefs)).toBe(true);
    expect(resolveFamilyEnabled('cursor', prefs)).toBe(true);
  });
});

describe('Provider preference schema validation', () => {
  const validPref: ProviderPreference = {
    schemaVersion: 1,
    userId: 'user-123',
    family: 'cursor',
    enabled: true,
    updatedAt: '2026-09-10T10:00:00.000Z',
  };

  it('parses valid minimal preference document', () => {
    const result = parseProviderPreference(validPref);
    expect(result).toEqual(validPref);
  });

  it('parses preference with reserved notification fields', () => {
    const withNotifications = {
      ...validPref,
      notifications: {
        lowQuota: false,
        reset: false,
      },
    };
    const result = parseProviderPreference(withNotifications);
    expect(result.notifications).toEqual({ lowQuota: false, reset: false });
  });

  it('rejects unknown unexpected fields at storage boundary', () => {
    expect(() => parseProviderPreference({ ...validPref, extraField: 'dangerous' })).toThrow(/unknown/);
  });

  it('rejects non-boolean enabled', () => {
    expect(() => parseProviderPreference({ ...validPref, enabled: 'true' })).toThrow(/boolean/);
    expect(() => parseProviderPreference({ ...validPref, enabled: 1 })).toThrow(/boolean/);
  });

  it('rejects invalid schemaVersion or missing required fields', () => {
    expect(() => parseProviderPreference({ ...validPref, schemaVersion: 2 })).toThrow();
    expect(() => parseProviderPreference({ ...validPref, userId: '' })).toThrow();
    expect(() => parseProviderPreference({ ...validPref, family: '' })).toThrow();
    expect(() => parseProviderPreference({ ...validPref, updatedAt: 'not-a-date' })).toThrow();
  });

  it('rejects prototype properties and unknown upstream families in resolveFamilyEnabled', () => {
    expect(resolveFamilyEnabled('constructor', {})).toBe(false);
    expect(resolveFamilyEnabled('toString', {})).toBe(false);
    expect(resolveFamilyEnabled('valueOf', {})).toBe(false);
    expect(resolveFamilyEnabled('prototype', {})).toBe(false);
    expect(resolveFamilyEnabled('__proto__', {})).toBe(false);
    expect(resolveFamilyEnabled('unknown-upstream', {})).toBe(false);
  });

  it('rejects unknown family in parseProviderPreference (strict 11 known families only)', () => {
    expect(() => parseProviderPreference({ ...validPref, family: 'unknown-ai' })).toThrow(/known provider family/);
    expect(() => parseProviderPreference({ ...validPref, family: 'constructor' })).toThrow(/known provider family/);
  });

  it('rejects unbounded or invalid userId and non-ISO timestamps in parseProviderPreference', () => {
    const oversizedUid = 'u'.repeat(129);
    expect(() => parseProviderPreference({ ...validPref, userId: oversizedUid })).toThrow();
    expect(() => parseProviderPreference({ ...validPref, updatedAt: '2026-02-30T10:00:00.000Z' })).toThrow();
  });
});
