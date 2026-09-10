import { formatCountdown, formatResourceRemaining, type UsageResource } from '@94ai/core';

export function QuotaCard({
  label,
  providerLabel,
  resource,
  now = new Date(),
}: {
  label: string;
  providerLabel: string;
  resource: UsageResource;
  now?: Date;
}) {
  const formatted = formatResourceRemaining(resource);
  const tone = formatted.tone;
  const percentage = formatted.percentage;
  const width = percentage === undefined ? 0 : Math.max(0, Math.min(100, percentage));

  if (resource.kind === 'balance') {
    return (
      <article className="quota-card" data-tone="neutral">
        <div className="quota-card__top">
          <div>
            <p className="quota-card__eyebrow">{providerLabel}</p>
            <h3>{label}</h3>
          </div>
          <div className="quota-card__value">
            <strong>{formatted.text}</strong>
            {formatted.unit ? <span>{formatted.unit}</span> : null}
          </div>
        </div>
        <p className="quota-card__meta">
          {resource.resetsAt
            ? `重置：${new Date(resource.resetsAt).toLocaleString('zh-TW', { hour12: false })} · ${formatCountdown(resource.resetsAt, now)}`
            : '餘額資料'}
        </p>
      </article>
    );
  }

  return (
    <article className="quota-card" data-tone={tone}>
      <div className="quota-card__top">
        <div>
          <p className="quota-card__eyebrow">{providerLabel}</p>
          <h3>{label}</h3>
        </div>
        <div className="quota-card__value">
          <strong>{formatted.text}</strong>
          {formatted.unit ? <span>{formatted.unit}</span> : null}
        </div>
      </div>
      {percentage !== undefined ? (
        <div className="quota-progress" aria-label={`${label}剩餘 ${formatted.text}`}>
          <span style={{ width: `${width}%` }} />
        </div>
      ) : null}
      <p className="quota-card__meta">
        {resource.resetsAt
          ? `重置：${new Date(resource.resetsAt).toLocaleString('zh-TW', { hour12: false })} · ${formatCountdown(resource.resetsAt, now)}`
          : '重置時間：無資料'}
      </p>
    </article>
  );
}
