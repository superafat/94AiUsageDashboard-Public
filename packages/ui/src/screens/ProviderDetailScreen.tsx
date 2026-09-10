import type { AppLocation } from '@94ai/client';
import { safeDiagnosticText, type UsageSnapshot } from '@94ai/core';
import { QuotaCard } from '../components/QuotaCard';
import { ResetCreditList } from '../components/ResetCreditList';
import { providerFamily, providerName, resourceEntries } from '../provider-display';

export interface ProviderDetailScreenProps {
  snapshot: UsageSnapshot;
  historyError?: string | undefined;
  historyStale?: boolean | undefined;
  now?: Date;
  onNavigate: (location: AppLocation) => void;
}

export function ProviderDetailScreen({
  snapshot,
  historyError,
  historyStale,
  now = new Date(),
  onNavigate,
}: ProviderDetailScreenProps) {
  const name = providerName(snapshot);
  const entries = resourceEntries(snapshot);
  const reset = providerFamily(snapshot.providerId) === 'codex' ? snapshot.resources.rateLimitResets : undefined;
  const safeError = safeDiagnosticText(snapshot.errorSummary);
  return <section className="product-screen provider-detail-screen">
    <button type="button" className="back-button" onClick={() => onNavigate({ route: 'dashboard' })}>‹ <span>返回首頁</span></button>
    <header className="provider-detail-header">
      <span className="provider-icon provider-icon--large" data-family={providerFamily(snapshot.providerId)} aria-hidden="true"><span /></span>
      <div>
        <p className="screen-eyebrow">Provider detail</p>
        <h1>{name}</h1>
        <div className="provider-detail-meta">
          {snapshot.plan ? <span>{snapshot.plan}</span> : null}
          <span className="device-badge">{snapshot.deviceId}</span>
        </div>
      </div>
    </header>
    {safeError ? <div className="home-alert"><strong>資料來源回報</strong><span>{safeError}</span></div> : null}
    {historyError ? <div className="home-alert home-alert--danger" role="alert"><strong>歷史記錄讀取失敗</strong><span>{historyError}</span></div> : null}
    {historyStale ? <div className="home-alert" role="alert"><strong>歷史資料可能已過期</strong><span>最近沒有完成歷史資料同步。</span></div> : null}

    <section className="section"><div className="section-title-row"><div><p className="screen-eyebrow">Quota</p><h2>完整額度</h2></div></div><div className="quota-grid">{entries.length ? entries.map((entry) => <QuotaCard key={entry.key} label={entry.label} providerLabel={name} resource={entry.resource} now={now} />) : <p className="empty-inline">來源已連接，但目前沒有可顯示的額度資料</p>}</div></section>
    {reset ? <section className="section"><div className="section-title-row"><div><p className="screen-eyebrow">Read-only</p><h2>手動重置額度</h2></div></div><ResetCreditList resource={reset} now={now} /><div className="info-note"><strong>目前僅供查看</strong><span>使用功能會在獨立安全版本加入二次確認與防重複消耗機制後開放。</span></div></section> : null}
  </section>;
}
