import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { UsageHistorySnapshot } from '@94ai/core';
import { UsageStatsScreen } from './UsageStatsScreen';

function history(providerId: string, completeCost: boolean): UsageHistorySnapshot {
  const daily = Array.from({ length: 31 }, (_, index) => {
    const date = new Date(2026, 7, 7 + index, 12);
    const tokens = (index + 1) * 1_000_000;
    return {
      date: `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`,
      tokens,
      ...(completeCost ? { estimatedCostUsd: index + 1 } : index >= 29 ? { estimatedCostUsd: index + 1 } : {}),
      finalized: index < 30,
    };
  });
  return {
    schemaVersion: 1, userId: 'alice', deviceId: 'device-1', providerId,
    syncedAt: '2026-09-06T02:00:00.000Z', currency: 'USD', daily,
    periods: {
      today: { tokens: 31_000_000, estimatedCostUsd: 31 },
      yesterday: { tokens: 30_000_000, estimatedCostUsd: 30 },
      last30Days: { tokens: 495_000_000, estimatedCostUsd: 495 },
    },
  };
}

describe('UsageStatsScreen', () => {
  it('switches day, 7-day and 30-day summaries without inventing incomplete cost', () => {
    render(<UsageStatsScreen items={[history('codex', true), history('antigravity', false)]} now={new Date('2026-09-06T10:00:00.000Z')} />);
    expect(screen.getByRole('heading', { name: '使用統計' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '近 7 天' })).toHaveAttribute('data-active', 'true');
    const pendingCost = screen.getByRole('region', { name: '估算 API 等值費用' });
    expect(within(pendingCost).getByText('費用資料累積中')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '近 30 天' }));
    const costCard = screen.getByRole('region', { name: '估算 API 等值費用' });
    expect(within(costCard).getByText(/US\$/)).toBeInTheDocument();
    expect(screen.queryByText(/實際花費|帳單|已扣款/)).not.toBeInTheDocument();
  });

  it('renders provider history as separate truthful breakdowns', () => {
    render(<UsageStatsScreen items={[history('codex', true), history('antigravity', true)]} now={new Date('2026-09-06T10:00:00.000Z')} />);
    expect(screen.getAllByText('Codex').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Antigravity').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('img', { name: /每日 Token 使用趨勢/ })).toBeInTheDocument();
  });
});
