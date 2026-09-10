import { ALLOWED_DIAGNOSTICS, SENSITIVE_PATTERN } from './diagnostics';

export type UsageResource =
  | { kind: 'consumption'; unit: string; used?: number; limit?: number; remaining?: number; resetsAt?: string; expiries?: string[] }
  | { kind: 'balance'; unit: string; available: number; resetsAt?: string; expiries?: string[] };

export interface UsageSnapshot {
  schemaVersion: 1;
  userId: string;
  deviceId: string;
  providerId: string;
  plan?: string;
  fetchedAt: string;
  syncedAt: string;
  expiresAt: string;
  stale: boolean;
  resources: Record<string, UsageResource>;
  sourceVersion?: string;
  errorSummary?: string;
}

const SNAPSHOT_FIELDS = new Set([
  'schemaVersion', 'userId', 'deviceId', 'providerId', 'plan', 'fetchedAt', 'syncedAt',
  'expiresAt', 'stale', 'resources', 'sourceVersion', 'errorSummary',
]);
const RESOURCE_FIELDS = new Set(['kind', 'unit', 'used', 'limit', 'remaining', 'available', 'resetsAt', 'expiries']);


function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && (d.getUTCMonth() + 1) === month && d.getUTCDate() === day;
}

const ISO_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/;

function isoDate(value: unknown, label: string): string {
  const result = string(value, label);
  const match = ISO_DATE_PREFIX.exec(result);
  if (!match) throw new Error(`${label} must be an ISO timestamp`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidCalendarDate(year, month, day)) throw new Error(`${label} must be a valid calendar date`);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label} must be an ISO timestamp`);
  return result;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`);
  return value;
}

function parseExpiries(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => isoDate(item, `${label}[${index}]`));
}

export function parseUsageResource(value: unknown, key = 'resource'): UsageResource {
  const input = record(value, `resources.${key}`);
  for (const field of Object.keys(input)) {
    if (!RESOURCE_FIELDS.has(field)) throw new Error(`unknown resource field: ${field}`);
  }
  const kind = input.kind;
  const unit = string(input.unit, `resources.${key}.unit`);
  const resetsAt = input.resetsAt === undefined ? undefined : isoDate(input.resetsAt, `resources.${key}.resetsAt`);
  const expiries = parseExpiries(input.expiries, `resources.${key}.expiries`);

  if (kind === 'consumption') {
    const used = optionalNumber(input.used, `resources.${key}.used`);
    const limit = optionalNumber(input.limit, `resources.${key}.limit`);
    const remaining = optionalNumber(input.remaining, `resources.${key}.remaining`);
    if (unit === 'percent') {
      for (const [label, number] of [['used', used], ['limit', limit], ['remaining', remaining]] as const) {
        if (number !== undefined && number > 100) throw new Error(`percent ${label} must be between 0 and 100`);
      }
    }
    return {
      kind,
      unit,
      ...(used === undefined ? {} : { used }),
      ...(limit === undefined ? {} : { limit }),
      ...(remaining === undefined ? {} : { remaining }),
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(expiries === undefined ? {} : { expiries }),
    };
  }

  if (kind === 'balance') {
    const available = optionalNumber(input.available, `resources.${key}.available`);
    if (available === undefined) throw new Error(`resources.${key}.available is required`);
    return {
      kind,
      unit,
      available,
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(expiries === undefined ? {} : { expiries }),
    };
  }

  throw new Error(`resources.${key}.kind is invalid`);
}

function parseErrorSummary(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const str = string(value, 'errorSummary');
  if (SENSITIVE_PATTERN.test(str) || !ALLOWED_DIAGNOSTICS.has(str)) {
    throw new Error('errorSummary must be a bounded allowlisted diagnostic without sensitive patterns');
  }
  return str;
}

export function parseUsageSnapshot(value: unknown): UsageSnapshot {
  const input = record(value, 'snapshot');
  for (const field of Object.keys(input)) {
    if (!SNAPSHOT_FIELDS.has(field)) throw new Error(`unknown field: ${field}`);
  }
  if (input.schemaVersion !== 1) throw new Error('schemaVersion must be 1');
  if (typeof input.stale !== 'boolean') throw new Error('stale must be boolean');
  const rawResources = record(input.resources, 'resources');
  const resources = Object.fromEntries(Object.entries(rawResources).map(([key, resource]) => [key, parseUsageResource(resource, key)]));
  const errorSummary = parseErrorSummary(input.errorSummary);
  return {
    schemaVersion: 1,
    userId: string(input.userId, 'userId'),
    deviceId: string(input.deviceId, 'deviceId'),
    providerId: string(input.providerId, 'providerId'),
    ...(input.plan === undefined ? {} : { plan: string(input.plan, 'plan') }),
    fetchedAt: isoDate(input.fetchedAt, 'fetchedAt'),
    syncedAt: isoDate(input.syncedAt, 'syncedAt'),
    expiresAt: isoDate(input.expiresAt, 'expiresAt'),
    stale: input.stale,
    resources,
    ...(input.sourceVersion === undefined ? {} : { sourceVersion: string(input.sourceVersion, 'sourceVersion') }),
    ...(errorSummary === undefined ? {} : { errorSummary }),
  };
}
