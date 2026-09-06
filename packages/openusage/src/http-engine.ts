import { fetchOpenUsageLimits } from './client';
import { isLimitsEnvelope, type EngineHealth, type UsageEngine } from './engine';

export type LimitsReader = () => Promise<unknown>;

export class HttpOpenUsageEngine implements UsageEngine {
  readonly kind = 'http' as const;
  constructor(private readonly read: LimitsReader = () => fetchOpenUsageLimits()) {}

  async health(): Promise<EngineHealth> {
    let value: unknown;
    try { value = await this.read(); }
    catch { return { state: 'missing', kind: this.kind, detailCode: 'http_unreachable' }; }
    return isLimitsEnvelope(value)
      ? { state: 'ready', kind: this.kind, detailCode: 'http_reachable' }
      : { state: 'error', kind: this.kind, detailCode: 'http_invalid_response' };
  }

  async readLimits(): Promise<unknown> {
    const value = await this.read();
    if (!isLimitsEnvelope(value)) throw new Error('http_invalid_response');
    return value;
  }
}
