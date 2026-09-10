import { isValidCalendarDate } from './schema';

export const KNOWN_PROVIDER_FAMILIES = [
  'codex',
  'antigravity',
  'claude',
  'copilot',
  'cursor',
  'devin',
  'grok',
  'ollama',
  'opencode',
  'openrouter',
  'zai',
] as const;

export type KnownProviderFamily = (typeof KNOWN_PROVIDER_FAMILIES)[number];

export interface ProviderCatalogEntry {
  family: KnownProviderFamily;
  name: string;
  defaultEnabled: boolean;
}

export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  { family: 'codex', name: 'Codex', defaultEnabled: true },
  { family: 'antigravity', name: 'Antigravity', defaultEnabled: true },
  { family: 'claude', name: 'Claude Code', defaultEnabled: true },
  { family: 'copilot', name: 'Copilot', defaultEnabled: false },
  { family: 'cursor', name: 'Cursor', defaultEnabled: false },
  { family: 'devin', name: 'Devin', defaultEnabled: false },
  { family: 'grok', name: 'Grok', defaultEnabled: false },
  { family: 'ollama', name: 'Ollama (Cloud)', defaultEnabled: false },
  { family: 'opencode', name: 'OpenCode', defaultEnabled: false },
  { family: 'openrouter', name: 'OpenRouter', defaultEnabled: false },
  { family: 'zai', name: 'Zai', defaultEnabled: false },
] as const;

export const DEFAULT_ENABLED_FAMILIES = new Set<string>(
  PROVIDER_CATALOG.filter((c) => c.defaultEnabled).map((c) => c.family),
);

export function isKnownProviderFamily(family: string): family is KnownProviderFamily {
  return (KNOWN_PROVIDER_FAMILIES as readonly string[]).includes(family);
}

export function providerFamilyOf(providerId: string): string {
  const normalized = providerId.trim().toLowerCase();
  const atIndex = normalized.indexOf('@');
  const base = atIndex >= 0 ? normalized.slice(0, atIndex) : normalized;
  return base;
}

export function resolveFamilyEnabled(family: string, preferences: Record<string, boolean>): boolean {
  if (Object.prototype.hasOwnProperty.call(preferences, family)) {
    return Boolean(preferences[family]);
  }
  if (isKnownProviderFamily(family)) {
    return DEFAULT_ENABLED_FAMILIES.has(family);
  }
  return false;
}

export interface ProviderNotificationPreference {
  lowQuota?: boolean;
  reset?: boolean;
}

export interface ProviderPreference {
  schemaVersion: 1;
  userId: string;
  family: string;
  enabled: boolean;
  updatedAt: string;
  notifications?: ProviderNotificationPreference;
}

const PREFERENCE_FIELDS = new Set([
  'schemaVersion',
  'userId',
  'family',
  'enabled',
  'updatedAt',
  'notifications',
]);

const NOTIFICATION_FIELDS = new Set(['lowQuota', 'reset']);

const ISO_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/;

function validateIsoDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    throw new Error(`${label} must be a non-empty string`);
  }
  const match = ISO_DATE_PREFIX.exec(value);
  if (!match) throw new Error(`${label} must be an ISO timestamp`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidCalendarDate(year, month, day)) throw new Error(`${label} must be a valid calendar date`);
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
  return value;
}

export function parseProviderPreference(value: unknown): ProviderPreference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('preference must be an object');
  }
  const raw = value as Record<string, unknown>;
  for (const field of Object.keys(raw)) {
    if (!PREFERENCE_FIELDS.has(field)) {
      throw new Error(`unknown preference field: ${field}`);
    }
  }

  if (raw.schemaVersion !== 1) {
    throw new Error('preference schemaVersion must be 1');
  }
  if (typeof raw.userId !== 'string' || raw.userId.length === 0 || raw.userId.length > 128) {
    throw new Error('preference userId must be a non-empty bounded string');
  }
  if (typeof raw.family !== 'string' || !isKnownProviderFamily(raw.family)) {
    throw new Error('preference family must be a known provider family');
  }
  if (typeof raw.enabled !== 'boolean') {
    throw new Error('preference enabled must be a boolean');
  }
  const updatedAt = validateIsoDate(raw.updatedAt, 'preference.updatedAt');

  let notifications: ProviderNotificationPreference | undefined;
  if (raw.notifications !== undefined) {
    if (!raw.notifications || typeof raw.notifications !== 'object' || Array.isArray(raw.notifications)) {
      throw new Error('preference notifications must be an object');
    }
    const rawNotif = raw.notifications as Record<string, unknown>;
    for (const field of Object.keys(rawNotif)) {
      if (!NOTIFICATION_FIELDS.has(field)) {
        throw new Error(`unknown notification field: ${field}`);
      }
    }
    if (rawNotif.lowQuota !== undefined && typeof rawNotif.lowQuota !== 'boolean') {
      throw new Error('preference notifications.lowQuota must be a boolean');
    }
    if (rawNotif.reset !== undefined && typeof rawNotif.reset !== 'boolean') {
      throw new Error('preference notifications.reset must be a boolean');
    }
    notifications = {
      ...(rawNotif.lowQuota !== undefined ? { lowQuota: rawNotif.lowQuota } : {}),
      ...(rawNotif.reset !== undefined ? { reset: rawNotif.reset } : {}),
    };
  }

  return {
    schemaVersion: 1,
    userId: raw.userId,
    family: raw.family,
    enabled: raw.enabled,
    updatedAt,
    ...(notifications !== undefined ? { notifications } : {}),
  };
}
