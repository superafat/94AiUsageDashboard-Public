import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { getOrCreateLocalPushKeys } from './local-push-keys';
import { runPushNotificationSync } from './push-runtime';
import type { UsageSnapshot, ProviderPreference, PushPayload } from '@94ai/core';

describe('runPushNotificationSync', () => {
  const clientEcdh = crypto.createECDH('prime256v1');
  clientEcdh.generateKeys();

  const sampleSnapshot: UsageSnapshot = {
    schemaVersion: 1,
    userId: 'user-1',
    deviceId: 'mac-1',
    providerId: 'codex',
    fetchedAt: '2026-09-10T12:00:00.000Z',
    syncedAt: '2026-09-10T12:00:05.000Z',
    expiresAt: '2026-09-10T12:05:00.000Z',
    stale: false,
    resources: {
      session: {
        kind: 'consumption',
        unit: 'percent',
        remaining: 80,
      },
    },
  };

  const samplePref: ProviderPreference = {
    schemaVersion: 1,
    userId: 'user-1',
    family: 'codex',
    enabled: true,
    updatedAt: '2026-09-10T10:00:00.000Z',
    notifications: {
      lowQuota: true,
      reset: true,
    },
  };

  it('baselines new opt-in on first cycle and sends no pushes', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-runtime-test-'));
    try {
      let producerWritten = false;
      let pushesSent = 0;

      const localKeys = await getOrCreateLocalPushKeys({
        rootDir: tempDir,
        backendId: 'test-proj',
        userId: 'user-1',
        deviceId: 'mac-1',
      });
      const publicKey = localKeys.keys!.publicKey;

      const result = await runPushNotificationSync({
        rootDir: tempDir,
        backendId: 'test-proj',
        userId: 'user-1',
        deviceId: 'mac-1',
        projectId: 'test-proj',
        idToken: 'token-123',
        now: () => new Date('2026-09-10T12:00:05.000Z'),
        snapshots: [sampleSnapshot],
        preferences: [samplePref],
        writeProducer: async () => { producerWritten = true; },
        fetchSubscriptions: async () => [
          {
            schemaVersion: 1,
            userId: 'user-1',
            browserId: 'browser-1',
            targetDeviceId: 'mac-1',
            enrollmentEpoch: 1,
            applicationServerKey: publicKey,
            endpoint: 'https://fcm.googleapis.com/fcm/send/token1',
            p256dh: clientEcdh.getPublicKey('base64url'),
            auth: crypto.randomBytes(16).toString('base64url'),
            createdAt: '2026-09-10T10:00:00.000Z',
            expiresAt: '2026-10-10T10:00:00.000Z',
          },
        ],
        sendPush: async () => { pushesSent += 1; return { status: 'accepted', statusCode: 201 }; },
      });

      expect(result.status).toBe('ok');
      expect(result.eventsAccepted).toBe(0);
      expect(producerWritten).toBe(true);
      // First observation baselines without generating an event
      expect(pushesSent).toBe(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('sends push notification on consumption band crossing, respects targetDeviceId, and revokes 410', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-runtime-eval-'));
    try {
      let revokedBrowserId: string | null = null;
      let sentCount = 0;
      let capturedPayload: unknown = null;

      const localKeys = await getOrCreateLocalPushKeys({
        rootDir: tempDir,
        backendId: 'test-proj',
        userId: 'user-1',
        deviceId: 'mac-1',
      });
      const publicKey = localKeys.keys!.publicKey;

      // Cycle 1: baseline at 80% (20% used band)
      await runPushNotificationSync({
        rootDir: tempDir,
        backendId: 'test-proj',
        userId: 'user-1',
        deviceId: 'mac-1',
        projectId: 'test-proj',
        idToken: 'token-123',
        now: () => new Date('2026-09-10T12:00:05.000Z'),
        snapshots: [sampleSnapshot],
        preferences: [samplePref],
        writeProducer: async () => {},
        fetchSubscriptions: async () => [],
      });

      // Cycle 2: consumption to 65% (30% used band crossed)
      const nextSnapshot: UsageSnapshot = {
        ...sampleSnapshot,
        fetchedAt: '2026-09-10T12:05:00.000Z',
        syncedAt: '2026-09-10T12:05:05.000Z',
        expiresAt: '2026-09-10T12:10:00.000Z',
        resources: {
          session: {
            kind: 'consumption',
            unit: 'percent',
            remaining: 65,
          },
        },
      };

      const result = await runPushNotificationSync({
        rootDir: tempDir,
        backendId: 'test-proj',
        userId: 'user-1',
        deviceId: 'mac-1',
        projectId: 'test-proj',
        idToken: 'token-123',
        now: () => new Date('2026-09-10T12:05:05.000Z'),
        snapshots: [nextSnapshot],
        preferences: [samplePref],
        writeProducer: async () => {},
        fetchSubscriptions: async () => [
          {
            schemaVersion: 1,
            userId: 'user-1',
            browserId: 'browser-phone',
            targetDeviceId: 'mac-1', // Targets this Mac!
            enrollmentEpoch: 1,
            applicationServerKey: publicKey,
            endpoint: 'https://fcm.googleapis.com/fcm/send/token1',
            p256dh: clientEcdh.getPublicKey('base64url'),
            auth: crypto.randomBytes(16).toString('base64url'),
            createdAt: '2026-09-10T10:00:00.000Z',
            expiresAt: '2026-10-10T10:00:00.000Z',
          },
          {
            schemaVersion: 1,
            userId: 'user-1',
            browserId: 'browser-other-phone',
            targetDeviceId: 'mac-other', // Targets different Mac, should NOT receive from mac-1!
            enrollmentEpoch: 1,
            applicationServerKey: publicKey,
            endpoint: 'https://fcm.googleapis.com/fcm/send/token2',
            p256dh: clientEcdh.getPublicKey('base64url'),
            auth: crypto.randomBytes(16).toString('base64url'),
            createdAt: '2026-09-10T10:00:00.000Z',
            expiresAt: '2026-10-10T10:00:00.000Z',
          },
        ],
        sendPush: async (_sub, payload) => {
          sentCount += 1;
          capturedPayload = JSON.parse(payload);
          // Simulate 410 Gone for browser-phone
          return { status: 'not_registered', statusCode: 410 };
        },
        revokeSubscription: async (browserId) => {
          revokedBrowserId = browserId;
        },
      });

      expect(result.status).toBe('error');
      expect(result.error).toBe('push_delivery_pending');
      expect(sentCount).toBe(1); // Only sent to browser-phone targeting mac-1
      expect(capturedPayload).toEqual(expect.objectContaining({title: 'Codex · 5 小時額度', body: '已達 35% 耗用，剩餘 65%'}));
      expect(revokedBrowserId).toBe('browser-phone'); // 410 caused revocation
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('delivers push notification and records eventsAccepted on accepted status', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-runtime-accepted-'));
    try {
      const localKeys = await getOrCreateLocalPushKeys({
        rootDir: tempDir,
        backendId: 'test-proj',
        userId: 'user-1',
        deviceId: 'mac-1',
      });
      const publicKey = localKeys.keys!.publicKey;

      // Cycle 1: baseline
      await runPushNotificationSync({
        rootDir: tempDir,
        backendId: 'test-proj',
        userId: 'user-1',
        deviceId: 'mac-1',
        projectId: 'test-proj',
        idToken: 'token-123',
        now: () => new Date('2026-09-10T12:00:05.000Z'),
        snapshots: [sampleSnapshot],
        preferences: [samplePref],
        writeProducer: async () => {},
        fetchSubscriptions: async () => [],
      });

      // Cycle 2: trigger notification
      const nextSnapshot: UsageSnapshot = {
        ...sampleSnapshot,
        fetchedAt: '2026-09-10T12:05:00.000Z',
        syncedAt: '2026-09-10T12:05:05.000Z',
        expiresAt: '2026-09-10T12:10:00.000Z',
        resources: {
          session: {
            kind: 'consumption',
            unit: 'percent',
            remaining: 65,
          },
        },
      };

      const result = await runPushNotificationSync({
        rootDir: tempDir,
        backendId: 'test-proj',
        userId: 'user-1',
        deviceId: 'mac-1',
        projectId: 'test-proj',
        idToken: 'token-123',
        now: () => new Date('2026-09-10T12:05:05.000Z'),
        snapshots: [nextSnapshot],
        preferences: [samplePref],
        writeProducer: async () => {},
        fetchSubscriptions: async () => [
          {
            schemaVersion: 1,
            userId: 'user-1',
            browserId: 'browser-phone',
            targetDeviceId: 'mac-1',
            enrollmentEpoch: 1,
            applicationServerKey: publicKey,
            endpoint: 'https://fcm.googleapis.com/fcm/send/token1',
            p256dh: clientEcdh.getPublicKey('base64url'),
            auth: crypto.randomBytes(16).toString('base64url'),
            createdAt: '2026-09-10T10:00:00.000Z',
            expiresAt: '2026-10-10T10:00:00.000Z',
          },
        ],
        sendPush: async () => ({ status: 'accepted', statusCode: 201 }),
      });

      expect(result.status).toBe('ok');
      expect(result.eventsAccepted).toBe(1);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not collapse weekly and session resource variants into one group', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-runtime-variants-'));
    try {
      const payloads: PushPayload[] = [];
      const localKeys = await getOrCreateLocalPushKeys({
        rootDir: tempDir,
        backendId: 'test-proj',
        userId: 'user-1',
        deviceId: 'mac-1',
      });
      const publicKey = localKeys.keys!.publicKey;

      // Cycle 1: Baseline both session (80% remaining) and weekly (80% remaining)
      const multiResourceSnapshot: UsageSnapshot = {
        ...sampleSnapshot,
        resources: {
          session: { kind: 'consumption', unit: 'percent', remaining: 80 },
          weekly: { kind: 'consumption', unit: 'percent', remaining: 80 },
        },
      };

      await runPushNotificationSync({
        rootDir: tempDir,
        backendId: 'test-proj',
        userId: 'user-1',
        deviceId: 'mac-1',
        projectId: 'test-proj',
        idToken: 'token-123',
        now: () => new Date('2026-09-10T12:00:05.000Z'),
        snapshots: [multiResourceSnapshot],
        preferences: [samplePref],
        writeProducer: async () => {},
        fetchSubscriptions: async () => [],
      });

      // Cycle 2: Both cross thresholds: session -> 65%, weekly -> 45%
      const nextSnapshot: UsageSnapshot = {
        ...multiResourceSnapshot,
        fetchedAt: '2026-09-10T12:05:00.000Z',
        syncedAt: '2026-09-10T12:05:05.000Z',
        expiresAt: '2026-09-10T12:10:00.000Z',
        resources: {
          session: { kind: 'consumption', unit: 'percent', remaining: 65 },
          weekly: { kind: 'consumption', unit: 'percent', remaining: 45 },
        },
      };

      const result = await runPushNotificationSync({
        rootDir: tempDir,
        backendId: 'test-proj',
        userId: 'user-1',
        deviceId: 'mac-1',
        projectId: 'test-proj',
        idToken: 'token-123',
        now: () => new Date('2026-09-10T12:05:05.000Z'),
        snapshots: [nextSnapshot],
        preferences: [samplePref],
        writeProducer: async () => {},
        fetchSubscriptions: async () => [
          {
            schemaVersion: 1,
            userId: 'user-1',
            browserId: 'browser-phone',
            targetDeviceId: 'mac-1',
            enrollmentEpoch: 1,
            applicationServerKey: publicKey,
            endpoint: 'https://fcm.googleapis.com/fcm/send/token1',
            p256dh: clientEcdh.getPublicKey('base64url'),
            auth: crypto.randomBytes(16).toString('base64url'),
            createdAt: '2026-09-10T10:00:00.000Z',
            expiresAt: '2026-10-10T10:00:00.000Z',
          },
        ],
        sendPush: async (_sub, payload) => {
          payloads.push(JSON.parse(payload));
          return { status: 'accepted', statusCode: 201 };
        },
      });

      expect(result.status).toBe('ok');
      expect(payloads.length).toBe(2);
      const titles = payloads.map((p) => p.title).sort();
      expect(titles).toEqual(['Codex · 5 小時額度', 'Codex · 每週額度']);
      const sessionPayload = payloads.find((p) => p.title === 'Codex · 5 小時額度');
      expect(sessionPayload?.body).toBe('已達 35% 耗用，剩餘 65%');
      const weeklyPayload = payloads.find((p) => p.title === 'Codex · 每週額度');
      expect(weeklyPayload?.body).toBe('已達 55% 耗用，剩餘 45%');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('sends reset notification naming the same provider and resource without inventing model text', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-runtime-reset-'));
    try {
      const payloads: PushPayload[] = [];
      const localKeys = await getOrCreateLocalPushKeys({
        rootDir: tempDir,
        backendId: 'test-proj',
        userId: 'user-1',
        deviceId: 'mac-1',
      });
      const publicKey = localKeys.keys!.publicKey;

      // Cycle 1: Baseline at 20% remaining, window ending at 15:00
      const baselineSnapshot: UsageSnapshot = {
        ...sampleSnapshot,
        resources: {
          session: {
            kind: 'consumption',
            unit: 'percent',
            remaining: 20,
            resetsAt: '2026-09-10T15:00:00.000Z',
          },
        },
      };

      await runPushNotificationSync({
        rootDir: tempDir,
        backendId: 'test-proj',
        userId: 'user-1',
        deviceId: 'mac-1',
        projectId: 'test-proj',
        idToken: 'token-123',
        now: () => new Date('2026-09-10T12:00:05.000Z'),
        snapshots: [baselineSnapshot],
        preferences: [samplePref],
        writeProducer: async () => {},
        fetchSubscriptions: async () => [],
      });

      // Cycle 2: Confirmed reset! Window advanced to 20:00, remaining replenished to 100%
      const resetSnapshot: UsageSnapshot = {
        ...baselineSnapshot,
        fetchedAt: '2026-09-10T15:01:00.000Z',
        syncedAt: '2026-09-10T15:01:05.000Z',
        expiresAt: '2026-09-10T15:06:00.000Z',
        resources: {
          session: {
            kind: 'consumption',
            unit: 'percent',
            remaining: 100,
            resetsAt: '2026-09-10T20:00:00.000Z',
          },
        },
      };

      const result = await runPushNotificationSync({
        rootDir: tempDir,
        backendId: 'test-proj',
        userId: 'user-1',
        deviceId: 'mac-1',
        projectId: 'test-proj',
        idToken: 'token-123',
        now: () => new Date('2026-09-10T15:01:05.000Z'),
        snapshots: [resetSnapshot],
        preferences: [samplePref],
        writeProducer: async () => {},
        fetchSubscriptions: async () => [
          {
            schemaVersion: 1,
            userId: 'user-1',
            browserId: 'browser-phone',
            targetDeviceId: 'mac-1',
            enrollmentEpoch: 1,
            applicationServerKey: publicKey,
            endpoint: 'https://fcm.googleapis.com/fcm/send/token1',
            p256dh: clientEcdh.getPublicKey('base64url'),
            auth: crypto.randomBytes(16).toString('base64url'),
            createdAt: '2026-09-10T10:00:00.000Z',
            expiresAt: '2026-10-10T10:00:00.000Z',
          },
        ],
        sendPush: async (_sub, payload) => {
          payloads.push(JSON.parse(payload));
          return { status: 'accepted', statusCode: 201 };
        },
      });

      expect(result.status).toBe('ok');
      expect(payloads.length).toBe(1);
      expect(payloads[0]!.title).toBe('Codex · 5 小時額度已重置');
      expect(payloads[0]!.body).toBe('額度已確認恢復，點此查看。');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('respects preference switches and suppresses notifications when disabled', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-runtime-prefs-'));
    try {
      let pushesSent = 0;
      const localKeys = await getOrCreateLocalPushKeys({
        rootDir: tempDir,
        backendId: 'test-proj',
        userId: 'user-1',
        deviceId: 'mac-1',
      });
      const publicKey = localKeys.keys!.publicKey;

      // Pref with lowQuota disabled
      const prefNoLowQuota: ProviderPreference = {
        ...samplePref,
        notifications: {
          lowQuota: false,
          reset: true,
        },
      };

      // Cycle 1: Baseline
      await runPushNotificationSync({
        rootDir: tempDir,
        backendId: 'test-proj',
        userId: 'user-1',
        deviceId: 'mac-1',
        projectId: 'test-proj',
        idToken: 'token-123',
        now: () => new Date('2026-09-10T12:00:05.000Z'),
        snapshots: [sampleSnapshot],
        preferences: [prefNoLowQuota],
        writeProducer: async () => {},
        fetchSubscriptions: async () => [],
      });

      // Cycle 2: Consumption threshold crossed, but lowQuota preference is false
      const nextSnapshot: UsageSnapshot = {
        ...sampleSnapshot,
        fetchedAt: '2026-09-10T12:05:00.000Z',
        syncedAt: '2026-09-10T12:05:05.000Z',
        expiresAt: '2026-09-10T12:10:00.000Z',
        resources: {
          session: { kind: 'consumption', unit: 'percent', remaining: 65 },
        },
      };

      await runPushNotificationSync({
        rootDir: tempDir,
        backendId: 'test-proj',
        userId: 'user-1',
        deviceId: 'mac-1',
        projectId: 'test-proj',
        idToken: 'token-123',
        now: () => new Date('2026-09-10T12:05:05.000Z'),
        snapshots: [nextSnapshot],
        preferences: [prefNoLowQuota],
        writeProducer: async () => {},
        fetchSubscriptions: async () => [
          {
            schemaVersion: 1,
            userId: 'user-1',
            browserId: 'browser-phone',
            targetDeviceId: 'mac-1',
            enrollmentEpoch: 1,
            applicationServerKey: publicKey,
            endpoint: 'https://fcm.googleapis.com/fcm/send/token1',
            p256dh: clientEcdh.getPublicKey('base64url'),
            auth: crypto.randomBytes(16).toString('base64url'),
            createdAt: '2026-09-10T10:00:00.000Z',
            expiresAt: '2026-10-10T10:00:00.000Z',
          },
        ],
        sendPush: async () => {
          pushesSent += 1;
          return { status: 'accepted', statusCode: 201 };
        },
      });

      expect(pushesSent).toBe(0); // Suppressed by preference!
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
