import { describe, expect, it } from 'vitest';
import { createWebPushNotificationService, selectFreshProducer, type LocalEnrollment } from './notifications';
import type { PushProducerRecord, PushSubscriptionRecord } from '@94ai/core';

describe('WebPushNotificationService', () => {
  const VALID_PUBKEY = 'BFRdOgvw1mGS7riy-AmAm8sq3A3yTouaefCn1Nnv1YFJXopKLfRAzMX1AQGvq_xGiBUdoWCfuZjeOFq9lDn7aDo';
  const VALID_AUTH = '8vyc8x-TXwGwYgjlAic24w';

  const sampleProducer: PushProducerRecord = {
    schemaVersion: 1,
    userId: 'user-1',
    deviceId: 'mac-1',
    publicKey: VALID_PUBKEY,
    updatedAt: '2026-09-10T12:00:00.000Z',
  };

  it('detects unsupported environment when Notification or PushManager is absent', async () => {
    const service = createWebPushNotificationService({
      db: {} as never,
      now: () => Date.parse('2026-09-10T12:05:00.000Z'),
      notificationApi: undefined,
      getServiceWorkerRegistration: async () => undefined,
    });
    expect(service.isSupported()).toBe(false);
    expect(await service.getPermissionStatus()).toBe('unsupported');
  });

  it('detects ios_needs_home_screen when iOS browser is not in standalone mode', async () => {
    const fakeNotification = { permission: 'default', requestPermission: async () => 'granted' } as unknown as typeof Notification;
    const service = createWebPushNotificationService({
      db: {} as never,
      now: () => Date.parse('2026-09-10T12:05:00.000Z'),
      notificationApi: fakeNotification,
      getServiceWorkerRegistration: async () => ({} as ServiceWorkerRegistration),
      isIos: () => true,
      isStandalone: () => false,
      hasPushManager: () => true,
    });
    expect(await service.getPermissionStatus()).toBe('ios_needs_home_screen');
  });

  it('detects permission denied truthfully', async () => {
    const fakeNotification = { permission: 'denied', requestPermission: async () => 'denied' } as unknown as typeof Notification;
    const service = createWebPushNotificationService({
      db: {} as never,
      now: () => Date.parse('2026-09-10T12:05:00.000Z'),
      notificationApi: fakeNotification,
      getServiceWorkerRegistration: async () => ({} as ServiceWorkerRegistration),
      isIos: () => false,
      hasPushManager: () => true,
    });
    expect(await service.getPermissionStatus()).toBe('denied');
  });

  it('selectFreshProducer selects newest valid producer within 10 minutes and breaks ties deterministically', () => {
    const now = new Date('2026-09-10T12:05:00.000Z');
    const producerOld: PushProducerRecord = {
      ...sampleProducer,
      deviceId: 'mac-old',
      updatedAt: '2026-09-10T12:00:00.000Z', // 5m old (valid)
    };
    const producerNewA: PushProducerRecord = {
      ...sampleProducer,
      deviceId: 'mac-b',
      updatedAt: '2026-09-10T12:04:00.000Z', // 1m old (newest)
    };
    const producerNewB: PushProducerRecord = {
      ...sampleProducer,
      deviceId: 'mac-a',
      updatedAt: '2026-09-10T12:04:00.000Z', // 1m old, tie-break by deviceId 'mac-a' < 'mac-b'
    };

    const winner = selectFreshProducer([producerOld, producerNewA, producerNewB], now);
    expect(winner?.deviceId).toBe('mac-a');
  });

  it('selectFreshProducer rejects stale (>10m) or future producers', () => {
    const now = new Date('2026-09-10T12:15:00.000Z');
    const producerStale: PushProducerRecord = {
      ...sampleProducer,
      updatedAt: '2026-09-10T12:00:00.000Z', // 15m old (>10m)
    };
    const producerFuture: PushProducerRecord = {
      ...sampleProducer,
      updatedAt: '2026-09-10T12:30:00.000Z', // future (>60s)
    };

    expect(selectFreshProducer([producerStale], now)).toBeNull();
    expect(selectFreshProducer([producerFuture], now)).toBeNull();
  });

  it('subscribes with PushManager, saves to local storage and Firestore', async () => {
    let firestoreSub: PushSubscriptionRecord | null = null;
    let localStored: LocalEnrollment | null = null;

    const mockRegistration = {
      pushManager: {
        getSubscription: async () => null,
        subscribe: async (opts: PushSubscriptionOptionsInit) => {
          expect(opts.userVisibleOnly).toBe(true);
          return {
            endpoint: 'https://fcm.googleapis.com/fcm/send/token123',
            toJSON: () => ({
              endpoint: 'https://fcm.googleapis.com/fcm/send/token123',
              keys: {
                p256dh: VALID_PUBKEY,
                auth: VALID_AUTH,
              },
            }),
          };
        },
      },
    };

    const service = createWebPushNotificationService({
      db: {} as never,
      now: () => Date.parse('2026-09-10T12:05:00.000Z'),
      backendId: 'self-hosted',
      notificationApi: { permission: 'granted' } as unknown as typeof Notification,
      getServiceWorkerRegistration: async () => mockRegistration as unknown as ServiceWorkerRegistration,
      isIos: () => false,
      hasPushManager: () => true,
      storage: {
        get: async () => null,
        set: async (val) => { localStored = val; },
        clear: async () => { localStored = null; },
      },
      writeSubscription: async (sub) => { firestoreSub = sub; },
    });

    const sub = await service.subscribe('user-1', sampleProducer);

    expect(sub.targetDeviceId).toBe('mac-1');
    expect(sub.endpoint).toBe('https://fcm.googleapis.com/fcm/send/token123');
    expect(firestoreSub).toEqual(sub);
    expect(localStored).toEqual(expect.objectContaining({browserId: sub.browserId, epoch: 1}));
  });

  it('failed save: does not persist to local storage if Firestore write fails', async () => {
    let localStored: LocalEnrollment | null = null;

    const mockRegistration = {
      pushManager: {
        getSubscription: async () => null,
        subscribe: async () => ({
          endpoint: 'https://fcm.googleapis.com/fcm/send/token123',
          toJSON: () => ({
            endpoint: 'https://fcm.googleapis.com/fcm/send/token123',
            keys: {
              p256dh: VALID_PUBKEY,
              auth: VALID_AUTH,
            },
          }),
        }),
      },
    };

    const service = createWebPushNotificationService({
      db: {} as never,
      now: () => Date.parse('2026-09-10T12:05:00.000Z'),
      backendId: 'self-hosted',
      notificationApi: { permission: 'granted' } as unknown as typeof Notification,
      getServiceWorkerRegistration: async () => mockRegistration as unknown as ServiceWorkerRegistration,
      isIos: () => false,
      hasPushManager: () => true,
      storage: {
        get: async () => null,
        set: async (val) => { localStored = val; },
        clear: async () => { localStored = null; },
      },
      writeSubscription: async () => {
        throw new Error('Firestore write quota exceeded');
      },
    });

    await expect(service.subscribe('user-1', sampleProducer)).rejects.toThrow('Firestore write quota exceeded');
    expect(localStored).toBeNull();
  });

  it('logout while enrollment pending: cancels enrollment and does not leave local permission', async () => {
    let localStored: LocalEnrollment | null = null;
    let revoked = false;

    let resolvePushSub!: () => void;
    const pushSubPromise = new Promise<void>((resolve) => { resolvePushSub = resolve; });

    const mockRegistration = {
      pushManager: {
        getSubscription: async () => null,
        subscribe: async () => {
          await pushSubPromise;
          return {
            endpoint: 'https://fcm.googleapis.com/fcm/send/token123',
            toJSON: () => ({
              endpoint: 'https://fcm.googleapis.com/fcm/send/token123',
              keys: { p256dh: VALID_PUBKEY, auth: VALID_AUTH },
            }),
          };
        },
      },
    };

    const service = createWebPushNotificationService({
      db: {} as never,
      now: () => Date.parse('2026-09-10T12:05:00.000Z'),
      backendId: 'self-hosted',
      notificationApi: { permission: 'granted' } as unknown as typeof Notification,
      getServiceWorkerRegistration: async () => mockRegistration as unknown as ServiceWorkerRegistration,
      isIos: () => false,
      hasPushManager: () => true,
      storage: {
        get: async () => null,
        set: async (val) => { localStored = val; },
        clear: async () => { localStored = null; },
      },
      writeSubscription: async () => {},
      deleteSubscription: async () => { revoked = true; },
    });

    // Start subscribe in background
    const subscribePromise = service.subscribe('user-1', sampleProducer);

    // User logs out while subscribe is in-flight
    await service.unsubscribe('user-1');

    // Complete the in-flight push subscription
    resolvePushSub();

    // The in-flight subscribe should reject due to generation guard
    await expect(subscribePromise).rejects.toThrow('cancelled');
    // Local storage should not have stale enrollment
    expect(localStored).toBeNull();
    // Cloud subscription revoked
    // Cancellation before the server write has no orphan cloud enrollment to revoke.
    expect(localStored).toBeNull();
    expect(revoked).toBe(false);
  });

  it('account switch: local enrollment for previous account is not returned for new account', async () => {
    const service = createWebPushNotificationService({
      db: {} as never,
      now: () => Date.parse('2026-09-10T12:05:00.000Z'),
      backendId: 'self-hosted',
      notificationApi: { permission: 'granted' } as unknown as typeof Notification,
      storage: {
        get: async () => ({
          uid: 'user-1',
          backendId: 'self-hosted',
          browserId: 'b-1',
          epoch: 1,
          applicationServerKey: VALID_PUBKEY,
        }),
        set: async () => {},
        clear: async () => {},
      },
    });

    // user-2 should receive null
    const sub = await service.getCurrentSubscription('user-2');
    expect(sub).toBeNull();
  });

  it('epoch-bound revoke: deleteSubscription receives expectedEpoch', async () => {
    let passedEpoch: number | undefined;

    const service = createWebPushNotificationService({
      db: {} as never,
      now: () => Date.parse('2026-09-10T12:05:00.000Z'),
      notificationApi: { permission: 'granted' } as unknown as typeof Notification,
      getServiceWorkerRegistration: async () => undefined,
      storage: {
        get: async () => ({
          uid: 'user-1',
          backendId: 'self-hosted',
          browserId: 'b-1',
          epoch: 42,
          applicationServerKey: VALID_PUBKEY,
        }),
        set: async () => {},
        clear: async () => {},
      },
      deleteSubscription: async (_browserId, expectedEpoch) => {
        passedEpoch = expectedEpoch;
      },
    });

    await service.unsubscribe('user-1');
    expect(passedEpoch).toBe(42);
  });

  it('logout/revoke disables local enrollment first even if offline', async () => {
    let localCleared = false;
    let firestoreDeleteAttempted = false;

    const service = createWebPushNotificationService({
      db: {} as never,
      now: () => Date.parse('2026-09-10T12:05:00.000Z'),
      notificationApi: { permission: 'granted' } as unknown as typeof Notification,
      getServiceWorkerRegistration: async () => undefined,
      storage: {
        get: async () => ({
          uid: 'user-1',
          backendId: 'self-hosted',
          browserId: 'b-1',
          epoch: 1,
          applicationServerKey: VALID_PUBKEY,
        }),
        set: async () => {},
        clear: async () => { localCleared = true; },
      },
      deleteSubscription: async () => {
        firestoreDeleteAttempted = true;
        throw new Error('network offline');
      },
    });

    // Unsubscribe should not throw even if network fails
    await expect(service.unsubscribe('user-1')).resolves.not.toThrow();
    expect(localCleared).toBe(true);
    expect(firestoreDeleteAttempted).toBe(true);
  });
});
