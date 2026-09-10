import type { UsageResource } from './schema';

export function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '無資料';
  return `${Math.round(value)}%`;
}

export function formatCountdown(
  iso: string | undefined,
  now = new Date(),
  options?: { elapsedLabel?: string },
): string {
  if (!iso) return '無資料';
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return '無資料';
  const diffMs = target - now.getTime();
  if (diffMs <= 0) return options?.elapsedLabel ?? '待刷新';
  if (diffMs < 60_000) {
    const seconds = Math.max(1, Math.floor(diffMs / 1000));
    return `${seconds}s`;
  }
  let minutes = Math.floor(diffMs / 60_000);
  const days = Math.floor(minutes / 1_440);
  minutes -= days * 1_440;
  const hours = Math.floor(minutes / 60);
  minutes -= hours * 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(' ');
}

export function formatTokens(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '無資料';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(value >= 10_000_000_000 ? 1 : 2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 100_000_000 ? 1 : 2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

export interface FormattedRemaining {
  text: string;
  unit?: string | undefined;
  percentage?: number | undefined;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
}

export function formatResourceRemaining(resource: UsageResource): FormattedRemaining {
  if (resource.kind === 'balance') {
    return {
      text: String(resource.available),
      unit: resource.unit,
      percentage: undefined,
      tone: 'neutral',
    };
  }

  let rem = resource.remaining;
  if (rem === undefined && resource.limit !== undefined && resource.used !== undefined) {
    rem = Math.max(0, resource.limit - resource.used);
  }
  if (rem === undefined || !Number.isFinite(rem)) {
    return { text: '無資料', tone: 'neutral' };
  }

  if (resource.unit === 'percent') {
    const percentage = Math.max(0, Math.min(100, rem));
    const tone = percentage <= 10 ? 'danger' : percentage <= 30 ? 'warning' : 'success';
    return {
      text: `${Math.round(rem)}%`,
      unit: '剩餘',
      percentage,
      tone,
    };
  }

  let percentage: number | undefined;
  if (resource.limit !== undefined && resource.limit > 0) {
    percentage = Math.max(0, Math.min(100, (rem / resource.limit) * 100));
  }
  const tone = percentage === undefined ? 'neutral' : percentage <= 10 ? 'danger' : percentage <= 30 ? 'warning' : 'success';

  if (resource.unit === 'tokens') {
    return {
      text: formatTokens(rem),
      unit: 'tokens',
      percentage,
      tone,
    };
  }

  return {
    text: String(Math.round(rem * 100) / 100),
    unit: resource.unit,
    percentage,
    tone,
  };
}

export interface ResolvedResetCreditItem {
  index: number;
  expiry?: string | undefined;
  status: 'available' | 'expired' | 'unknown';
  statusLabel: string;
  statusTone: 'success' | 'danger' | 'neutral';
  expiryLabel: string;
}

export interface ResolvedResetCredits {
  total: number;
  availableCount: number;
  expiredCount: number;
  unknownCount: number;
  items: ResolvedResetCreditItem[];
  capped: boolean;
  maxRendered: number;
}

export const MAX_RESET_CREDITS_RENDERED = 50;

export function resolveResetCredits(
  resource: UsageResource | undefined,
  now = new Date(),
  maxRendered = MAX_RESET_CREDITS_RENDERED,
): ResolvedResetCredits {
  if (!resource || resource.kind !== 'balance' || resource.available <= 0) {
    return {
      total: 0,
      availableCount: 0,
      expiredCount: 0,
      unknownCount: 0,
      items: [],
      capped: false,
      maxRendered,
    };
  }

  const total = Math.max(0, Math.floor(resource.available));
  const expiries = resource.expiries ?? [];
  const evidenceCount = Math.min(total, expiries.length);
  const renderLimit = Math.min(total, Math.max(0, Math.floor(maxRendered)));
  let expiredCount = 0;
  let unknownCount = total - evidenceCount;
  const items: ResolvedResetCreditItem[] = [];

  const resolveItem = (index: number, expiry: string | undefined): ResolvedResetCreditItem => {
    let status: 'available' | 'expired' | 'unknown' = 'unknown';
    let statusLabel = '未提供期限';
    let statusTone: 'success' | 'danger' | 'neutral' = 'neutral';
    let expiryLabel = '期限資料未提供';

    if (expiry) {
      const parsedTime = Date.parse(expiry);
      if (Number.isFinite(parsedTime)) {
        if (parsedTime <= now.getTime()) {
          status = 'expired';
          statusLabel = '已過期';
          statusTone = 'danger';
          expiryLabel = `已於 ${new Date(parsedTime).toLocaleDateString('zh-TW')} 到期`;
        } else {
          status = 'available';
          statusLabel = '可用';
          statusTone = 'success';
          expiryLabel = formatCountdown(expiry, now);
        }
      }
    } else if (expiries.length === 0) {
      status = 'available';
      statusLabel = '可用';
      statusTone = 'success';
    }

    return { index, expiry, status, statusLabel, statusTone, expiryLabel };
  };

  for (let i = 0; i < evidenceCount; i++) {
    const item = resolveItem(i, expiries[i]);
    if (item.status === 'expired') expiredCount++;
    else if (item.status === 'unknown') unknownCount++;
    if (i < renderLimit) items.push(item);
  }

  for (let i = evidenceCount; i < renderLimit; i++) {
    items.push(resolveItem(i, undefined));
  }

  return {
    total,
    availableCount: Math.max(0, total - expiredCount),
    expiredCount,
    unknownCount,
    items,
    capped: total > maxRendered,
    maxRendered,
  };
}
