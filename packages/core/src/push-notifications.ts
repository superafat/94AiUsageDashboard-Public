import { isValidCalendarDate } from './schema';
import { SENSITIVE_PATTERN } from './diagnostics';
import {
  FAMILY_DISPLAY_NAMES,
  RESOURCE_DISPLAY_LABELS,
  isKnownProviderFamily,
  providerFamilyOf,
  type KnownProviderFamily,
} from './preferences';

export const MAX_SUBSCRIPTIONS_PER_USER = 10;
export const MAX_PAYLOAD_BYTES = 2048;
export const MAX_PUSH_TTL_SECONDS = 300;

export interface PushProducerRecord {
  schemaVersion: 1;
  userId: string;
  deviceId: string;
  publicKey: string;
  updatedAt: string;
}

export interface PushSubscriptionRecord {
  schemaVersion: 1;
  userId: string;
  browserId: string;
  targetDeviceId: string;
  enrollmentEpoch: number;
  applicationServerKey: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: string;
  expiresAt: string;
  testRequestId?: string;
  testRequestedAt?: string;
}

export type PushPayloadType = 'consumption' | 'reset' | 'test';

export interface PushPayload {
  version: 1;
  browserId: string;
  epoch: number;
  eventId: string;
  type: PushPayloadType;
  observedAt: string;
  expiresAt: string;
  title: string;
  body: string;
}

const PRODUCER_KEYS = ['schemaVersion', 'userId', 'deviceId', 'publicKey', 'updatedAt'] as const;
const SUBSCRIPTION_KEYS = [
  'schemaVersion', 'userId', 'browserId', 'targetDeviceId', 'enrollmentEpoch',
  'applicationServerKey', 'endpoint', 'p256dh', 'auth', 'createdAt', 'expiresAt',
  'testRequestId', 'testRequestedAt',
] as const;
const PAYLOAD_KEYS = [
  'version', 'browserId', 'epoch', 'eventId', 'type', 'observedAt', 'expiresAt', 'title', 'body',
] as const;

function invalid(msg = 'invalid_notification_record'): never {
  throw new Error(msg);
}

function record(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return invalid();
  }
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    return invalid();
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value.length || value.length > max ||
      value.split('').some((char) => char.charCodeAt(0) < 32) || SENSITIVE_PATTERN.test(value)) {
    return invalid();
  }
  return value;
}

function date(value: unknown): string {
  const str = text(value, 64);
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.exec(str);
  if (!match || !isValidCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])) || !Number.isFinite(Date.parse(str))) {
    return invalid();
  }
  return str;
}

function integer(value: unknown, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    return invalid();
  }
  return value;
}

export function validatePushEndpoint(endpoint: string): { valid: boolean; reason?: string } {
  if (typeof endpoint !== 'string' || !endpoint.length || endpoint.length > 2048) {
    return { valid: false, reason: 'length_exceeded' };
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { valid: false, reason: 'invalid_url' };
  }
  if (url.protocol !== 'https:') {
    return { valid: false, reason: 'insecure_protocol' };
  }
  if (url.port !== '' && url.port !== '443') {
    return { valid: false, reason: 'invalid_port' };
  }
  if (url.username !== '' || url.password !== '') {
    return { valid: false, reason: 'userinfo_not_allowed' };
  }
  if (url.hash !== '') {
    return { valid: false, reason: 'hash_not_allowed' };
  }

  const host = url.hostname.toLowerCase();
  if (host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com') {
    return { valid: true };
  }
  if (host.endsWith('.push.apple.com')) {
    const prefix = host.slice(0, -'.push.apple.com'.length);
    if (prefix.length > 0 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(prefix)) {
      return { valid: true };
    }
  }

  return { valid: false, reason: 'unauthorized_host' };
}

export function validatePushKey(value: unknown, bytes: number): string {
  const encoded = text(value, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return invalid();
  let decoded: string;
  try { decoded = atob(encoded.replace(/-/g, '+').replace(/_/g, '/')); } catch { return invalid(); }
  if (decoded.length !== bytes || (bytes === 65 && decoded.charCodeAt(0) !== 4) ||
      btoa(decoded).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== encoded) return invalid();
  return encoded;
}
export interface PushNotificationTextOptions {
  type: PushPayloadType;
  providerId?: string;
  resourceKey?: string;
  remainingPercent?: number;
}

export function pushNotificationText(
  typeOrOptions: PushPayloadType | PushNotificationTextOptions,
): { title: string; body: string } {
  const options: PushNotificationTextOptions = typeof typeOrOptions === 'string'
    ? { type: typeOrOptions }
    : typeOrOptions;

  if (options.type === 'test') {
    return { title: '測試通知', body: '這是 94AiUsageDashboard 的測試推播' };
  }

  if (options.type === 'reset') {
    if (options.providerId && !SENSITIVE_PATTERN.test(options.providerId)) {
      const family = providerFamilyOf(options.providerId);
      if (isKnownProviderFamily(family)) {
        const providerName = FAMILY_DISPLAY_NAMES[family as KnownProviderFamily];
        const resourceLabel = (options.resourceKey && !SENSITIVE_PATTERN.test(options.resourceKey)
          ? RESOURCE_DISPLAY_LABELS[family]?.[options.resourceKey]
          : undefined) ?? '額度';
        return {
          title: `${providerName} · ${resourceLabel}已重置`,
          body: '額度已確認恢復，點此查看。',
        };
      }
    }
    return { title: 'AI 額度重置通知', body: '有來源的額度已確認恢復，點此查看。' };
  }

  // consumption
  if (options.providerId && !SENSITIVE_PATTERN.test(options.providerId)) {
    const family = providerFamilyOf(options.providerId);
    if (isKnownProviderFamily(family)) {
      const providerName = FAMILY_DISPLAY_NAMES[family as KnownProviderFamily];
      const resourceLabel = (options.resourceKey && !SENSITIVE_PATTERN.test(options.resourceKey)
        ? RESOURCE_DISPLAY_LABELS[family]?.[options.resourceKey]
        : undefined) ?? '額度';
      const title = `${providerName} · ${resourceLabel}`;
      let body: string;
      if (typeof options.remainingPercent === 'number' && Number.isFinite(options.remainingPercent) && options.remainingPercent >= 0 && options.remainingPercent <= 100) {
        const rem = Math.max(0, Math.min(100, Math.round(options.remainingPercent)));
        const used = Math.max(0, Math.min(100, 100 - rem));
        body = `已達 ${used}% 耗用，剩餘 ${rem}%`;
      } else {
        body = '有來源達到新的耗用門檻，點此查看。';
      }
      return { title, body };
    }
  }

  return { title: 'AI 額度消耗通知', body: '有來源達到新的耗用門檻，點此查看。' };
}

const ALL_KNOWN_RESOURCE_LABELS = new Set<string>([
  '額度',
  ...Object.values(RESOURCE_DISPLAY_LABELS).flatMap((dict) => Object.values(dict)),
]);
const ALL_KNOWN_PROVIDER_NAMES = new Set<string>(Object.values(FAMILY_DISPLAY_NAMES));

export function isCanonicalPushNotification(type: PushPayloadType, title: string, body: string): boolean {
  if (type === 'test') {
    return title === '測試通知' && body === '這是 94AiUsageDashboard 的測試推播';
  }

  if (type === 'reset') {
    if (title === 'AI 額度重置通知' && (body === '有來源的額度已確認恢復，點此查看。' || body === '額度已確認恢復，點此查看。')) {
      return true;
    }
    if (body !== '額度已確認恢復，點此查看。') return false;
    const match = /^([^\s·]+(?:\s+[^\s·]+)*)\s*·\s*(.+?)已重置$/.exec(title);
    if (!match || !match[1] || !match[2]) return false;
    const provider = match[1];
    const resource = match[2];
    return ALL_KNOWN_PROVIDER_NAMES.has(provider) && ALL_KNOWN_RESOURCE_LABELS.has(resource);
  }

  if (type === 'consumption') {
    if (title === 'AI 額度消耗通知' && body === '有來源達到新的耗用門檻，點此查看。') {
      return true;
    }
    const titleMatch = /^([^\s·]+(?:\s+[^\s·]+)*)\s*·\s*(.+)$/.exec(title);
    if (!titleMatch || !titleMatch[1] || !titleMatch[2]) return false;
    const provider = titleMatch[1];
    const resource = titleMatch[2];
    if (!ALL_KNOWN_PROVIDER_NAMES.has(provider) || !ALL_KNOWN_RESOURCE_LABELS.has(resource)) {
      return false;
    }
    if (body === '有來源達到新的耗用門檻，點此查看。') return true;
    const bodyMatch = /^已達 (\d{1,3})% 耗用，剩餘 (\d{1,3})%$/.exec(body);
    if (!bodyMatch || !bodyMatch[1] || !bodyMatch[2]) return false;
    const used = Number(bodyMatch[1]);
    const remaining = Number(bodyMatch[2]);
    return used >= 0 && used <= 100 && remaining >= 0 && remaining <= 100 && (used + remaining === 100);
  }

  return false;
}

export function parsePushProducerRecord(value: unknown): PushProducerRecord {
  const input = record(value, PRODUCER_KEYS);
  if (input.schemaVersion !== 1) return invalid();
  const userId = text(input.userId);
  const deviceId = text(input.deviceId);
  const publicKey = validatePushKey(input.publicKey, 65);
  const updatedAt = date(input.updatedAt);
  return {
    schemaVersion: 1,
    userId,
    deviceId,
    publicKey,
    updatedAt,
  };
}

export function parsePushSubscriptionRecord(value: unknown): PushSubscriptionRecord {
  const input = record(value, SUBSCRIPTION_KEYS);
  if (input.schemaVersion !== 1) return invalid();
  const userId = text(input.userId);
  const browserId = text(input.browserId);
  const targetDeviceId = text(input.targetDeviceId);
  const enrollmentEpoch = integer(input.enrollmentEpoch, 1);
  const applicationServerKey = validatePushKey(input.applicationServerKey, 65);
  const endpoint = text(input.endpoint, 2048);
  const validation = validatePushEndpoint(endpoint);
  if (!validation.valid) return invalid();
  const p256dh = validatePushKey(input.p256dh, 65);
  const auth = validatePushKey(input.auth, 16);
  const createdAt = date(input.createdAt);
  const expiresAt = date(input.expiresAt);

  if (Date.parse(expiresAt) <= Date.parse(createdAt) || Date.parse(expiresAt) - Date.parse(createdAt) > 31 * 86400_000) return invalid();
  if ((input.testRequestId === undefined) !== (input.testRequestedAt === undefined)) return invalid();
  const res: PushSubscriptionRecord = {
    schemaVersion: 1,
    userId,
    browserId,
    targetDeviceId,
    enrollmentEpoch,
    applicationServerKey,
    endpoint,
    p256dh,
    auth,
    createdAt,
    expiresAt,
  };

  if (input.testRequestId !== undefined) {
    res.testRequestId = text(input.testRequestId);
    if (!/^[A-Za-z0-9._-]+$/.test(res.testRequestId)) return invalid();
  }
  if (input.testRequestedAt !== undefined) {
    res.testRequestedAt = date(input.testRequestedAt);
  }
  return res;
}

export function parsePushPayload(value: unknown): PushPayload {
  const input = record(value, PAYLOAD_KEYS);
  if (input.version !== 1) return invalid();
  const browserId = text(input.browserId);
  const epoch = integer(input.epoch, 1);
  const eventId = text(input.eventId);
  if (!/^[A-Za-z0-9._-]+$/.test(eventId)) return invalid();
  if (input.type !== 'consumption' && input.type !== 'reset' && input.type !== 'test') {
    return invalid();
  }
  const type = input.type as PushPayloadType;
  const observedAt = date(input.observedAt);
  const expiresAt = date(input.expiresAt);
  const title = text(input.title, 128);
  const body = text(input.body, 512);
  if (!isCanonicalPushNotification(type, title, body) || Date.parse(expiresAt) <= Date.parse(observedAt) ||
      Date.parse(expiresAt) - Date.parse(observedAt) > 30 * 60_000 || new TextEncoder().encode(JSON.stringify(input)).length > MAX_PAYLOAD_BYTES) return invalid();

  return {
    version: 1,
    browserId,
    epoch,
    eventId,
    type,
    observedAt,
    expiresAt,
    title,
    body,
  };
}

export function selectFreshProducer(
  producers: PushProducerRecord[],
  now: number | Date = Date.now(),
): PushProducerRecord | null {
  const currentTime = typeof now === 'number' ? now : now.getTime();
  const TEN_MINUTES_MS = 10 * 60 * 1000;
  const candidates = producers
    .map((p) => {
      try {
        return parsePushProducerRecord(p);
      } catch {
        return null;
      }
    })
    .filter((p): p is PushProducerRecord => {
      if (!p) return false;
      const updated = Date.parse(p.updatedAt);
      return Number.isFinite(updated) && updated <= currentTime + 60_000 && (currentTime - updated) <= TEN_MINUTES_MS;
    });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const diff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (diff !== 0) return diff;
    return a.deviceId.localeCompare(b.deviceId);
  });
  return candidates[0] ?? null;
}
