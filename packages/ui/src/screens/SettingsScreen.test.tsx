import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
      const toggle = screen.getByRole('switch', { name: new RegExp('^' + escaped + ' 資料來源$', 'i') });
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

  it('does not claim notification settings work when no notification writer is connected', () => {
    render(<SettingsScreen {...defaultProps} />);

    for (const toggle of screen.getAllByRole('switch', { name: /通知/i })) expect(toggle).toBeDisabled();
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


it('does not call this browser enabled just because another phone is subscribed', async () => {
 const notifications={isSupported:()=>true,getPermissionStatus:async()=> 'granted',getCurrentSubscription:async()=>null,
   subscribeProducers:(_uid:string,cb:(v:unknown[])=>void)=>{queueMicrotask(()=>cb([]));return()=>undefined;},
   subscribeSubscriptions:(_uid:string,cb:(v:unknown[])=>void)=>{queueMicrotask(()=>cb([{schemaVersion:1,userId:'alice',browserId:'other-phone',targetDeviceId:'mac-one',enrollmentEpoch:1,applicationServerKey:'BFRdOgvw1mGS7riy-AmAm8sq3A3yTouaefCn1Nnv1YFJXopKLfRAzMX1AQGvq_xGiBUdoWCfuZjeOFq9lDn7aDo',p256dh:'BFRdOgvw1mGS7riy-AmAm8sq3A3yTouaefCn1Nnv1YFJXopKLfRAzMX1AQGvq_xGiBUdoWCfuZjeOFq9lDn7aDo',auth:'8vyc8x-TXwGwYgjlAic24w',endpoint:'https://fcm.googleapis.com/fcm/send/example',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()}]));return()=>undefined;}};
 const services={notifications,clock:{now:()=>Date.now(),every:()=>()=>undefined},connectivity:{current:()=> 'online',subscribe:()=>()=>undefined}} as unknown as import('@94ai/client').AppClientServices;
 render(<SettingsScreen userName="Demo" userId="alice" services={services} backendProfile={{mode:'self-hosted',label:'Example'}} onNavigate={()=>undefined} onSignOut={async()=>undefined}/>);
 await waitFor(()=>expect(screen.getByText('找不到在線的 Mac Companion')).toBeInTheDocument());
 expect(screen.queryByText('推播通知已啟用')).not.toBeInTheDocument();
});
it('shows per-family notification write failures rather than silently leaving the switch',()=>{
 render(<SettingsScreen userName="Demo" backendProfile={{mode:'self-hosted',label:'Example'}} onNavigate={()=>undefined} onSignOut={async()=>undefined} onToggleNotification={async()=>undefined} notificationError={(family,type)=>family==='codex'&&type==='lowQuota'?'網路離線，無法儲存通知設定':undefined}/>);
 expect(screen.getByText('網路離線，無法儲存通知設定')).toBeInTheDocument();
});

describe('SettingsScreen push notification onboarding', () => {
  it('renders platform selector heading and 44px+ buttons', () => {
    render(
      <SettingsScreen
        userName="Demo"
        backendProfile={{ mode: 'self-hosted', label: 'Example' }}
        onNavigate={() => undefined}
        onSignOut={async () => undefined}
      />
    );

    expect(screen.getByText('選擇你的手機版本')).toBeInTheDocument();
    const iphoneBtn = screen.getByRole('button', { name: '我是 iPhone 使用者' });
    const androidBtn = screen.getByRole('button', { name: '我是 Android 使用者' });
    expect(iphoneBtn).toBeInTheDocument();
    expect(androidBtn).toBeInTheDocument();

    // Verify 44px minimum target sizes
    expect(parseInt(iphoneBtn.style.minHeight || '0', 10)).toBeGreaterThanOrEqual(44);
    expect(parseInt(iphoneBtn.style.minWidth || '0', 10)).toBeGreaterThanOrEqual(44);
    expect(parseInt(androidBtn.style.minHeight || '0', 10)).toBeGreaterThanOrEqual(44);
    expect(parseInt(androidBtn.style.minWidth || '0', 10)).toBeGreaterThanOrEqual(44);
  });

  it('switches between iPhone and Android flows showing only selected steps and does not call permission', async () => {
    const onEnablePush = vi.fn();
    render(
      <SettingsScreen
        userName="Demo"
        backendProfile={{ mode: 'self-hosted', label: 'Example' }}
        onNavigate={() => undefined}
        onSignOut={async () => undefined}
        onEnablePush={onEnablePush}
      />
    );

    const iphoneBtn = screen.getByRole('button', { name: '我是 iPhone 使用者' });
    const androidBtn = screen.getByRole('button', { name: '我是 Android 使用者' });

    // Click iPhone
    fireEvent.click(iphoneBtn);
    expect(onEnablePush).not.toHaveBeenCalled();
    expect(screen.getByText(/Safari/)).toBeInTheDocument();
    expect(screen.getByText(/加入主畫面/)).toBeInTheDocument();
    expect(screen.getByText(/專注模式/)).toBeInTheDocument();
    // Android specific text should not be present in steps
    expect(screen.queryByText(/電池最佳化/)).not.toBeInTheDocument();

    // Click Android
    fireEvent.click(androidBtn);
    expect(onEnablePush).not.toHaveBeenCalled();
    expect(screen.getAllByText(/Chrome/)[0]).toBeInTheDocument();
    expect(screen.getByText(/電池最佳化/)).toBeInTheDocument();
    // iPhone specific text should not be present
    expect(screen.queryByText(/專注模式/)).not.toBeInTheDocument();


    // Common troubleshooting should be present
    expect(screen.getByText(/常見問題與排查/)).toBeInTheDocument();
    expect(screen.getAllByText(/約每 5 分鐘/)[0]).toBeInTheDocument();
  });

  it('renders entry for 更新與公告 and navigates to updates route', () => {
    const onNavigate = vi.fn();
    render(
      <SettingsScreen
        userName="Demo"
        backendProfile={{ mode: 'self-hosted', label: 'Example' }}
        onNavigate={onNavigate}
        onSignOut={async () => undefined}
      />
    );

    const updatesBtn = screen.getByRole('button', { name: /更新與公告/ });
    expect(updatesBtn).toBeInTheDocument();
    fireEvent.click(updatesBtn);
    expect(onNavigate).toHaveBeenCalledWith({ route: 'updates' });
  });
});
