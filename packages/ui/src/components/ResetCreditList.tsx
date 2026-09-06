import { formatCountdown, type UsageResource } from '@94ai/core';
import { StatusPill } from './StatusPill';

export function ResetCreditList({ resource }: { resource: UsageResource | undefined }) {
  if (!resource || resource.kind !== 'balance' || resource.available <= 0) {
    return <p className="empty-inline">目前沒有可用的手動重置額度</p>;
  }
  const count = Math.floor(resource.available);
  return (
    <div className="reset-list" aria-label="手動重置額度，只讀">
      {Array.from({ length: count }, (_, index) => {
        const expiry = resource.expiries?.[index];
        return (
          <div className="reset-row" key={`${index}-${expiry ?? 'unknown'}`}>
            <strong>#{String(index + 1).padStart(3, '0')}</strong>
            <StatusPill label="可用" />
            <span>{expiry ? formatCountdown(expiry) : '期限資料未提供'}</span>
          </div>
        );
      })}
    </div>
  );
}
