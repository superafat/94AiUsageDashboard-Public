import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AppLocation } from '@94ai/client';
import type { UsageSnapshot } from '@94ai/core';
import { ProviderDetailScreen } from './ProviderDetailScreen';

const codex: UsageSnapshot = {
  schemaVersion: 1, userId: 'alice', deviceId: 'device-1', providerId: 'codex', plan: 'Pro 20x',
  fetchedAt: '2026-09-06T09:00:00.000Z', syncedAt: '2026-09-06T09:00:05.000Z', expiresAt: '2026-09-06T09:05:00.000Z', stale: false,
  resources: {
    session: { kind: 'consumption', unit: 'percent', remaining: 51 },
    weekly: { kind: 'consumption', unit: 'percent', remaining: 48 },
    spark: { kind: 'consumption', unit: 'percent', remaining: 92 },
    credits: { kind: 'balance', unit: 'credits', available: 796 },
    rateLimitResets: { kind: 'balance', unit: 'resets', available: 2, expiries: ['2026-09-20T00:00:00.000Z'] },
  },
};

describe('ProviderDetailScreen', () => {
  it('shows the full provider detail while reset credits remain read-only', () => {
    render(<ProviderDetailScreen snapshot={codex} onNavigate={() => undefined} />);
    expect(screen.getByRole('heading', { name: 'Codex' })).toBeInTheDocument();
    expect(screen.getByText('5 小時額度')).toBeInTheDocument();
    expect(screen.getByText('每週額度')).toBeInTheDocument();
    expect(screen.getByText('Spark 5 小時')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'credits' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '手動重置額度' })).toBeInTheDocument();
    expect(screen.getByText(/目前僅供查看/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(使用|重置|兌換)$/ })).not.toBeInTheDocument();
  });

  it('returns to the dashboard without browser routing assumptions', () => {
    const navigate = vi.fn<(location: AppLocation) => void>();
    render(<ProviderDetailScreen snapshot={codex} onNavigate={navigate} />);
    fireEvent.click(screen.getByRole('button', { name: /返回首頁/ }));
    expect(navigate).toHaveBeenCalledWith({ route: 'dashboard' });
  });
});
