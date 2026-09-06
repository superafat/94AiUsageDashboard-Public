import { describe, expect, it } from 'vitest';
import { parseDeviceHealthSnapshot } from './device-health';

const health = {
  schemaVersion: 1,
  userId: 'alice',
  deviceId: 'device-1',
  updatedAt: '2026-09-06T10:00:00.000Z',
  engine: 'ready',
  background: 'ready',
  sync: 'ready',
  providerReadyCount: 3,
  providerWarningCount: 1,
};

describe('device health snapshot', () => {
  it('accepts only minimal readiness and count fields', () => {
    expect(parseDeviceHealthSnapshot(health)).toEqual(health);
  });

  it('accepts an optional safe agent version', () => {
    expect(parseDeviceHealthSnapshot({ ...health, agentVersion: '0.1.0' })).toMatchObject({ agentVersion: '0.1.0' });
  });

  for (const secret of ['token', 'path', 'stderr', 'accessToken', 'rawError']) {
    it(`rejects secret or diagnostic field ${secret}`, () => {
      expect(() => parseDeviceHealthSnapshot({ ...health, [secret]: 'private' })).toThrow(/unknown field/i);
    });
  }

  it('rejects invalid states and negative provider counts', () => {
    expect(() => parseDeviceHealthSnapshot({ ...health, engine: 'running' })).toThrow(/engine/i);
    expect(() => parseDeviceHealthSnapshot({ ...health, providerReadyCount: -1 })).toThrow(/providerReadyCount/i);
  });
});
