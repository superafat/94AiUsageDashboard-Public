import { CliOpenUsageEngine, HttpOpenUsageEngine, type UsageEngine } from '@94ai/openusage';

export type AgentSetupErrorCode = 'engine_missing';

export class AgentSetupError extends Error {
  constructor(readonly code: AgentSetupErrorCode) {
    super(code);
    this.name = 'AgentSetupError';
  }
}

export async function selectUsageEngine(
  candidates: UsageEngine[] = [new CliOpenUsageEngine(), new HttpOpenUsageEngine()],
): Promise<UsageEngine> {
  for (const candidate of candidates) {
    const health = await candidate.health();
    if (health.state === 'ready') return candidate;
  }
  throw new AgentSetupError('engine_missing');
}

export async function readPreferredLimits(candidates?: UsageEngine[]): Promise<unknown> {
  const engine = await selectUsageEngine(candidates);
  return engine.readLimits();
}
