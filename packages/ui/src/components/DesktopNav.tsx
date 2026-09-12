import type { AppLocation, AppRoute } from '@94ai/client';
import { BeeMascot } from './BeeMascot';
import { NavIcon } from './NavIcon';

const items: Array<{ route: AppRoute; label: string; location: AppLocation }> = [
  { route: 'dashboard', label: '首頁', location: { route: 'dashboard' } },
  { route: 'usage', label: '使用統計', location: { route: 'usage' } },
  { route: 'resets', label: '重置額度', location: { route: 'resets' } },
  { route: 'settings', label: '設定', location: { route: 'settings' } },
];

export function DesktopNav({ active, onNavigate }: { active: AppRoute; onNavigate: (location: AppLocation) => void }) {
  return <nav className="desktop-nav" aria-label="主要導覽">
    <div className="product-brand"><span className="product-brand__mark"><BeeMascot size={26} /></span><span><strong>94AiUsageDashboard</strong><small>蜂神榜 Ai 額度儀表板</small></span></div>
    <div className="desktop-nav__items">{items.map((item) => <button key={item.route} className="nav-button" data-active={active === item.route} type="button" onClick={() => onNavigate(item.location)}><NavIcon route={item.route} />{item.label}</button>)}</div>
  </nav>;
}
