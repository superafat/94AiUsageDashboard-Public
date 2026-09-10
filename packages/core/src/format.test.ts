import { describe, expect, it } from 'vitest';
import {
  formatCountdown,
  formatPercent,
  formatResourceRemaining,
  formatTokens,
  resolveResetCredits,
} from './format';

describe('formatPercent', () => {
  it('formats a percentage without inventing missing values', () => {
    expect(formatPercent(51)).toBe('51%');
    expect(formatPercent(undefined)).toBe('無資料');
  });
});

describe('formatCountdown', () => {
  it('formats future duration, sub-minute countdowns, and reset-awaiting-refresh', () => {
    const now = new Date('2026-09-05T00:00:00.000Z');
    expect(formatCountdown('2026-09-06T03:02:00.000Z', now)).toBe('1d 3h 2m');
    // Sub-minute future: 30 seconds in the future must render 30s, not 已重置
    expect(formatCountdown('2026-09-05T00:00:30.000Z', now)).toBe('30s');
    expect(formatCountdown('2026-09-05T00:00:45.000Z', now)).toBe('45s');
    // Elapsed time represents reset-awaiting-refresh
    expect(formatCountdown('2026-09-04T23:00:00.000Z', now)).toBe('待刷新');
    expect(formatCountdown('2026-09-04T23:00:00.000Z', now, { elapsedLabel: '已過期' })).toBe('已過期');
    expect(formatCountdown(undefined, now)).toBe('無資料');
    expect(formatCountdown('not-a-date', now)).toBe('無資料');
  });
});

describe('formatTokens', () => {
  it('formats token numbers with unit-aware suffixes and guards missing values', () => {
    expect(formatTokens(undefined)).toBe('無資料');
    expect(formatTokens(Number.NaN)).toBe('無資料');
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(500)).toBe('500');
    expect(formatTokens(1_000)).toBe('1.0K');
    expect(formatTokens(1_500_000)).toBe('1.50M');
    expect(formatTokens(12_000_000_000)).toBe('12.0B');
  });
});

describe('formatResourceRemaining', () => {
  it('formats consumption resources with appropriate units without treating all units as percent', () => {
    // Percent unit
    expect(formatResourceRemaining({ kind: 'consumption', unit: 'percent', remaining: 85 })).toEqual({
      text: '85%',
      unit: '剩餘',
      percentage: 85,
      tone: 'success',
    });
    expect(formatResourceRemaining({ kind: 'consumption', unit: 'percent', remaining: 5 })).toEqual({
      text: '5%',
      unit: '剩餘',
      percentage: 5,
      tone: 'danger',
    });

    // Tokens unit: remaining 1000 must NOT render 1000%
    expect(formatResourceRemaining({ kind: 'consumption', unit: 'tokens', remaining: 1000 })).toEqual({
      text: '1.0K',
      unit: 'tokens',
      percentage: undefined,
      tone: 'neutral',
    });

    // Tokens unit with limit: percentage calculated
    expect(formatResourceRemaining({ kind: 'consumption', unit: 'tokens', remaining: 1000, limit: 5000 })).toEqual({
      text: '1.0K',
      unit: 'tokens',
      percentage: 20,
      tone: 'warning',
    });

    // Derives remaining from limit - used when remaining is omitted
    expect(formatResourceRemaining({ kind: 'consumption', unit: 'percent', used: 75, limit: 100 })).toEqual({
      text: '25%',
      unit: '剩餘',
      percentage: 25,
      tone: 'warning',
    });

    // Missing / invalid data
    expect(formatResourceRemaining({ kind: 'consumption', unit: 'percent' })).toEqual({
      text: '無資料',
      tone: 'neutral',
    });

    // Balance resource
    expect(formatResourceRemaining({ kind: 'balance', unit: 'resets', available: 3 })).toEqual({
      text: '3',
      unit: 'resets',
      percentage: undefined,
      tone: 'neutral',
    });
  });
});

describe('resolveResetCredits', () => {
  it('distinguishes available, expired, and unknown reset credits and bounds rendering', () => {
    const now = new Date('2026-09-08T00:00:00.000Z');
    // Synthetic credit with 2020 expiry is expired, not available
    const expiredResource = {
      kind: 'balance' as const,
      unit: 'resets',
      available: 1,
      expiries: ['2020-01-01T00:00:00.000Z'],
    };
    const resolvedExpired = resolveResetCredits(expiredResource, now);
    expect(resolvedExpired.total).toBe(1);
    expect(resolvedExpired.availableCount).toBe(0);
    expect(resolvedExpired.expiredCount).toBe(1);
    expect(resolvedExpired.items[0]).toMatchObject({
      status: 'expired',
      statusLabel: '已過期',
      statusTone: 'danger',
    });

    // Mixed credits
    const mixedResource = {
      kind: 'balance' as const,
      unit: 'resets',
      available: 3,
      expiries: [
        '2020-01-01T00:00:00.000Z', // expired
        '2026-09-20T00:00:00.000Z', // available
        // 3rd has no expiry -> unknown
      ],
    };
    const resolvedMixed = resolveResetCredits(mixedResource, now);
    expect(resolvedMixed.total).toBe(3);
    expect(resolvedMixed.availableCount).toBe(2);
    expect(resolvedMixed.expiredCount).toBe(1);
    expect(resolvedMixed.unknownCount).toBe(1);
    expect(resolvedMixed.items[1]?.status).toBe('available');
    expect(resolvedMixed.items[2]?.status).toBe('unknown');

    // Bounded rendering: if available is large, items array is capped to MAX_RENDER_ITEMS (50)
    const largeResource = {
      kind: 'balance' as const,
      unit: 'resets',
      available: 1000,
    };
    const resolvedLarge = resolveResetCredits(largeResource, now);
    expect(resolvedLarge.total).toBe(1000);
    expect(resolvedLarge.items.length).toBe(50);
    expect(resolvedLarge.capped).toBe(true);
  });

  it('does not scan arbitrary reset-credit counts beyond provided expiry evidence', () => {
    const now = new Date('2026-09-08T00:00:00.000Z');
    const guardedExpiries = new Proxy(['2026-09-20T00:00:00.000Z'], {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/u.test(property) && Number(property) >= target.length) {
          throw new Error('unbounded expiry access');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const resolved = resolveResetCredits({
      kind: 'balance',
      unit: 'resets',
      available: 1_000_000_000,
      expiries: guardedExpiries,
    }, now);
    expect(resolved.total).toBe(1_000_000_000);
    expect(resolved.availableCount).toBe(1_000_000_000);
    expect(resolved.unknownCount).toBe(999_999_999);
    expect(resolved.items).toHaveLength(50);
    expect(resolved.capped).toBe(true);
  });
});
