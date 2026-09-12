function pathSegment(value: string, label: string): string {
  if (!value || value.includes('/')) {
    throw new Error(`${label} must be a single Firestore path segment`);
  }
  return value;
}

export function usageDocPath(uid: string, deviceId: string, providerId: string): string {
  return `users/${pathSegment(uid, 'uid')}/devices/${pathSegment(deviceId, 'deviceId')}/providers/${pathSegment(providerId, 'providerId')}`;
}

export function historyDocPath(uid: string, deviceId: string, providerId: string): string {
  return `users/${pathSegment(uid, 'uid')}/devices/${pathSegment(deviceId, 'deviceId')}/history/${pathSegment(providerId, 'providerId')}`;
}

export function healthDocPath(uid: string, deviceId: string): string {
  return `users/${pathSegment(uid, 'uid')}/devices/${pathSegment(deviceId, 'deviceId')}/health/current`;
}

export function historyChunkPath(uid: string, deviceId: string, providerId: string, chunkId: string): string {
  if (!/^(?:[0-9]|[12][0-9]|3[0-5])$/.test(chunkId)) throw new Error('history chunk must be between 0 and 35');
  return `${historyDocPath(uid, deviceId, providerId)}/historyChunks/${chunkId}`;
}

export function preferenceDocPath(uid: string, family: string): string {
  return `users/${pathSegment(uid, 'uid')}/preferences/${pathSegment(family, 'family')}`;
}

export function pushProducerDocPath(uid: string, deviceId: string): string {
  return `users/${pathSegment(uid, 'uid')}/pushProducers/${pathSegment(deviceId, 'deviceId')}`;
}

export function pushSubscriptionDocPath(uid: string, browserId: string): string {
  return `users/${pathSegment(uid, 'uid')}/pushSubscriptions/${pathSegment(browserId, 'browserId')}`;
}

export function pushProducersCollectionPath(uid: string): string {
  return `users/${pathSegment(uid, 'uid')}/pushProducers`;
}

export function pushSubscriptionsCollectionPath(uid: string): string {
  return `users/${pathSegment(uid, 'uid')}/pushSubscriptions`;
}
