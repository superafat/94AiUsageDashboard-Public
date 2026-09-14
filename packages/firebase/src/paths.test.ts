import { describe, expect, it } from 'vitest';
import {
  resetRequestDocPath,
  resetInventoryDocPath,
  resetResultDocPath,
  resetResultsCollectionPath,
} from './paths';

describe('reset transport paths', () => {
  it('builds canonical resetControl request path and validates segments', () => {
    expect(resetRequestDocPath('user-1', 'mac-1')).toBe('users/user-1/devices/mac-1/resetControl/request');
    expect(() => resetRequestDocPath('user/1', 'mac-1')).toThrow(/segment/i);
    expect(() => resetRequestDocPath('user-1', 'mac/1')).toThrow(/segment/i);
    expect(() => resetRequestDocPath('', 'mac-1')).toThrow(/segment/i);
  });

  it('builds canonical resetControl inventory path and validates segments', () => {
    expect(resetInventoryDocPath('user-1', 'mac-1')).toBe('users/user-1/devices/mac-1/resetControl/inventory');
    expect(() => resetInventoryDocPath('user/1', 'mac-1')).toThrow(/segment/i);
    expect(() => resetInventoryDocPath('user-1', 'mac/1')).toThrow(/segment/i);
  });

  it('builds canonical resetResult path and validates segments', () => {
    expect(resetResultDocPath('user-1', 'mac-1', 'cmd-1')).toBe('users/user-1/devices/mac-1/resetResults/cmd-1');
    expect(() => resetResultDocPath('user/1', 'mac-1', 'cmd-1')).toThrow(/segment/i);
    expect(() => resetResultDocPath('user-1', 'mac/1', 'cmd-1')).toThrow(/segment/i);
    expect(() => resetResultDocPath('user-1', 'mac-1', 'cmd/1')).toThrow(/segment/i);
    expect(() => resetResultDocPath('user-1', 'mac-1', '')).toThrow(/segment/i);
  });

  it('builds canonical resetResults collection path and validates segments', () => {
    expect(resetResultsCollectionPath('user-1', 'mac-1')).toBe('users/user-1/devices/mac-1/resetResults');
    expect(() => resetResultsCollectionPath('user/1', 'mac-1')).toThrow(/segment/i);
    expect(() => resetResultsCollectionPath('user-1', 'mac/1')).toThrow(/segment/i);
  });
});
