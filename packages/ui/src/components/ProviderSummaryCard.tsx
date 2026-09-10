import type { UsageSnapshot } from '@94ai/core';
import { formatCountdown, formatResourceRemaining, safeDiagnosticText } from '@94ai/core';
import { providerFamily, providerName } from '../provider-display';

const PRIORITY: Record<string, Array<{ key: string; label: string }>> = {
  codex: [{ key: 'session', label: '5 小時額度' }, { key: 'weekly', label: '每週額度' }],
  antigravity: [{ key: 'geminiSession', label: 'Gemini 5 小時' }, { key: 'geminiWeekly', label: 'Gemini 每週' }],
  claude: [{ key: 'session', label: '5 小時額度' }, { key: 'weekly', label: '每週額度' }],
};

export function ProviderSummaryCard({ snapshot, now, onOpen }: { snapshot: UsageSnapshot; now: Date; onOpen: () => void }) {
  const family = providerFamily(snapshot.providerId);
  const rows = (PRIORITY[family] ?? []).flatMap(({ key, label }) => snapshot.resources[key] ? [{ key, label, resource: snapshot.resources[key]! }] : []);
  const safeError = safeDiagnosticText(snapshot.errorSummary);
  return <section className="provider-summary" data-family={family} aria-label={`${providerName(snapshot)} 額度`}>
    <header className="provider-summary__header"><div className="provider-summary__identity"><span className="provider-icon" data-family={family} aria-hidden="true"><span /></span><div><h3>{providerName(snapshot)}</h3>{snapshot.plan ? <small>{snapshot.plan}</small> : null}</div></div><button type="button" className="round-arrow" aria-label={`查看 ${providerName(snapshot)} 詳情`} onClick={onOpen}>›</button></header>
    <div className="provider-summary__rows">{rows.length ? rows.map(({ key, label, resource }) => {
      const formatted = formatResourceRemaining(resource);
      const width = formatted.percentage !== undefined ? Math.max(0, Math.min(100, formatted.percentage)) : 0;
      return <div className="quota-summary-row" key={key}>
        <div><span>{label}</span>{resource.resetsAt ? <small>重置 {formatCountdown(resource.resetsAt, now)}</small> : <small>重置時間未提供</small>}</div>
        <div className="quota-summary-row__value"><strong>{formatted.text}</strong>{formatted.unit ? <span>{formatted.unit}</span> : null}</div>
        {formatted.percentage !== undefined ? <div className="quota-mini-progress" aria-label={`${label}剩餘 ${formatted.text}`}><span style={{ width: `${width}%` }} /></div> : null}
      </div>;
    }) : <p className="provider-summary__empty">來源已連接，但目前沒有可顯示的額度資料</p>}</div>
  {safeError ? <p className="provider-summary__warning">{safeError}</p> : null}</section>;
}
