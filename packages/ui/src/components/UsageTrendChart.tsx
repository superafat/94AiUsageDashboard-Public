import type { DailyUsageAggregate } from '@94ai/core';

function compact(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 0 : 1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 100_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(Math.round(value));
}

export function UsageTrendChart({ daily }: { daily: DailyUsageAggregate[] }) {
  const values = daily.map((item) => item.tokens);
  const max = Math.max(1, ...values);
  const total = values.reduce((sum, value) => sum + value, 0);
  const min = values.length ? Math.min(...values) : 0;
  return <figure className="usage-trend" aria-label={`每日 Token 使用趨勢，共 ${compact(total)} tokens，最低 ${compact(min)}，最高 ${compact(max)}`} role="img">
    <div className="usage-trend__bars" aria-hidden="true">
      {daily.map((item) => <span key={item.date} title={`${item.date} · ${compact(item.tokens)} tokens`} style={{ height: `${Math.max(4, (item.tokens / max) * 100)}%` }} />)}
    </div>
    <figcaption><span>{daily.at(0)?.date.slice(5).replace('-', '/') ?? '—'}</span><strong>Token 趨勢</strong><span>{daily.at(-1)?.date.slice(5).replace('-', '/') ?? '—'}</span></figcaption>
  </figure>;
}
