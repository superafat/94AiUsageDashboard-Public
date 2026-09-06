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
    const { rerender } = render(<ResetCreditList resource={{ kind: 'balance', unit: 'resets', available: 1, expiries: ['2026-09-21T00:00:00.000Z'] }} />);
    expect(screen.getByText('#001')).toBeInTheDocument();
    expect(screen.getByText('可用')).toBeInTheDocument();
    rerender(<ResetCreditList resource={{ kind: 'balance', unit: 'resets', available: 3, expiries: ['2026-09-21T00:00:00.000Z','2026-10-04T00:00:00.000Z','2026-10-05T00:00:00.000Z'] }} />);
    expect(screen.getByText('#003')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
