export type EngineKind = 'cli' | 'http';

export type EngineHealth =
  | { state: 'ready'; kind: EngineKind; detailCode: string }
  | { state: 'missing'; kind?: EngineKind; detailCode: string }
  | { state: 'error'; kind: EngineKind; detailCode: string };

export interface UsageEngine {
  readonly kind: EngineKind;
  health(): Promise<EngineHealth>;
  readLimits(options?: { force?: boolean }): Promise<unknown>;
}

export function isLimitsEnvelope(value: unknown): value is { schema: 'openusage.limits.v1'; providers: Record<string, unknown>; errors?: unknown[] } {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).schema === 'openusage.limits.v1'
    && Boolean((value as Record<string, unknown>).providers)
    && typeof (value as Record<string, unknown>).providers === 'object'
    && !Array.isArray((value as Record<string, unknown>).providers);
}

export { HttpOpenUsageEngine } from './http-engine';
