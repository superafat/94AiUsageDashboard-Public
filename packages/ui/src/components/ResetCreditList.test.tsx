import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ResetCreditList } from './ResetCreditList';

describe('ResetCreditList', () => {
  it('renders zero credits as no data without mutation actions', () => {
    render(<ResetCreditList resource={{ kind: 'balance', unit: 'resets', available: 0 }} />);
    expect(screen.getByText(/目前沒有可用的手動重置額度/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders one and many expiry rows as read-only status', () => {
    const now = new Date('2026-09-08T00:00:00.000Z');
    const { rerender } = render(
      <ResetCreditList
        resource={{ kind: 'balance', unit: 'resets', available: 1, expiries: ['2026-09-21T00:00:00.000Z'] }}
        now={now}
      />
    );
    expect(screen.getByText('#001')).toBeInTheDocument();
    expect(screen.getByText('可用')).toBeInTheDocument();
    rerender(
      <ResetCreditList
        resource={{ kind: 'balance', unit: 'resets', available: 3, expiries: ['2026-09-21T00:00:00.000Z','2026-10-04T00:00:00.000Z','2026-10-05T00:00:00.000Z'] }}
        now={now}
      />
    );
    expect(screen.getByText('#003')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('distinguishes expired credits from available credits and renders correct status pill', () => {
    const now = new Date('2026-09-08T00:00:00.000Z');
    // Synthetic credit with 2020 expiry is expired, MUST NOT be labeled 可用
    render(
      <ResetCreditList
        resource={{
          kind: 'balance',
          unit: 'resets',
          available: 2,
          expiries: ['2020-01-01T00:00:00.000Z', '2026-09-21T00:00:00.000Z'],
        }}
        now={now}
      />
    );
    expect(screen.getByText('已過期')).toBeInTheDocument();
    expect(screen.getByText('可用')).toBeInTheDocument();
  });

  it('bounds rendering to maximum items and displays cap indicator for large available counts', () => {
    const now = new Date('2026-09-08T00:00:00.000Z');
    render(
      <ResetCreditList
        resource={{
          kind: 'balance',
          unit: 'resets',
          available: 200,
        }}
        now={now}
      />
    );
    // Should render only 50 row elements, not 200
    expect(screen.getByText('#050')).toBeInTheDocument();
    expect(screen.queryByText('#051')).not.toBeInTheDocument();
    expect(screen.getByText(/僅顯示前 50 筆/)).toBeInTheDocument();
  });
});
