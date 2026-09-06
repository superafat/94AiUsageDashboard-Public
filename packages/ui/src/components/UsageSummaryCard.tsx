import { summarizeHistory, type UsageHistorySnapshot } from '@94ai/core';

function tokenLabel(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

export function UsageSummaryCard({ items, now, onOpen }: { items: UsageHistorySnapshot[]; now: Date; onOpen: () => void }) {
  const summaries = items.map((item) => summarizeHistory(item, '7d', now)).filter((item) => item.daysWithData > 0 || item.tokens > 0);
  const tokens = summaries.reduce((sum, item) => sum + item.tokens, 0);
  const costComplete = summaries.length > 0 && summaries.every((item) => item.costComplete);
  const cost = costComplete ? summaries.reduce((sum, item) => sum + (item.estimatedCostUsd ?? 0), 0) : undefined;
  return <section className="usage-summary-card" aria-label="近 7 天 AI 使用">
    <div className="usage-summary-card__icon" aria-hidden="true"><span /><span /><span /></div>
    <div className="usage-summary-card__body"><span>近 7 天 AI 使用</span><strong>{tokenLabel(tokens)} <small>tokens</small></strong><p>{cost === undefined ? '費用資料累積中' : `估算 API 等值費用約 US$${cost.toFixed(2)}`}</p></div>
    <button type="button" className="round-arrow" aria-label="查看使用統計" onClick={onOpen}>›</button>
  </section>;
}
