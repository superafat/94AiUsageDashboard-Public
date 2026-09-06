import type { AppLocation, AppRoute } from '@94ai/client';
import type { ReactNode } from 'react';
import { BottomNav } from './BottomNav';
import { DesktopNav } from './DesktopNav';

export function AppShell({ active, userName, onNavigate, onSignOut, hideTopbar = false, children }: { active: AppRoute; userName: string; onNavigate: (location: AppLocation) => void; onSignOut: () => Promise<void>; hideTopbar?: boolean; children: ReactNode }) {
  return <div className="product-shell">
    <DesktopNav active={active} onNavigate={onNavigate} />
    <div className={`product-shell__main${hideTopbar ? ' product-shell__main--home' : ''}`}>
      {hideTopbar ? null : <header className="product-topbar"><div><p className="product-topbar__eyebrow">AI 使用狀態</p><strong>AI Usage</strong></div><button className="account-button" type="button" onClick={() => void onSignOut()}>{userName}</button></header>}
      <main className="product-content" data-app-route={active}>{children}</main>
    </div>
    <BottomNav active={active} onNavigate={onNavigate} />
  </div>;
}
