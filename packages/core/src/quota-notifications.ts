import { isValidCalendarDate, parseUsageSnapshot, type UsageSnapshot } from './schema';
import { isSnapshotStale } from './freshness';
import { SENSITIVE_PATTERN } from './diagnostics';

export interface QuotaNotificationScope {
  backendId: string; userId: string; deviceId: string; providerId: string; resourceKey: string;
}
export interface QuotaNotificationState extends QuotaNotificationScope {
  version: 1;
  watermarkUsedBand: number;
  lastRemainingPercent: number;
  lastResetsAt?: string;
  lastFetchedAt: string;
  cycleStartedAt: string;
  plan?: string;
  unit: string;
  limit: number;
  enabled: boolean;
  notifyConsumption: boolean;
  notifyReset: boolean;
  preferenceRevision?: string;
}
export type QuotaEventType = 'consumption' | 'reset';
export interface QuotaNotificationEvent extends QuotaNotificationScope {
  version: 1; eventId: string; type: QuotaEventType;
  observedAt: string; expiresAt: string; remainingPercent: number;
  crossedBands?: number[];
  resetProof?: 'window_advanced_full_replenish';
}
export type QuotaNotificationStatus = 'ok' | 'no_event' | 'rebaselined' | 'disabled' | 'stale' |
  'out_of_order' | 'error_summary' | 'invalid_input' | 'invalid_resource' | 'unknown_limit' |
  'contradictory_data' | 'plan_changed';
export interface QuotaNotificationInput {
  backendId: string; userId: string; deviceId: string; snapshot: unknown; resourceKey: string;
  sourceEnabled?: boolean; enabled?: boolean; notifyConsumption?: boolean; notifyReset?: boolean;
  preferenceRevision?: string | number; now?: number | Date | string; previousState?: unknown;
}
export interface QuotaNotificationResult {
  state?: QuotaNotificationState; events: QuotaNotificationEvent[]; status: QuotaNotificationStatus;
}
const SCOPE_KEYS = ['backendId', 'userId', 'deviceId', 'providerId', 'resourceKey'] as const;
const STATE_KEYS = [...SCOPE_KEYS, 'version', 'watermarkUsedBand', 'lastRemainingPercent', 'lastResetsAt',
  'lastFetchedAt', 'cycleStartedAt', 'plan', 'unit', 'limit', 'enabled', 'notifyConsumption', 'notifyReset', 'preferenceRevision'];
const EVENT_KEYS = [...SCOPE_KEYS, 'version', 'eventId', 'type', 'observedAt', 'expiresAt', 'remainingPercent', 'crossedBands', 'resetProof'];
const BANDS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
function invalid(): never { throw new Error('invalid_notification_record'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  if (Object.keys(value).some(key => !keys.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value.length || value.length > max || value.split('').some(char => char.charCodeAt(0) < 32) || SENSITIVE_PATTERN.test(value)) return invalid();
  return value;
}
function date(value: unknown): string {
  const str = text(value, 32);
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.exec(str);
  if (!match || !isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])) || !Number.isFinite(Date.parse(str))) return invalid();
  return str;
}
function number(value: unknown, min: number, max = Number.MAX_VALUE): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return invalid();
  return value;
}
function bool(value: unknown): boolean { if (typeof value !== 'boolean') return invalid(); return value; }
function scope(input: Record<string, unknown>): QuotaNotificationScope {
  return {backendId: text(input.backendId), userId: text(input.userId), deviceId: text(input.deviceId),
    providerId: text(input.providerId), resourceKey: text(input.resourceKey)};
}
function sameScope(a: QuotaNotificationScope, b: QuotaNotificationScope): boolean { return SCOPE_KEYS.every(key => a[key] === b[key]); }

export function parseQuotaNotificationState(value: unknown): QuotaNotificationState {
  const input = record(value, STATE_KEYS);
  if (input.version !== 1) return invalid();
  const watermark = number(input.watermarkUsedBand, 0, 100);
  if (watermark % 10 !== 0) return invalid();
  const unit = text(input.unit, 32);
  const limit = number(input.limit, Number.MIN_VALUE);
  if (unit === 'percent' && limit !== 100) return invalid();
  const lastFetchedAt = date(input.lastFetchedAt), cycleStartedAt = date(input.cycleStartedAt);
  if (Date.parse(cycleStartedAt) > Date.parse(lastFetchedAt)) return invalid();
  return {...scope(input), version: 1, watermarkUsedBand: watermark,
    lastRemainingPercent: number(input.lastRemainingPercent, 0, 100), lastFetchedAt, cycleStartedAt,
    ...(input.lastResetsAt === undefined ? {} : {lastResetsAt: date(input.lastResetsAt)}),
    ...(input.plan === undefined ? {} : {plan: text(input.plan)}), unit, limit,
    enabled: bool(input.enabled), notifyConsumption: bool(input.notifyConsumption), notifyReset: bool(input.notifyReset),
    ...(input.preferenceRevision === undefined ? {} : {preferenceRevision: text(input.preferenceRevision)})};
}
export function parseQuotaNotificationEvent(value: unknown): QuotaNotificationEvent {
  const input = record(value, EVENT_KEYS);
  if (input.version !== 1 || (input.type !== 'consumption' && input.type !== 'reset')) return invalid();
  const eventId = text(input.eventId);
  if (!/^[A-Za-z0-9._-]+$/.test(eventId)) return invalid();
  const observedAt = date(input.observedAt), expiresAt = date(input.expiresAt);
  if (Date.parse(expiresAt) <= Date.parse(observedAt) || Date.parse(expiresAt) - Date.parse(observedAt) > 30 * 60_000) return invalid();
  const common = {...scope(input), version: 1 as const, eventId, observedAt, expiresAt, remainingPercent: number(input.remainingPercent, 0, 100)};
  if (input.type === 'reset') {
    if (input.resetProof !== 'window_advanced_full_replenish' || input.crossedBands !== undefined) return invalid();
    return {...common, type: 'reset', resetProof: 'window_advanced_full_replenish'};
  }
  const bands = input.crossedBands;
  if (input.resetProof !== undefined || !Array.isArray(bands) || bands.length === 0 || bands.length > 10 ||
      bands.some((band, i) => !BANDS.includes(band) || (i > 0 && bands[i - 1] >= band))) return invalid();
  return {...common, type: 'consumption', crossedBands: [...bands]};
}
async function eventId(identity: QuotaNotificationScope, cycle: string, type: QuotaEventType, band: number): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([...SCOPE_KEYS.map(key => identity[key]), cycle, type, band]));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return 'qne_' + Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}
function nowMs(value: QuotaNotificationInput['now']): number {
  const time = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(date(value)) : value;
  return number(time, 0);
}
function quota(snapshot: UsageSnapshot, resourceKey: string): {remaining: number; limit: number; unit: string; resetsAt?: string} {
  const resource = snapshot.resources[resourceKey];
  if (!resource || resource.kind !== 'consumption') throw new Error('invalid_resource');
  const unit = text(resource.unit, 32);
  if (unit !== 'percent' && (resource.limit === undefined || resource.limit <= 0)) throw new Error('unknown_limit');
  const limit = unit === 'percent' ? 100 : resource.limit!;
  if ((unit === 'percent' && resource.limit !== undefined && resource.limit !== 100) || !Number.isFinite(limit) || limit <= 0 ||
      (resource.used !== undefined && resource.used > limit) || (resource.remaining !== undefined && resource.remaining > limit)) throw new Error('contradictory_data');
  if (resource.used === undefined && resource.remaining === undefined) throw new Error('invalid_resource');
  if (resource.used !== undefined && resource.remaining !== undefined && Math.abs(resource.used + resource.remaining - limit) > Math.max(1e-8, limit * 1e-8)) throw new Error('contradictory_data');
  const rawRemaining = resource.remaining ?? (limit - resource.used!);
  const remaining = unit === 'percent' ? rawRemaining : (rawRemaining / limit) * 100;
  if (!Number.isFinite(remaining) || remaining < 0 || remaining > 100) throw new Error('contradictory_data');
  return {remaining, limit, unit, ...(resource.resetsAt === undefined ? {} : {resetsAt: date(resource.resetsAt)})};
}

/** No network, OS notifications, provider writes, wall-clock inference or invented balances. */
export async function evaluateQuotaNotifications(input: QuotaNotificationInput): Promise<QuotaNotificationResult> {
  let previous: QuotaNotificationState | undefined;
  const result = (status: QuotaNotificationStatus, state = previous): QuotaNotificationResult => ({...(state === undefined ? {} : {state}), events: [], status});
  let snapshot: UsageSnapshot, identity: QuotaNotificationScope, time: number;
  let enabled: boolean, consume: boolean, reset: boolean, revision: string | undefined;
  try {
    if (!input || typeof input !== 'object') return result('invalid_input');
    text(input.backendId); text(input.userId); text(input.deviceId); text(input.resourceKey);
    time = nowMs(input.now);
    enabled = bool(input.sourceEnabled ?? input.enabled ?? false);
    consume = bool(input.notifyConsumption ?? false); reset = bool(input.notifyReset ?? false);
    revision = input.preferenceRevision === undefined ? undefined : text(String(input.preferenceRevision));
    if (input.previousState !== undefined) {
      const parsed = parseQuotaNotificationState(input.previousState);
      if (parsed.backendId === input.backendId && parsed.userId === input.userId && parsed.deviceId === input.deviceId && parsed.resourceKey === input.resourceKey) previous = parsed;
    }
    snapshot = parseUsageSnapshot(input.snapshot);
    identity = scope({...input, providerId: snapshot.providerId});
    if (snapshot.userId !== input.userId || snapshot.deviceId !== input.deviceId) return result('invalid_input');
    if (previous && !sameScope(previous, identity)) previous = undefined;
    if (snapshot.plan !== undefined) text(snapshot.plan);
  } catch { return result('invalid_input'); }
  if (!enabled && previous) return result('disabled', {...previous, enabled: false, notifyConsumption: consume, notifyReset: reset});
  if (isSnapshotStale(snapshot, time)) return result('stale');
  if (snapshot.errorSummary) return result('error_summary');
  if (previous && Date.parse(snapshot.fetchedAt) <= Date.parse(previous.lastFetchedAt)) return result('out_of_order');
  let values: ReturnType<typeof quota>;
  try { values = quota(snapshot, input.resourceKey); }
  catch (error) {
    const code = error instanceof Error ? error.message : '';
    return result(['unknown_limit', 'contradictory_data'].includes(code) ? code as QuotaNotificationStatus : 'invalid_resource');
  }
  const band = Math.floor((100 - values.remaining) / 10 + 1e-10) * 10;
  const baseline: QuotaNotificationState = {...identity, version: 1, watermarkUsedBand: band,
    lastRemainingPercent: values.remaining, lastFetchedAt: snapshot.fetchedAt, cycleStartedAt: snapshot.fetchedAt,
    ...(values.resetsAt ? {lastResetsAt: values.resetsAt} : {}), ...(snapshot.plan ? {plan: snapshot.plan} : {}),
    unit: values.unit, limit: values.limit, enabled, notifyConsumption: consume, notifyReset: reset,
    ...(revision === undefined ? {} : {preferenceRevision: revision})};
  if (!enabled) return result('disabled', baseline);
  if (!previous || !previous.enabled) return result('rebaselined', baseline);
  if (previous.plan !== snapshot.plan || previous.limit !== values.limit || previous.unit !== values.unit) return result('plan_changed', baseline);
  const channelsChanged = previous.notifyConsumption !== consume || previous.notifyReset !== reset;
  if (previous.preferenceRevision !== revision && !channelsChanged) return result('rebaselined', baseline);
  const justEnabledConsumption = consume && !previous.notifyConsumption;
  const justEnabledReset = reset && !previous.notifyReset;
  let windowChanged = previous.lastResetsAt !== values.resetsAt;
  let confirmedReset = false;
  if (previous.lastResetsAt && values.resetsAt) {
    const delta = Date.parse(values.resetsAt) - Date.parse(previous.lastResetsAt);
    if (Math.abs(delta) < 60_000) windowChanged = false;
    else confirmedReset = delta >= 60_000 && Date.parse(values.resetsAt) > time && values.remaining >= 99 && values.remaining - previous.lastRemainingPercent >= 10;
  }
  if (windowChanged && !confirmedReset) return result('rebaselined', baseline);
  const state: QuotaNotificationState = windowChanged ? baseline : {...baseline,
    cycleStartedAt: previous.cycleStartedAt, ...(previous.lastResetsAt ? {lastResetsAt: previous.lastResetsAt} : {}),
    watermarkUsedBand: justEnabledConsumption ? band : Math.max(previous.watermarkUsedBand, band)};
  const type: QuotaEventType = confirmedReset ? 'reset' : 'consumption';
  const bands = BANDS.filter(n => n > previous!.watermarkUsedBand && n <= band);
  if (confirmedReset ? (!reset || justEnabledReset) : (!consume || justEnabledConsumption || !bands.length)) return result('no_event', state);
  const event: QuotaNotificationEvent = {...identity, version: 1,
    eventId: await eventId(identity, state.lastResetsAt ?? state.cycleStartedAt, type, confirmedReset ? 0 : band),
    type, observedAt: snapshot.fetchedAt,
    expiresAt: new Date(Math.min(Date.parse(snapshot.expiresAt), Date.parse(snapshot.fetchedAt) + 30 * 60_000)).toISOString(),
    remainingPercent: values.remaining,
    ...(confirmedReset ? {resetProof: 'window_advanced_full_replenish' as const} : {crossedBands: bands})};
  return {state, events: [parseQuotaNotificationEvent(event)], status: 'ok'};
}
