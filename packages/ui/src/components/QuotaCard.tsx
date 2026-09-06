import { formatCountdown, formatPercent, type UsageResource } from '@94ai/core';

export function QuotaCard({ label, providerLabel, resource }: { label: string; providerLabel: string; resource: UsageResource }) {
  if (resource.kind === 'balance') {
    return (
      <article className="quota-card" data-tone="neutral">
        <div className="quota-card__top"><div><p className="quota-card__eyebrow">{providerLabel}</p><h3>{label}</h3></div>
          <div className="quota-card__value"><strong>{resource.available}</strong><span>{resource.unit}</span></div></div>
        <p className="quota-card__meta">{resource.resetsAt ? `重置：${new Date(resource.resetsAt).toLocaleString('zh-TW', { hour12: false })} · ${formatCountdown(resource.resetsAt)}` : '餘額資料'}</p>
      </article>
    );
  }
  const remaining = resource.remaining;
  const tone = remaining === undefined ? 'neutral' : remaining <= 10 ? 'danger' : remaining <= 30 ? 'warning' : 'success';
  const width = remaining === undefined ? 0 : Math.max(0, Math.min(100, remaining));
  return (
    <article className="quota-card" data-tone={tone}>
      <div className="quota-card__top"><div><p className="quota-card__eyebrow">{providerLabel}</p><h3>{label}</h3></div>
        <div className="quota-card__value"><strong>{formatPercent(remaining)}</strong>{remaining === undefined ? null : <span>剩餘</span>}</div></div>
      {resource.unit === 'percent' && remaining !== undefined ? <div className="quota-progress" aria-label={`${label}剩餘 ${formatPercent(remaining)}`}><span style={{ width: `${width}%` }} /></div> : null}
      <p className="quota-card__meta">{resource.resetsAt ? `重置：${new Date(resource.resetsAt).toLocaleString('zh-TW', { hour12: false })} · ${formatCountdown(resource.resetsAt)}` : '重置時間：無資料'}</p>
    </article>
  );
}
