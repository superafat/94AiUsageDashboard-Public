import { describe, expect, it } from 'vitest';
import type { UsageSnapshot } from '@94ai/core';
import { providerFamily, providerName, providerSort, resourceEntries } from './provider-display';

const base: UsageSnapshot = {
  schemaVersion: 1,
  userId: 'alice',
  deviceId: 'device-1',
  providerId: 'codex',
  fetchedAt: '2026-09-06T00:00:00.000Z',
  syncedAt: '2026-09-06T00:00:05.000Z',
  expiresAt: '2026-09-06T00:05:00.000Z',
  stale: false,
  resources: {},
};

describe('shared provider presentation', () => {
  it('maps account-scoped provider ids to their product family', () => {
    expect(providerFamily('codex@work')).toBe('codex');
    expect(providerFamily('antigravity@personal')).toBe('antigravity');
    expect(providerFamily('claude@work')).toBe('claude');
    expect(providerName({ ...base, providerId: 'claude@work' })).toBe('Claude Code');
  });

  it('keeps stable quota labels and excludes reset credits from quota rows', () => {
    const entries = resourceEntries({
      ...base,
      resources: {
        session: { kind: 'consumption', unit: 'percent', remaining: 51 },
        weekly: { kind: 'consumption', unit: 'percent', remaining: 48 },
        rateLimitResets: { kind: 'balance', unit: 'count', available: 3 },
      },
    });
    expect(entries.map((item) => [item.key, item.label])).toEqual([
      ['session', '5 小時額度'],
      ['weekly', '每週額度'],
    ]);
  });
  it('sorts guaranteed provider families before generic providers', () => {
    const snapshots = [
      { ...base, providerId: 'other' },
      { ...base, providerId: 'claude' },
      { ...base, providerId: 'antigravity' },
      { ...base, providerId: 'codex' },
    ];
    snapshots.sort(providerSort);
    expect(snapshots.map((item) => item.providerId)).toEqual(['codex', 'antigravity', 'claude', 'other']);
  });
});
