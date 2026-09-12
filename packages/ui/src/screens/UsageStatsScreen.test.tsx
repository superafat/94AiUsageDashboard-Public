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

  it('provides exactly 5 period selectors: 1d, 7d, 30d, 90d, 180d', () => {
    render(<UsageStatsScreen items={[history('codex', true)]} now={new Date('2026-09-06T10:00:00.000Z')} />);
    const buttons = screen.getAllByRole('button').filter((btn) =>
      ['今日', '近 7 天', '近 30 天', '近 90 天', '近 180 天'].includes(btn.textContent ?? '')
    );
    expect(buttons).toHaveLength(5);
    expect(screen.getByRole('button', { name: '近 90 天' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '近 180 天' })).toBeInTheDocument();
  });

  it('truthfully indicates partial available range when selected 90d or 180d with shorter history', () => {
    render(<UsageStatsScreen items={[history('codex', true)]} now={new Date('2026-09-06T10:00:00.000Z')} />);
    fireEvent.click(screen.getByRole('button', { name: '近 90 天' }));
    // 31 days of history is available (less than 90)
    const notice = screen.getByRole('status', { name: /資料涵蓋範圍|歷史資料涵蓋範圍/ });
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent(/31/);

    fireEvent.click(screen.getByRole('button', { name: '近 180 天' }));
    expect(notice).toHaveTextContent(/31/);
    expect(notice).not.toHaveTextContent(/已完整收錄 180 天/);
  });

  it('renders provider history as separate truthful breakdowns', () => {
    render(<UsageStatsScreen items={[history('codex', true), history('antigravity', true)]} now={new Date('2026-09-06T10:00:00.000Z')} />);
    expect(screen.getAllByText('Codex').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Antigravity').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('img', { name: /每日 Token 使用趨勢/ })).toBeInTheDocument();
  });

  it('truthfully formats sparse non-consecutive dates notice without implying consecutive days', () => {
    const sparseSnapshot: UsageHistorySnapshot = {
      schemaVersion: 1, userId: 'alice', deviceId: 'device-1', providerId: 'codex',
      syncedAt: '2026-09-06T02:00:00.000Z', currency: 'USD',
      periods: {},
      daily: [
        { date: '2026-07-01', tokens: 1000, finalized: true },
        { date: '2026-08-15', tokens: 2000, finalized: true },
        { date: '2026-09-06', tokens: 3000, finalized: false },
      ],
    };
    render(<UsageStatsScreen items={[sparseSnapshot]} now={new Date('2026-09-06T10:00:00.000Z')} />);
    fireEvent.click(screen.getByRole('button', { name: '近 90 天' }));
    const notice = screen.getByRole('status', { name: /資料涵蓋範圍|歷史資料涵蓋範圍/ });
    expect(notice).toBeInTheDocument();
    // Must NOT imply consecutive "近 3 天"
    expect(notice).not.toHaveTextContent(/涵蓋近 3 天|近 3 天/);
    // Must explicitly say 3 actual data dates
    expect(notice).toHaveTextContent(/實際有資料的 3 個日期|實際有資料共 3 天|實際記錄 3 個資料日期|實際涵蓋 3 個有資料日期/);
    // Shows first and last actual dates
    expect(notice).toHaveTextContent(/2026\/07\/01/);
    expect(notice).toHaveTextContent(/2026\/09\/06/);
    // Explains missing history is not fabricated
    expect(notice).toHaveTextContent(/不捏造歷史/);
  });
});
