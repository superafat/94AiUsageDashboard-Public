import { describe, expect, it } from 'vitest';
import { formatCountdown, formatPercent } from './format';

describe('formatPercent', () => {
  it('formats a percentage without inventing missing values', () => {
    expect(formatPercent(51)).toBe('51%');
    expect(formatPercent(undefined)).toBe('無資料');
  });
});

describe('formatCountdown', () => {
  it('formats future duration and reports elapsed reset times', () => {
    const now = new Date('2026-09-05T00:00:00.000Z');
    expect(formatCountdown('2026-09-06T03:02:00.000Z', now)).toBe('1d 3h 2m');
    expect(formatCountdown('2026-09-04T23:00:00.000Z', now)).toBe('已重置');
    expect(formatCountdown(undefined, now)).toBe('無資料');
  });
});
