import { useMemo, useState } from 'react';
import { summarizeHistory, type UsageHistorySnapshot, type UsagePeriod } from '@94ai/core';
import { PeriodSelector } from '../components/PeriodSelector';
import { UsageTrendChart } from '../components/UsageTrendChart';
import { providerFamily } from '../provider-display';

function providerLabel(providerId: string): string {
  const family = providerFamily(providerId);
  if (family === 'codex') return 'Codex';
  if (family === 'antigravity') return 'Antigravity';
  if (family === 'claude') return 'Claude Code';
  return providerId;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 1 : 2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 100_000_000 ? 1 : 2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function recentDates(now: Date, count: number): Set<string> {
  return new Set(Array.from({ length: count }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - index, 12);
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  }));
}

function combinedDaily(items: UsageHistorySnapshot[], period: UsagePeriod, now: Date) {
  const count = period === '1d' ? 1 : period === '7d' ? 7 : 30;
  const dates = recentDates(now, count);
  const totals = new Map<string, number>();
  for (const item of items) for (const day of item.daily) if (dates.has(day.date)) totals.set(day.date, (totals.get(day.date) ?? 0) + day.tokens);
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, tokens]) => ({ date, tokens, finalized: date !== [...dates][0] }));
}

export function UsageStatsScreen({ items, now }: { items: UsageHistorySnapshot[]; now: Date }) {
  const [period, setPeriod] = useState<UsagePeriod>('7d');
  const rows = useMemo(() => items.map((item) => ({ item, summary: summarizeHistory(item, period, now) })), [items, period, now]);
  const relevant = rows.filter((row) => row.summary.daysWithData > 0 || row.summary.tokens > 0);
  const tokens = relevant.reduce((sum, row) => sum + row.summary.tokens, 0);
  const costComplete = relevant.length > 0 && relevant.every((row) => row.summary.costComplete);
  const cost = costComplete ? relevant.reduce((sum, row) => sum + (row.summary.estimatedCostUsd ?? 0), 0) : undefined;
  const main = [...relevant].sort((a, b) => b.summary.tokens - a.summary.tokens)[0];
  const trend = combinedDaily(items, period, now);

  return <section className="product-screen usage-stats-screen">
    <header className="screen-heading"><div><p className="screen-eyebrow">AI 使用歷史</p><h1>使用統計</h1><p>掌握 Token 用量與 API 等值估算費用。</p></div></header>
    <PeriodSelector value={period} onChange={setPeriod} />
    <div className="stats-summary-grid">
      <section className="metric-summary" aria-label="Token 使用量"><span>Token 使用量</span><strong>{formatTokens(tokens)}</strong><small>tokens</small></section>
      <section className="metric-summary metric-summary--cost" aria-label="估算 API 等值費用"><span>估算 API 等值費用</span><strong>{cost === undefined ? '費用資料累積中' : `US$${cost.toFixed(2)}`}</strong><small>依本機使用紀錄與模型價格估算</small></section>
      <section className="metric-summary" aria-label="主要使用來源"><span>主要使用來源</span><strong>{main ? providerLabel(main.item.providerId) : '尚無資料'}</strong><small>{main ? `${formatTokens(main.summary.tokens)} tokens` : '等待 Mac 同步'}</small></section>
    </div>
    {trend.length ? <UsageTrendChart daily={trend} /> : <div className="state-card">尚無歷史資料</div>}
    <section className="history-breakdown"><div className="section-title-row"><div><p className="screen-eyebrow">Providers</p><h2>來源分布</h2></div></div>
      <div className="history-provider-grid">{relevant.length ? relevant.map(({ item, summary }) => <article className="history-provider-card" key={`${item.deviceId}:${item.providerId}`}><div><span className="provider-dot" data-family={providerFamily(item.providerId)} /><strong>{providerLabel(item.providerId)}</strong></div><strong>{formatTokens(summary.tokens)}</strong><span>{summary.estimatedCostUsd === undefined ? '費用資料累積中' : `約 US$${summary.estimatedCostUsd.toFixed(2)}`}</span></article>) : <p className="empty-inline">尚無歷史資料</p>}</div>
    </section>
  </section>;
}
