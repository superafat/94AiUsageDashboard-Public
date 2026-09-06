import { describe, expect, it } from 'vitest';
import { normalizeFirebaseAuthError } from './firebase';

describe('Firebase auth adapter', () => {
  it('maps provider-specific failures to safe platform-neutral auth errors', () => {
    const error = normalizeFirebaseAuthError({ code: 'auth/popup-blocked', message: 'private-credential-value' });
    expect(error.code).toBe('interaction-blocked');
    expect(error.message).not.toContain('private-credential-value');
    expect(error.message).not.toContain('popup-blocked');
  });
});
