import { describe, expect, it } from 'vitest';
import { parseUsageSnapshot } from './schema';

const baseSnapshot = {
  schemaVersion: 1,
  userId: 'user-1',
  deviceId: 'device-1',
  providerId: 'codex',
  plan: 'Plus',
  fetchedAt: '2026-09-05T10:00:00.000Z',
  syncedAt: '2026-09-05T10:00:05.000Z',
  expiresAt: '2026-09-05T10:05:00.000Z',
  stale: false,
  resources: {
    session: { kind: 'consumption', unit: 'percent', used: 49, limit: 100, remaining: 51 },
    rateLimitResets: { kind: 'balance', unit: 'credits', available: 3 },
  },
};

type MutableSnapshot = Omit<typeof baseSnapshot, 'resources'> & { resources: Record<string, unknown> };

function cloneForMutation(): MutableSnapshot {
  return structuredClone(baseSnapshot) as unknown as MutableSnapshot;
}

describe('parseUsageSnapshot', () => {
  it('accepts canonical consumption and balance resources', () => {
    expect(parseUsageSnapshot(baseSnapshot)).toEqual(baseSnapshot);
  });

  it('preserves unknown resource keys when their shape is canonical', () => {
    const input = cloneForMutation();
    input.resources.futureQuota = { kind: 'balance', unit: 'count', available: 7 };
    expect(parseUsageSnapshot(input).resources.futureQuota).toEqual(input.resources.futureQuota);
  });

  it('rejects impossible percentage values', () => {
    const input = cloneForMutation();
    input.resources.session = { kind: 'consumption', unit: 'percent', remaining: 101 };
    expect(() => parseUsageSnapshot(input)).toThrow(/percent/i);
  });

  it('rejects invalid timestamps', () => {
    expect(() => parseUsageSnapshot({ ...baseSnapshot, fetchedAt: 'not-a-date' })).toThrow(/fetchedAt/);
  });

  it('rejects impossible calendar dates in timestamps', () => {
    expect(() => parseUsageSnapshot({ ...baseSnapshot, fetchedAt: '2026-02-31T10:00:00.000Z' })).toThrow(/fetchedAt/);
    expect(() => parseUsageSnapshot({ ...baseSnapshot, syncedAt: '2026-04-31T10:00:00.000Z' })).toThrow(/syncedAt/);
    expect(() => parseUsageSnapshot({ ...baseSnapshot, expiresAt: '2026-13-01T10:00:00.000Z' })).toThrow(/expiresAt/);
    expect(() => parseUsageSnapshot({ ...baseSnapshot, expiresAt: '2026-00-10T10:00:00.000Z' })).toThrow(/expiresAt/);
  });

  it('rejects unknown top-level secret-bearing fields', () => {
    expect(() => parseUsageSnapshot({ ...baseSnapshot, access_token: 'secret' })).toThrow(/unknown field/i);
  });

  it('accepts bounded allowlisted diagnostic errorSummary codes and labels', () => {
    for (const code of ['refresh failed', 'not logged in', 'rate limited', 'network error', 'permission denied', 'provider unavailable', 'provider error']) {
      expect(parseUsageSnapshot({ ...baseSnapshot, errorSummary: code }).errorSummary).toBe(code);
    }
  });

  it('rejects arbitrary upstream prose in errorSummary', () => {
    expect(() => parseUsageSnapshot({
      ...baseSnapshot,
      errorSummary: 'Connection refused at line 42 in module auth.py unexpected token',
    })).toThrow(/errorSummary/i);
  });

  it('rejects synthetic token, path, Bearer, API-key, and GitHub-token shaped errorSummary', () => {
    expect(() => parseUsageSnapshot({ ...baseSnapshot, errorSummary: 'Bearer eyJhbGciOi' })).toThrow(/errorSummary/i);
    expect(() => parseUsageSnapshot({ ...baseSnapshot, errorSummary: ['', 'Users', 'synthetic-user', '.config', 'creds'].join('/') })).toThrow(/errorSummary/i);
    expect(() => parseUsageSnapshot({ ...baseSnapshot, errorSummary: ['sk', 'ant', 'api03', '12345678901234567890'].join('-') })).toThrow(/errorSummary/i);
    expect(() => parseUsageSnapshot({ ...baseSnapshot, errorSummary: ['ghp', '123456789012345678901234567890'].join('_') })).toThrow(/errorSummary/i);
  });
});
