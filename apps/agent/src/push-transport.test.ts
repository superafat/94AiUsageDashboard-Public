import { describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import type {RequestOptions} from 'node:https';
import webPush from 'web-push';
import { sendPushNotification, isRoutableIp } from './push-transport';

describe('isRoutableIp', () => {
  it('accepts public IPv4 and IPv6 addresses', () => {
    expect(isRoutableIp('142.250.190.46')).toBe(true); // Google public IP
    expect(isRoutableIp('2607:f8b0:4005:805::200e')).toBe(true);
  });

  it('rejects loopback, private, link-local, multicast, and mapped IPs', () => {
    expect(isRoutableIp('127.0.0.1')).toBe(false);
    expect(isRoutableIp('127.1.2.3')).toBe(false);
    expect(isRoutableIp('10.0.0.1')).toBe(false);
    expect(isRoutableIp('172.16.0.1')).toBe(false);
    expect(isRoutableIp('172.31.255.255')).toBe(false);
    expect(isRoutableIp('192.168.1.1')).toBe(false);
    expect(isRoutableIp('169.254.1.1')).toBe(false);
    expect(isRoutableIp('224.0.0.1')).toBe(false);
    expect(isRoutableIp('255.255.255.255')).toBe(false);
    expect(isRoutableIp('0.0.0.0')).toBe(false);
    expect(isRoutableIp('::1')).toBe(false);
    expect(isRoutableIp('fe80::1')).toBe(false);
    expect(isRoutableIp('fc00::1')).toBe(false);
    expect(isRoutableIp('::ffff:127.0.0.1')).toBe(false);
    expect(isRoutableIp('::ffff:192.168.1.1')).toBe(false);
  });
});

describe('sendPushNotification', () => {
  const vapid = webPush.generateVAPIDKeys();
  const clientEcdh = crypto.createECDH('prime256v1');
  clientEcdh.generateKeys();
  const validSubscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/sample-token',
    keys: {
      p256dh: clientEcdh.getPublicKey('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  };
  const validPayload = JSON.stringify({
    version: 1,
    browserId: 'browser-1',
    epoch: 1,
    eventId: 'qne_123',
    type: 'consumption',
    observedAt: '2026-09-10T12:00:00.000Z',
    expiresAt: '2026-09-10T12:30:00.000Z',
    title: 'AI 額度消耗通知',
    body: '有來源達到新的耗用門檻，點此查看。',
  });

  it('rejects illegal endpoint before any DNS or network call', async () => {
    let dnsCalled = false;
    const result = await sendPushNotification({
      subscription: { ...validSubscription, endpoint: 'https://evil.attacker.com/push' },
      payload: validPayload,
      vapidKeys: vapid,
      dnsLookup: async () => { dnsCalled = true; return ['142.250.190.46']; },
    });
    expect(dnsCalled).toBe(false);
    expect(result.status).toBe('rejected');
    expect(result.errorCategory).toBe('illegal_endpoint');
  });

  it('rejects DNS rebinding / private IP resolution', async () => {
    let httpCalled = false;
    const result = await sendPushNotification({
      subscription: validSubscription,
      payload: validPayload,
      vapidKeys: vapid,
      dnsLookup: async () => ['127.0.0.1'], // resolved to loopback
      httpRequest: async () => { httpCalled = true; return { statusCode: 201, headers: {} }; },
    });
    expect(httpCalled).toBe(false);
    expect(result.status).toBe('rejected');
    expect(result.errorCategory).toBe('dns_private_ip');
  });

  it('delivers notification with real local encryption and mocked HTTPS transport', async () => {
    const capture: {options?: RequestOptions} = {};
    let capturedBodyLength = 0;

    const result = await sendPushNotification({
      subscription: validSubscription,
      payload: validPayload,
      vapidKeys: vapid,
      dnsLookup: async () => ['142.250.190.46'],
      httpRequest: async (options, body) => {
        capture.options = options;
        capturedBodyLength = body.length;
        return { statusCode: 201, headers: {} };
      },
    });

    expect(result.status).toBe('accepted');
    expect(result.statusCode).toBe(201);
    expect(capture.options?.host).toBe('142.250.190.46'); // Pinned IP
    expect(capture.options?.servername).toBe('fcm.googleapis.com'); // Original SNI
    const authHeader = (capture.options?.headers as Record<string,string>).authorization ?? (capture.options?.headers as Record<string,string>).Authorization;
    expect(authHeader).toMatch(/^(?:webpush|vapid)\s+/i);
    expect(capturedBodyLength).toBeGreaterThan(0);
    expect(capturedBodyLength).toBeLessThanOrEqual(2048);
  });

  it('maps 404/410 to not_registered', async () => {
    const result = await sendPushNotification({
      subscription: validSubscription,
      payload: validPayload,
      vapidKeys: vapid,
      dnsLookup: async () => ['142.250.190.46'],
      httpRequest: async () => ({ statusCode: 410, headers: {} }),
    });
    expect(result.status).toBe('not_registered');
    expect(result.statusCode).toBe(410);
  });

  it('maps 429 to rate_limited', async () => {
    const result = await sendPushNotification({
      subscription: validSubscription,
      payload: validPayload,
      vapidKeys: vapid,
      dnsLookup: async () => ['142.250.190.46'],
      httpRequest: async () => ({ statusCode: 429, headers: {} }),
    });
    expect(result.status).toBe('rate_limited');
  });

  it('maps 5xx and network errors to transient_error', async () => {
    const result503 = await sendPushNotification({
      subscription: validSubscription,
      payload: validPayload,
      vapidKeys: vapid,
      dnsLookup: async () => ['142.250.190.46'],
      httpRequest: async () => ({ statusCode: 503, headers: {} }),
    });
    expect(result503.status).toBe('transient_error');

    const resultTimeout = await sendPushNotification({
      subscription: validSubscription,
      payload: validPayload,
      vapidKeys: vapid,
      dnsLookup: async () => ['142.250.190.46'],
      httpRequest: async () => { throw new Error('connection timeout'); },
    });
    expect(resultTimeout.status).toBe('transient_error');
  });
});
