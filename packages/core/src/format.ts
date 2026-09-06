export function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '無資料';
  return `${Math.round(value)}%`;
}

export function formatCountdown(iso: string | undefined, now = new Date()): string {
  if (!iso) return '無資料';
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return '無資料';
  let minutes = Math.floor((target - now.getTime()) / 60_000);
  if (minutes <= 0) return '已重置';
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
