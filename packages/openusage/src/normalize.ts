import {
  classifyDiagnostic,
  isSnapshotStale,
  parseUsageResource,
  parseUsageSnapshot,
  type UsageResource,
  type UsageSnapshot,
} from '@94ai/core';

interface NormalizeContext {
  userId: string;
  deviceId: string;
  syncedAt: string;
  now?: number | Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return undefined;
  return value;
}

function normalizeResource(value: unknown): UsageResource | undefined {
  if (!isRecord(value) || typeof value.unit !== 'string') return undefined;
  const resetsAt = typeof value.resetsAt === 'string' ? value.resetsAt : undefined;
  const expiries = stringArray(value.expiries ?? value.expiresAt);

  if (value.kind === 'consumption') {
    const used = finiteNonNegative(value.used);
    const limit = finiteNonNegative(value.limit);
    const remaining = finiteNonNegative(value.remaining);
    if (used === undefined && limit === undefined && remaining === undefined) return undefined;
    return {
      kind: 'consumption',
      unit: value.unit,
      ...(used === undefined ? {} : { used }),
      ...(limit === undefined ? {} : { limit }),
      ...(remaining === undefined ? {} : { remaining }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(expiries === undefined ? {} : { expiries }),
    };
  }

  if (value.kind === 'balance') {
    const available = finiteNonNegative(value.available);
    if (available === undefined) return undefined;
    return {
      kind: 'balance',
      unit: value.unit,
      available,
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(expiries === undefined ? {} : { expiries }),
    };
  }

  return undefined;
}

function providerErrors(input: unknown): Map<string, string> {
  const result = new Map<string, string>();
  if (!Array.isArray(input)) return result;
  for (const entry of input) {
    if (!isRecord(entry) || typeof entry.providerId !== 'string') continue;
    const classified = classifyDiagnostic(entry.message);
    if (classified) {
      result.set(entry.providerId, classified);
    }
  }
  return result;
}

export function normalizeOpenUsageLimits(input: unknown, ctx: NormalizeContext): UsageSnapshot[] {
  if (!isRecord(input) || input.schema !== 'openusage.limits.v1' || !isRecord(input.providers)) {
    throw new Error('invalid OpenUsage limits envelope');
  }

  const errors = providerErrors(input.errors);
  const snapshots: UsageSnapshot[] = [];
  const effectiveNow = ctx.now !== undefined
    ? (typeof ctx.now === 'number' ? ctx.now : ctx.now.getTime())
    : Date.parse(ctx.syncedAt);

  for (const [providerId, rawProvider] of Object.entries(input.providers)) {
    if (!isRecord(rawProvider) || !isRecord(rawProvider.resources)) continue;
    if (typeof rawProvider.fetchedAt !== 'string' || typeof rawProvider.expiresAt !== 'string') continue;

    const resources: Record<string, UsageResource> = {};
    for (const [key, rawResource] of Object.entries(rawProvider.resources)) {
      const resource = normalizeResource(rawResource);
      if (resource) {
        try { resources[key] = parseUsageResource(resource, key); }
        catch { /* Unknown or invalid fields must not break healthy quota resources. */ }
      }
    }

    const errorSummary = errors.get(providerId);
    const preliminarySnapshot: UsageSnapshot = {
      schemaVersion: 1,
      userId: ctx.userId,
      deviceId: ctx.deviceId,
      providerId,
      ...(typeof rawProvider.plan === 'string' ? { plan: rawProvider.plan } : {}),
      fetchedAt: rawProvider.fetchedAt,
      syncedAt: ctx.syncedAt,
      expiresAt: rawProvider.expiresAt,
      stale: typeof rawProvider.stale === 'boolean' ? rawProvider.stale : false,
      resources,
      sourceVersion: input.schema,
      ...(errorSummary ? { errorSummary } : {}),
    };

    const stale = isSnapshotStale(preliminarySnapshot, effectiveNow);


    try {
      snapshots.push(parseUsageSnapshot({
        ...preliminarySnapshot,
        stale,
      }));
    } catch {
      // Preserve the last-good cloud document for this provider and continue the others.
      continue;
    }
  }

  return snapshots;
}
