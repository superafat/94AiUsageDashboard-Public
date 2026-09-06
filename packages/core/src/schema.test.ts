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

  it('rejects unknown top-level secret-bearing fields', () => {
    expect(() => parseUsageSnapshot({ ...baseSnapshot, access_token: 'secret' })).toThrow(/unknown field/i);
  });
});
