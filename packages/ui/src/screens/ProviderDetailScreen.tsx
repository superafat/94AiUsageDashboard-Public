import type { AppLocation } from '@94ai/client';
import type { UsageSnapshot } from '@94ai/core';
import { QuotaCard } from '../components/QuotaCard';
import { ResetCreditList } from '../components/ResetCreditList';
import { providerFamily, providerName, resourceEntries } from '../provider-display';

export function ProviderDetailScreen({ snapshot, onNavigate }: { snapshot: UsageSnapshot; onNavigate: (location: AppLocation) => void }) {
  const name = providerName(snapshot);
  const entries = resourceEntries(snapshot);
  const reset = providerFamily(snapshot.providerId) === 'codex' ? snapshot.resources.rateLimitResets : undefined;
  return <section className="product-screen provider-detail-screen">
    <button type="button" className="back-button" onClick={() => onNavigate({ route: 'dashboard' })}>‹ <span>返回首頁</span></button>
    <header className="provider-detail-header"><span className="provider-icon provider-icon--large" data-family={providerFamily(snapshot.providerId)} aria-hidden="true"><span /></span><div><p className="screen-eyebrow">Provider detail</p><h1>{name}</h1>{snapshot.plan ? <span>{snapshot.plan}</span> : null}</div></header>
    {snapshot.errorSummary ? <div className="home-alert"><strong>資料來源回報</strong><span>{snapshot.errorSummary}</span></div> : null}
    <section className="section"><div className="section-title-row"><div><p className="screen-eyebrow">Quota</p><h2>完整額度</h2></div></div><div className="quota-grid">{entries.length ? entries.map((entry) => <QuotaCard key={entry.key} label={entry.label} providerLabel={name} resource={entry.resource} />) : <p className="empty-inline">來源已連接，但目前沒有可顯示的額度資料</p>}</div></section>
    {reset ? <section className="section"><div className="section-title-row"><div><p className="screen-eyebrow">Read-only</p><h2>手動重置額度</h2></div></div><ResetCreditList resource={reset} /><div className="info-note"><strong>目前僅供查看</strong><span>使用功能會在獨立安全版本加入二次確認與防重複消耗機制後開放。</span></div></section> : null}
  </section>;
}
