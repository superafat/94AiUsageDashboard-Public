import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeOpenUsageLimits } from './normalize';

function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(new URL(`../test/fixtures/${name}.json`, import.meta.url), 'utf8'));
}

const ctx = { userId: 'user-1', deviceId: 'device-1', syncedAt: '2026-09-05T10:00:15.000Z' };

describe('normalizeOpenUsageLimits', () => {
  it('maps Codex resources by stable resource key', () => {
    const [snapshot] = normalizeOpenUsageLimits(fixture('normal'), ctx);
    expect(snapshot?.providerId).toBe('codex');
    expect(snapshot?.resources.session).toMatchObject({ kind: 'consumption', remaining: 51 });
    expect(snapshot?.resources.weekly).toMatchObject({ kind: 'consumption', remaining: 48 });
    expect(snapshot?.resources.rateLimitResets).toMatchObject({ kind: 'balance', available: 3 });
    expect(snapshot?.resources.rateLimitResets && 'expiries' in snapshot.resources.rateLimitResets ? snapshot.resources.rateLimitResets.expiries : undefined).toHaveLength(3);
  });

  it('does not invent a missing session resource', () => {
    const [snapshot] = normalizeOpenUsageLimits(fixture('missing-session'), ctx);
    expect(snapshot?.resources.session).toBeUndefined();
    expect(snapshot?.resources.weekly).toBeDefined();
  });

  it('preserves stale state and non-sensitive provider error', () => {
    const [snapshot] = normalizeOpenUsageLimits(fixture('stale'), ctx);
    expect(snapshot?.stale).toBe(true);
    expect(snapshot?.errorSummary).toBe('refresh failed');
  });

  it('preserves unknown scalar resources without provider-only fields', () => {
    const [snapshot] = normalizeOpenUsageLimits(fixture('unknown-resource'), ctx);
    expect(snapshot?.resources.futureQuota).toEqual({ kind: 'balance', unit: 'count', available: 7 });
  });

  it('preserves the four first-class Antigravity quota resources', () => {
    const [snapshot] = normalizeOpenUsageLimits(fixture('antigravity'), ctx);
    expect(snapshot?.providerId).toBe('antigravity');
    expect(snapshot?.plan).toBe('Ultra');
    expect(snapshot?.resources.geminiSession).toMatchObject({ kind: 'consumption', remaining: 96 });
    expect(snapshot?.resources.geminiWeekly).toMatchObject({ kind: 'consumption', remaining: 77 });
    expect(snapshot?.resources.nonGeminiSession).toMatchObject({ kind: 'consumption', remaining: 90 });
    expect(snapshot?.resources.nonGeminiWeekly).toMatchObject({ kind: 'consumption', remaining: 22 });
  });

  it('preserves account-scoped Claude Code quotas and balances', () => {
    const [snapshot] = normalizeOpenUsageLimits(fixture('claude'), ctx);
    expect(snapshot?.providerId).toBe('claude@personal');
    expect(snapshot?.plan).toBe('Max');
    expect(snapshot?.resources.session).toMatchObject({ kind: 'consumption', remaining: 63 });
    expect(snapshot?.resources.weekly).toMatchObject({ kind: 'consumption', remaining: 42 });
    expect(snapshot?.resources.fable).toMatchObject({ kind: 'consumption', remaining: 80 });
    expect(snapshot?.resources.sonnet).toMatchObject({ kind: 'consumption', remaining: 85 });
    expect(snapshot?.resources.extraUsage).toEqual({ kind: 'balance', unit: 'usd', available: 31.84 });
  });

  it('rejects malformed envelopes', () => {
    expect(() => normalizeOpenUsageLimits(fixture('malformed'), ctx)).toThrow(/openusage/i);
  });
  it('isolates malformed providers instead of dropping healthy providers', () => {
    const normal = fixture('normal') as { providers: Record<string, Record<string, unknown>> };
    const broken = { ...normal.providers.codex, fetchedAt: 'invalid-date' };
    const result = normalizeOpenUsageLimits({ schema: 'openusage.limits.v1', providers: { broken, ...normal.providers } }, ctx);
    expect(result.map((item) => item.providerId)).toEqual(['codex']);
  });

  it('omits an invalid future resource while retaining healthy quota fields', () => {
    const normal = fixture('normal') as { providers: Record<string, { resources: Record<string, unknown> }> };
    normal.providers.codex!.resources.futureBadQuota = { kind: 'consumption', unit: 'percent', remaining: 150 };
    const [result] = normalizeOpenUsageLimits(normal, ctx);
    expect(result?.resources.futureBadQuota).toBeUndefined();
    expect(result?.resources.weekly).toMatchObject({ remaining: 48 });
  });

});
