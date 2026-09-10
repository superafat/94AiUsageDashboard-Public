import type { UsageSnapshot } from '@94ai/core';
import { resolveResetCredits } from '@94ai/core';
import { ResetCreditList } from '../components/ResetCreditList';
import { providerFamily } from '../provider-display';

export function ResetCreditsScreen({ items, now = new Date() }: { items: UsageSnapshot[]; now?: Date }) {
  const codex = items.find((item) => providerFamily(item.providerId) === 'codex');
  const resource = codex?.resources.rateLimitResets;
  const resolved = resolveResetCredits(resource, now);
  return <section className="product-screen reset-screen">
    <header className="screen-heading"><div><p className="screen-eyebrow">{codex ? 'Codex' : 'Reset Credits'}</p><h1>重置額度</h1><p>查看免費 Reset Credits 與到期時間。</p></div></header>
    <section className="reset-hero"><span className="reset-hero__icon" aria-hidden="true">↻</span><div><span>目前可用</span><strong>{codex ? resolved.availableCount : 0}</strong><small>{codex ? `張 Reset Credit${resolved.expiredCount > 0 ? `（另有 ${resolved.expiredCount} 張已過期）` : ''}` : '尚無已啟用的來源'}</small></div></section>
    <section className="section"><div className="section-title-row"><div><p className="screen-eyebrow">Read-only</p><h2>可用額度</h2></div></div><ResetCreditList resource={codex ? resource : undefined} now={now} /></section>
    <div className="info-note"><strong>目前僅供查看</strong><span>使用 Reset Credit 屬於不可逆操作，會在獨立安全版本加入二次確認後才開放。</span></div>
  </section>;
}
