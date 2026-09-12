import type { AppLocation, AppRoute } from '@94ai/client';
import type { ReactNode } from 'react';
import { BeeMascot } from './BeeMascot';
import { BottomNav } from './BottomNav';
import { DesktopNav } from './DesktopNav';

export function AppShell({ active, userName, onNavigate, onSignOut, hideTopbar = false, children }: { active: AppRoute; userName: string; onNavigate: (location: AppLocation) => void; onSignOut: () => Promise<void>; hideTopbar?: boolean; children: ReactNode }) {
  return <div className="product-shell">
    <DesktopNav active={active} onNavigate={onNavigate} />
    <div className={`product-shell__main${hideTopbar ? ' product-shell__main--home' : ''}`}>
      {hideTopbar ? null : <header className="product-topbar"><div className="product-topbar__brand"><BeeMascot size={22} /><div><p className="product-topbar__eyebrow">94AiUsageDashboard</p><strong>蜂神榜 Ai 額度儀表板</strong></div></div><button className="account-button" type="button" onClick={() => void onSignOut()}>{userName}</button></header>}
      <main className="product-content" data-app-route={active}>{children}</main>
    </div>
    <BottomNav active={active} onNavigate={onNavigate} />
  </div>;
}
