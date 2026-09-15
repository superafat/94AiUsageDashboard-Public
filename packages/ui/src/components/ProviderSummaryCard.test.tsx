import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { UsageSnapshot } from '@94ai/core';
import { ProviderSummaryCard } from './ProviderSummaryCard';

const base: UsageSnapshot = {
  schemaVersion: 1,
  userId: 'alice',
  deviceId: 'device-1',
  providerId: 'codex',
  fetchedAt: '2026-09-08T00:00:00.000Z',
  syncedAt: '2026-09-08T00:00:05.000Z',
  expiresAt: '2026-09-08T00:05:00.000Z',
  stale: false,
  resources: {
    session: { kind: 'consumption', unit: 'tokens', remaining: 1000 },
  },
};

describe('ProviderSummaryCard', () => {
  it('does not draw a fake zero-percent progress bar when a non-percent quota has no limit', () => {
    render(<ProviderSummaryCard snapshot={base} now={new Date('2026-09-08T00:00:10.000Z')} onOpen={() => undefined} />);
    expect(screen.getByText('1.0K')).toBeInTheDocument();
    expect(screen.getByText('tokens')).toBeInTheDocument();
    expect(screen.queryByLabelText('5 小時額度剩餘 1.0K')).not.toBeInTheDocument();
  });

  it('shows OpenCode session, weekly, and monthly quota rows instead of an empty connected card', () => {
    render(<ProviderSummaryCard snapshot={{
      ...base,
      providerId: 'opencode',
      plan: 'Go',
      resources: {
        session: { kind: 'consumption', unit: 'percent', remaining: 100, resetsAt: '2026-09-08T05:00:00.000Z' },
        weekly: { kind: 'consumption', unit: 'percent', remaining: 100, resetsAt: '2026-09-14T00:00:00.000Z' },
        monthly: { kind: 'consumption', unit: 'percent', remaining: 79, resetsAt: '2026-10-08T00:00:00.000Z' },
      },
    }} now={new Date('2026-09-08T00:00:10.000Z')} onOpen={() => undefined} />);
    expect(screen.getByText('5 小時額度')).toBeInTheDocument();
    expect(screen.getByText('每週額度')).toBeInTheDocument();
    expect(screen.getByText('每月額度')).toBeInTheDocument();
    expect(screen.getByText('79%')).toBeInTheDocument();
    expect(screen.queryByText('來源已連接，但目前沒有可顯示的額度資料')).not.toBeInTheDocument();
  });
});
