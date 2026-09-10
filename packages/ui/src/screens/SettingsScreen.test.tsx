import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsScreen } from './SettingsScreen';
import { PROVIDER_CATALOG } from '@94ai/core';

describe('SettingsScreen provider preferences', () => {
  const defaultProps = {
    userName: 'Alice',
    backendProfile: { mode: 'self-hosted' as const, label: 'Self-hosted Firebase' },
    onNavigate: vi.fn(),
    onSignOut: vi.fn(),
    isFamilyEnabled: (family: string) => ['codex', 'antigravity', 'claude'].includes(family),
    isFamilySaving: () => false,
    familyError: () => undefined,
    onToggleFamily: vi.fn(),
  };

  it('displays all 11 catalog families with truthful enabled/disabled states', () => {
    render(<SettingsScreen {...defaultProps} />);

    for (const entry of PROVIDER_CATALOG) {
      const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const toggle = screen.getByRole('switch', { name: new RegExp(escaped, 'i') });
      expect(toggle).toBeDefined();
      if (['codex', 'antigravity', 'claude'].includes(entry.family)) {
        expect(toggle.getAttribute('aria-checked')).toBe('true');
      } else {
        expect(toggle.getAttribute('aria-checked')).toBe('false');
      }
    }
  });

  it('calls onToggleFamily when a toggle is clicked', () => {
    const onToggleFamily = vi.fn();
    render(<SettingsScreen {...defaultProps} onToggleFamily={onToggleFamily} />);

    const cursorToggle = screen.getByRole('switch', { name: /cursor/i });
    fireEvent.click(cursorToggle);

    expect(onToggleFamily).toHaveBeenCalledWith('cursor', true);
  });

  it('shows saving state and disables toggle while saving', () => {
    render(<SettingsScreen {...defaultProps} isFamilySaving={(f) => f === 'cursor'} />);

    const cursorToggle = screen.getByRole('switch', { name: /cursor/i });
    expect(cursorToggle).toBeDisabled();
    expect(screen.getByText('儲存中…')).toBeDefined();
  });

  it('shows truthful error message when save fails', () => {
    render(
      <SettingsScreen
        {...defaultProps}
        familyError={(f) => (f === 'cursor' ? '網路離線，無法儲存設定' : undefined)}
      />,
    );

    expect(screen.getByText('網路離線，無法儲存設定')).toBeDefined();
  });

  it('does not display working notification toggles or claim delivery in S1', () => {
    render(<SettingsScreen {...defaultProps} />);

    expect(screen.queryByRole('switch', { name: /通知/i })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /通知/i })).toBeNull();
  });

  it('does not contain source credential input fields in browser', () => {
    render(<SettingsScreen {...defaultProps} />);

    expect(screen.queryByPlaceholderText(/api[-_\s]?key/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/token/i)).toBeNull();
    expect(screen.queryByLabelText(/api[-_\s]?key/i)).toBeNull();
  });

  it('shows Traditional Chinese pending state during loading and does not display toggle list', () => {
    render(<SettingsScreen {...defaultProps} status="loading" hasObserved={false} />);

    expect(screen.getByText('正在載入偏好設定…')).toBeDefined();
    expect(screen.queryByRole('group', { name: /資料來源開關列表/ })).toBeNull();
  });

  it('shows Traditional Chinese read-error state on initial failure and does not display toggle list', () => {
    render(<SettingsScreen {...defaultProps} status="error" hasObserved={false} />);

    expect(screen.getByText('偏好設定讀取失敗')).toBeDefined();
    expect(screen.getByText(/無法取得資料來源偏好設定/)).toBeDefined();
    expect(screen.queryByRole('group', { name: /資料來源開關列表/ })).toBeNull();
  });
});

it('does not present an inert source control as usable', () => {
  render(<SettingsScreen userName="Demo" backendProfile={{mode:'self-hosted',label:'Example'}} onNavigate={() => undefined} onSignOut={async () => undefined} />);
  expect(screen.getByRole('switch', { name: 'Cursor 資料來源' })).toBeDisabled();
});
it('distinguishes detected sources from not-yet-connected sources', () => {
  render(<SettingsScreen userName="Demo" backendProfile={{mode:'self-hosted',label:'Example'}} onNavigate={() => undefined} onSignOut={async () => undefined} observedFamilies={['codex']} onToggleFamily={async () => undefined} />);
  expect(screen.getByText('已收到來源資料')).toBeDefined();
  expect(screen.getAllByText('尚未收到資料；請先在 Mac 的 OpenUsage 連接')).toHaveLength(10);
});
