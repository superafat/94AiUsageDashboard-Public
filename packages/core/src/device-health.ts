export type DeviceHealthState = 'ready' | 'warning' | 'missing' | 'error';

export interface DeviceHealthSnapshot {
  schemaVersion: 1;
  userId: string;
  deviceId: string;
  updatedAt: string;
  engine: DeviceHealthState;
  background: DeviceHealthState;
  sync: DeviceHealthState;
  providerReadyCount: number;
  providerWarningCount: number;
  agentVersion?: string;
}

const FIELDS = new Set([
  'schemaVersion', 'userId', 'deviceId', 'updatedAt', 'engine', 'background', 'sync',
  'providerReadyCount', 'providerWarningCount', 'agentVersion',
]);
const STATES = new Set<DeviceHealthState>(['ready', 'warning', 'missing', 'error']);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('health must be an object');
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 120) throw new Error(`${label} must be a short non-empty string`);
  return value;
}

function state(value: unknown, label: string): DeviceHealthState {
  if (typeof value !== 'string' || !STATES.has(value as DeviceHealthState)) throw new Error(`${label} is invalid`);
  return value as DeviceHealthState;
}

function count(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 64) throw new Error(`${label} must be an integer between 0 and 64`);
  return value as number;
}

export function parseDeviceHealthSnapshot(value: unknown): DeviceHealthSnapshot {
  const input = record(value);
  for (const key of Object.keys(input)) if (!FIELDS.has(key)) throw new Error(`unknown field: ${key}`);
  if (input.schemaVersion !== 1) throw new Error('schemaVersion must be 1');
  const updatedAt = text(input.updatedAt, 'updatedAt');
  if (!Number.isFinite(Date.parse(updatedAt))) throw new Error('updatedAt must be an ISO timestamp');
  const agentVersion = input.agentVersion === undefined ? undefined : text(input.agentVersion, 'agentVersion');
  return {
    schemaVersion: 1,
    userId: text(input.userId, 'userId'),
    deviceId: text(input.deviceId, 'deviceId'),
    updatedAt,
    engine: state(input.engine, 'engine'),
    background: state(input.background, 'background'),
    sync: state(input.sync, 'sync'),
    providerReadyCount: count(input.providerReadyCount, 'providerReadyCount'),
    providerWarningCount: count(input.providerWarningCount, 'providerWarningCount'),
    ...(agentVersion === undefined ? {} : { agentVersion }),
  };
}
