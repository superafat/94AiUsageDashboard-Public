import {
  isKnownProviderFamily,
  providerFamilyOf,
  FAMILY_DISPLAY_NAMES,
  RESOURCE_DISPLAY_LABELS,
  type KnownProviderFamily,
  type UsageSnapshot,
} from '@94ai/core';

export type ProviderFamily = KnownProviderFamily | 'other';

export { FAMILY_DISPLAY_NAMES };

const LABELS: Record<string, Record<string, string>> = RESOURCE_DISPLAY_LABELS;

const ORDER: Record<string, string[]> = {
  codex: ['session', 'weekly', 'spark', 'sparkWeekly', 'gpt-reserve', 'gptReserve', 'reserve', 'credits', 'creditValue'],
  antigravity: ['geminiSession', 'geminiWeekly', 'nonGeminiSession', 'nonGeminiWeekly'],
  claude: ['session', 'weekly', 'fable', 'sonnet', 'extraUsage'],
};

export function providerFamily(providerId: string): ProviderFamily {
  const base = providerFamilyOf(providerId);
  if (isKnownProviderFamily(base)) return base;
  return 'other';
}

export function providerName(snapshot: UsageSnapshot): string {
  const family = providerFamily(snapshot.providerId);
  if (family !== 'other') return FAMILY_DISPLAY_NAMES[family];
  return snapshot.providerId;
}

export function resourceEntries(snapshot: UsageSnapshot) {
  const family = providerFamily(snapshot.providerId);
  const labels = LABELS[family] ?? {};
  const preferred = ORDER[family] ?? [];
  const keys = [...preferred.filter((key) => key in snapshot.resources), ...Object.keys(snapshot.resources).filter((key) => !preferred.includes(key) && key !== 'rateLimitResets')];
  return keys.map((key) => ({ key, label: labels[key] ?? key, resource: snapshot.resources[key]! }));
}

export function providerSort(a: UsageSnapshot, b: UsageSnapshot): number {
  const order: ProviderFamily[] = ['codex', 'antigravity', 'claude', 'other'];
  return order.indexOf(providerFamily(a.providerId)) - order.indexOf(providerFamily(b.providerId));
}
