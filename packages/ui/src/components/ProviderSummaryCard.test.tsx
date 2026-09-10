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
});
