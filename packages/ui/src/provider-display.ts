import type { UsageSnapshot } from '@94ai/core';

export type ProviderFamily = 'codex' | 'antigravity' | 'claude' | 'other';

const LABELS: Record<string, Record<string, string>> = {
  codex: {
    session: '5 小時額度', weekly: '每週額度', spark: 'Spark 5 小時', sparkWeekly: 'Spark 每週',
    'gpt-reserve': 'gpt-reserve', gptReserve: 'gpt-reserve', reserve: 'gpt-reserve',
  },
  antigravity: {
    geminiSession: 'Gemini 5 小時', geminiWeekly: 'Gemini 每週',
    nonGeminiSession: '非 Gemini 5 小時', nonGeminiWeekly: '非 Gemini 每週',
  },
  claude: {
    session: '5 小時額度', weekly: '每週額度', fable: 'Fable 每週', sonnet: 'Sonnet 每週', extraUsage: '額外用量',
  },
};

const ORDER: Record<string, string[]> = {
  codex: ['session', 'weekly', 'spark', 'sparkWeekly', 'gpt-reserve', 'gptReserve', 'reserve', 'credits', 'creditValue'],
  antigravity: ['geminiSession', 'geminiWeekly', 'nonGeminiSession', 'nonGeminiWeekly'],
  claude: ['session', 'weekly', 'fable', 'sonnet', 'extraUsage'],
};

export function providerFamily(providerId: string): ProviderFamily {
  const id = providerId.toLowerCase();
  if (id === 'codex' || id.startsWith('codex@')) return 'codex';
  if (id === 'antigravity' || id.startsWith('antigravity@')) return 'antigravity';
  if (id === 'claude' || id.startsWith('claude@')) return 'claude';
  return 'other';
}

export function providerName(snapshot: UsageSnapshot): string {
  const family = providerFamily(snapshot.providerId);
  if (family === 'codex') return 'Codex';
  if (family === 'antigravity') return 'Antigravity';
  if (family === 'claude') return 'Claude Code';
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
