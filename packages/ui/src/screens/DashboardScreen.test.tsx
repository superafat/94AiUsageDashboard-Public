import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AppLocation } from '@94ai/client';
import type { UsageHistorySnapshot, UsageSnapshot } from '@94ai/core';
import { DashboardScreen } from './DashboardScreen';

const codex: UsageSnapshot = {
  schemaVersion: 1, userId: 'alice', deviceId: 'device-1', providerId: 'codex', plan: 'Pro 20x',
  fetchedAt: '2026-09-06T09:00:00.000Z', syncedAt: '2026-09-06T09:00:05.000Z', expiresAt: '2026-09-06T09:05:00.000Z', stale: false,
  resources: {
    session: { kind: 'consumption', unit: 'percent', remaining: 51, resetsAt: '2026-09-06T14:00:00.000Z' },
    weekly: { kind: 'consumption', unit: 'percent', remaining: 48, resetsAt: '2026-09-12T10:00:00.000Z' },
    sparkWeekly: { kind: 'consumption', unit: 'percent', remaining: 94 },
    rateLimitResets: { kind: 'balance', unit: 'resets', available: 3, expiries: ['2026-09-21T00:00:00.000Z'] },
  },
};

const antigravity: UsageSnapshot = {
  ...codex, providerId: 'antigravity', plan: 'Ultra', resources: {
    geminiSession: { kind: 'consumption', unit: 'percent', remaining: 96 },
    geminiWeekly: { kind: 'consumption', unit: 'percent', remaining: 77 },
    nonGeminiSession: { kind: 'consumption', unit: 'percent', remaining: 100 },
  },
};

function history(): UsageHistorySnapshot {
  return {
    schemaVersion: 1, userId: 'alice', deviceId: 'device-1', providerId: 'codex', syncedAt: '2026-09-06T09:00:05.000Z', currency: 'USD',
    periods: { today: { tokens: 20_000_000, estimatedCostUsd: 17.65 }, last30Days: { tokens: 300_000_000, estimatedCostUsd: 240 } },
    daily: Array.from({ length: 7 }, (_, index) => { const d = new Date(2026, 7, 31 + index, 12); return { date: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`, tokens: (index + 1) * 1_000_000, estimatedCostUsd: index + 1, finalized: index < 6 }; }),
  };
}

describe('DashboardScreen', () => {
  it('renders the approved product hierarchy instead of the old endless provider list', () => {
    render(<DashboardScreen userName="陳大利" items={[codex, antigravity]} historyItems={[history()]} now={new Date('2026-09-06T09:01:00.000Z')} offline={false} onNavigate={() => undefined} />);
    expect(screen.getByRole('heading', { name: '蜂神榜 Ai 額度儀表板' })).toBeInTheDocument();
    expect(screen.getByText('掌握使用情況，讓 AI 陪你走得更遠')).toBeInTheDocument();
    expect(screen.getByText('善用 AI，創造更多可能')).toBeInTheDocument();
    const codexCard = screen.getByRole('region', { name: 'Codex 額度' });
    expect(within(codexCard).getByText('51%')).toBeInTheDocument();
    expect(within(codexCard).getByText('48%')).toBeInTheDocument();
    expect(within(codexCard).queryByText('Spark 每週')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: '近 7 天 AI 使用' })).toHaveTextContent('28.00M');
    expect(screen.getByText('3 張可用')).toBeInTheDocument();
  });

  it('navigates to statistics, reset credits and provider details without mutating quotas', () => {
    const navigate = vi.fn<(location: AppLocation) => void>();
    render(<DashboardScreen userName="Alice" items={[codex]} historyItems={[history()]} now={new Date('2026-09-06T09:01:00.000Z')} offline={false} onNavigate={navigate} />);
    fireEvent.click(screen.getByRole('button', { name: '查看使用統計' }));
    fireEvent.click(screen.getByRole('button', { name: '查看重置額度' }));
    fireEvent.click(screen.getByRole('button', { name: '查看 Codex 詳情' }));
    expect(navigate.mock.calls.map(([location]) => location)).toEqual([{ route: 'usage' }, { route: 'resets' }, { route: 'provider', providerId: 'codex', deviceId: 'device-1' }]);
    expect(screen.queryByRole('button', { name: /^(使用|兌換|確認重置)$/ })).not.toBeInTheDocument();
  });

  it('carries exact deviceId when opening provider cards across multiple devices', () => {
    const navigate = vi.fn<(location: AppLocation) => void>();
    const codex1 = { ...codex, deviceId: 'device-alpha' };
    const codex2 = { ...codex, deviceId: 'device-beta' };
    render(<DashboardScreen userName="Alice" items={[codex1, codex2]} historyItems={[history()]} now={new Date('2026-09-06T09:01:00.000Z')} offline={false} onNavigate={navigate} />);
    const openButtons = screen.getAllByRole('button', { name: '查看 Codex 詳情' });
    expect(openButtons).toHaveLength(2);
    fireEvent.click(openButtons[1]!);
    expect(navigate).toHaveBeenCalledWith({ route: 'provider', providerId: 'codex', deviceId: 'device-beta' });
  });
});
