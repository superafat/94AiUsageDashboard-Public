import { resolveResetCredits, type UsageResource } from '@94ai/core';
import { StatusPill } from './StatusPill';

export function ResetCreditList({
  resource,
  now = new Date(),
}: {
  resource: UsageResource | undefined;
  now?: Date;
}) {
  const resolved = resolveResetCredits(resource, now);
  if (resolved.total <= 0) {
    return <p className="empty-inline">目前沒有可用的手動重置額度</p>;
  }
  return (
    <div className="reset-list" aria-label="手動重置額度，只讀">
      {resolved.items.map((item) => (
        <div className="reset-row" key={`${item.index}-${item.expiry ?? 'unknown'}`}>
          <strong>#{String(item.index + 1).padStart(3, '0')}</strong>
          <StatusPill label={item.statusLabel} tone={item.statusTone} />
          <span>{item.expiryLabel}</span>
        </div>
      ))}
      {resolved.capped ? (
        <p className="reset-list__overflow">
          僅顯示前 {resolved.maxRendered} 筆手動重置額度（共 {resolved.total} 筆）
        </p>
      ) : null}
    </div>
  );
}
