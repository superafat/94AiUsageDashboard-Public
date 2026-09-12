import type { AppLocation } from '@94ai/client';
import { PROVIDER_CATALOG, resolveResetCredits, type UsageHistorySnapshot, type UsageSnapshot } from '@94ai/core';
import { BeeMascot } from '../components/BeeMascot';
import { ProviderSummaryCard } from '../components/ProviderSummaryCard';
import { UsageSummaryCard } from '../components/UsageSummaryCard';
import { providerFamily, providerSort } from '../provider-display';

export interface DashboardScreenProps {
  userName: string;
  items: UsageSnapshot[];
  historyItems: UsageHistorySnapshot[];
  now: Date;
  offline: boolean;
  loading?: boolean;
  readError?: string | undefined;
  hasStale?: boolean;
  onNavigate: (location: AppLocation) => void;
  isFamilyEnabled?: (family: string) => boolean;
}

export function DashboardScreen({ userName, items, historyItems, now, offline, loading, readError, hasStale, onNavigate, isFamilyEnabled }: DashboardScreenProps) {
  const isEnabled = isFamilyEnabled ?? ((family: string) => ['codex', 'antigravity', 'claude'].includes(family));
  const providers = [...items].filter((item) => isEnabled(providerFamily(item.providerId))).sort(providerSort);
  const codex = providers.find((item) => providerFamily(item.providerId) === 'codex');
  const reset = codex?.resources.rateLimitResets;
  const resolvedReset = resolveResetCredits(reset, now);
  const resetCount = resolvedReset.availableCount;
  const expected = PROVIDER_CATALOG
    .filter((entry) => isEnabled(entry.family))
    .map((entry) => ({ id: entry.family, label: entry.name }));
  const missing = expected.filter((entry) => !providers.some((item) => providerFamily(item.providerId) === entry.id));
  const latest = items.reduce<string | undefined>((value, item) => !value || item.syncedAt > value ? item.syncedAt : value, undefined);
  const initial = userName.trim().slice(0, 1).toUpperCase() || 'AI';
  return <section className="home-screen">
    <header className="home-header"><div><div className="home-header__brand"><BeeMascot size={28} /><h1>蜂神榜 Ai 額度儀表板</h1></div><p>掌握使用情況，讓 AI 陪你走得更遠</p></div><button type="button" className="profile-avatar" aria-label={`帳號 ${userName}`} onClick={() => onNavigate({ route: 'settings' })}>{initial}</button></header>
    <button type="button" className="inspiration-card" onClick={() => onNavigate({ route: 'usage' })}><span className="leaf-mark" aria-hidden="true"><i /><i /></span><span><strong>善用 AI，創造更多可能</strong><small>合理分配 · 持續前進</small></span><b aria-hidden="true">›</b></button>
    {offline ? <div className="home-alert" role="alert"><strong>目前離線</strong><span>顯示最近取得的資料，恢復連線後會自動更新。</span></div> : null}
    {hasStale ? <div className="home-alert" role="alert"><strong>資料可能已過期</strong><span>Mac 最近沒有完成同步，以下保留最後成功資料。</span></div> : null}
    {readError ? <div className="home-alert home-alert--danger" role="alert"><strong>讀取失敗</strong><span>{readError}</span></div> : null}
    <section className="home-section"><div className="home-section__heading"><div><p>Quota overview</p><h2>額度使用情況</h2></div><span>{latest ? `更新 ${new Date(latest).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}` : '等待同步'}</span></div>
      {loading ? <div className="state-card">正在讀取額度…</div> : providers.length ? <><div className="provider-summary-grid">{providers.map((item) => <ProviderSummaryCard key={`${item.deviceId}:${item.providerId}`} snapshot={item} now={now} onOpen={() => onNavigate({ route: 'provider', providerId: item.providerId, deviceId: item.deviceId })} />)}</div>{missing.length ? <div className="missing-provider-grid">{missing.map((entry) => <section className="missing-provider-card" aria-label={`${entry.label} 尚未連接`} key={entry.id}><span className="provider-icon" data-family={entry.id} aria-hidden="true"><span /></span><div><strong>{entry.label}</strong><p>尚未收到可用的額度資料。請在 Mac 的 OpenUsage 啟用對應來源並確認登入，之後會自動同步。</p></div></section>)}</div> : null}</> : <div className="state-card"><strong>目前沒有可顯示的額度資料</strong><p>確認 Mac Companion 與資料來源正常後會自動出現。</p></div>}
    </section>
    <UsageSummaryCard items={historyItems} now={now} onOpen={() => onNavigate({ route: 'usage' })} />
    <section className="reset-teaser"><div className="reset-teaser__icon" aria-hidden="true">↻</div><div><span>Codex Reset Credits</span><strong>{reset ? (resolvedReset.total === 0 ? '0 張可用' : resolvedReset.availableCount > 0 ? `${resetCount} 張可用` : (resolvedReset.expiredCount > 0 ? '0 張可用（已過期）' : `${resetCount} 張可用`)) : '尚無資料'}</strong><small>{(() => {
      const nextAvailable = resolvedReset.items.find((i) => i.status === 'available')?.expiry;
      if (nextAvailable) return `最近到期 ${new Date(nextAvailable).toLocaleDateString('zh-TW')}`;
      const firstExpired = resolvedReset.items.find((i) => i.status === 'expired')?.expiry;
      if (firstExpired) return `已於 ${new Date(firstExpired).toLocaleDateString('zh-TW')} 到期`;
      return '到期資料依來源提供';
    })()}</small></div><button type="button" className="round-arrow" aria-label="查看重置額度" onClick={() => onNavigate({ route: 'resets' })}>›</button></section>
    <p className="home-privacy-note">Provider 憑證留在你的 Mac；雲端只同步最小化額度與使用統計。</p>
  </section>;
}
