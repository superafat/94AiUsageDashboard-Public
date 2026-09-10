import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QuotaCard } from './QuotaCard';

describe('QuotaCard', () => {
  it('formats consumption resources with tokens unit without rendering percent sign', () => {
    render(
      <QuotaCard
        label="Token Quota"
        providerLabel="Codex"
        resource={{
          kind: 'consumption',
          unit: 'tokens',
          remaining: 1000,
        }}
      />
    );
    // Must render 1.0K tokens, NOT 1000%
    expect(screen.getByText('1.0K')).toBeInTheDocument();
    expect(screen.getByText('tokens')).toBeInTheDocument();
    expect(screen.queryByText(/1000%/)).not.toBeInTheDocument();
  });

  it('formats percent consumption resources with percent and 剩餘 label', () => {
    render(
      <QuotaCard
        label="5 小時額度"
        providerLabel="Codex"
        resource={{
          kind: 'consumption',
          unit: 'percent',
          remaining: 75,
        }}
      />
    );
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('剩餘')).toBeInTheDocument();
  });

  it('renders sub-minute reset countdown with seconds and elapsed reset with 待刷新', () => {
    const now = new Date('2026-09-08T12:00:00.000Z');
    const { rerender } = render(
      <QuotaCard
        label="5 小時額度"
        providerLabel="Codex"
        resource={{
          kind: 'consumption',
          unit: 'percent',
          remaining: 75,
          resetsAt: '2026-09-08T12:00:30.000Z', // 30s in the future
        }}
        now={now}
      />
    );
    expect(screen.getByText(/30s/)).toBeInTheDocument();
    expect(screen.queryByText(/已重置/)).not.toBeInTheDocument();

    // Elapsed reset time
    rerender(
      <QuotaCard
        label="5 小時額度"
        providerLabel="Codex"
        resource={{
          kind: 'consumption',
          unit: 'percent',
          remaining: 75,
          resetsAt: '2026-09-08T11:59:00.000Z', // 1 min in the past
        }}
        now={now}
      />
    );
    expect(screen.getByText(/待刷新/)).toBeInTheDocument();
  });
});
