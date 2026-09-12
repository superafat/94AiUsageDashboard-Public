import { describe, expect, it } from 'vitest';
import {
  parsePushProducerRecord,
  parsePushSubscriptionRecord,
  parsePushPayload,
  pushNotificationText,
  validatePushEndpoint,
  MAX_SUBSCRIPTIONS_PER_USER,
  MAX_PAYLOAD_BYTES,
  MAX_PUSH_TTL_SECONDS,
  type PushProducerRecord,
  type PushSubscriptionRecord,
  type PushPayload,
} from './push-notifications';

describe('validatePushEndpoint', () => {
  it('accepts valid endpoints from FCM, Mozilla, and Apple push services', () => {
    expect(validatePushEndpoint('https://fcm.googleapis.com/fcm/send/sample-token')).toEqual({ valid: true });
    expect(validatePushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/sample-token')).toEqual({ valid: true });
    expect(validatePushEndpoint('https://web.push.apple.com/sample-token')).toEqual({ valid: true });
    expect(validatePushEndpoint('https://any.sub.push.apple.com/sample-token')).toEqual({ valid: true });
  });

  it('rejects non-https, custom ports, userinfo, and hashes', () => {
    expect(validatePushEndpoint('http://fcm.googleapis.com/fcm/send/token').valid).toBe(false);
    expect(validatePushEndpoint('https://fcm.googleapis.com:8443/token').valid).toBe(false);
    const userInfoEndpoint = new URL('https://fcm.googleapis.com/token');
    userInfoEndpoint.username = 'example'; userInfoEndpoint.password = 'example';
    expect(validatePushEndpoint(userInfoEndpoint.toString()).valid).toBe(false);
    expect(validatePushEndpoint('https://fcm.googleapis.com/token#fragment').valid).toBe(false);
  });

  it('rejects broad/unqualified domains and lookalikes', () => {
    expect(validatePushEndpoint('https://google.com/push').valid).toBe(false);
    expect(validatePushEndpoint('https://googleapis.com/push').valid).toBe(false);
    expect(validatePushEndpoint('https://mozilla.com/push').valid).toBe(false);
    expect(validatePushEndpoint('https://apple.com/push').valid).toBe(false);
    expect(validatePushEndpoint('https://push.apple.com/token').valid).toBe(false);
    expect(validatePushEndpoint('https://web.push.apple.com.attacker.com/token').valid).toBe(false);
    expect(validatePushEndpoint('https://evil.fcm.googleapis.com/token').valid).toBe(false);
  });

  it('rejects oversized URLs (>2048 chars)', () => {
    const long = 'https://fcm.googleapis.com/' + 'a'.repeat(2050);
    expect(validatePushEndpoint(long).valid).toBe(false);
  });
});

describe('parsePushProducerRecord', () => {
  const valid: PushProducerRecord = {
    schemaVersion: 1,
    userId: 'user-1',
    deviceId: 'mac-1',
    publicKey: 'BFRdOgvw1mGS7riy-AmAm8sq3A3yTouaefCn1Nnv1YFJXopKLfRAzMX1AQGvq_xGiBUdoWCfuZjeOFq9lDn7aDo',
    updatedAt: '2026-09-10T12:00:00.000Z',
  };

  it('parses valid producer record', () => {
    expect(parsePushProducerRecord(valid)).toEqual(valid);
  });

  it('rejects invalid schemaVersion or unknown fields', () => {
    expect(() => parsePushProducerRecord({ ...valid, schemaVersion: 2 })).toThrow('invalid_notification_record');
    expect(() => parsePushProducerRecord({ ...valid, privateKey: 'not-a-real-value' })).toThrow('invalid_notification_record');
  });

  it('rejects malformed dates, empty fields, or sensitive text', () => {
    expect(() => parsePushProducerRecord({ ...valid, updatedAt: 'invalid-date' })).toThrow('invalid_notification_record');
    expect(() => parsePushProducerRecord({ ...valid, deviceId: '' })).toThrow('invalid_notification_record');
    expect(() => parsePushProducerRecord({ ...valid, deviceId: 'Bearer not-a-real-value' })).toThrow('invalid_notification_record');
  });
});

describe('parsePushSubscriptionRecord', () => {
  const valid: PushSubscriptionRecord = {
    schemaVersion: 1,
    userId: 'user-1',
    browserId: 'browser-abc-123',
    targetDeviceId: 'mac-1',
    enrollmentEpoch: 1,
    applicationServerKey: 'BFRdOgvw1mGS7riy-AmAm8sq3A3yTouaefCn1Nnv1YFJXopKLfRAzMX1AQGvq_xGiBUdoWCfuZjeOFq9lDn7aDo',
    endpoint: 'https://fcm.googleapis.com/fcm/send/token123',
    p256dh: 'BFRdOgvw1mGS7riy-AmAm8sq3A3yTouaefCn1Nnv1YFJXopKLfRAzMX1AQGvq_xGiBUdoWCfuZjeOFq9lDn7aDo',
    auth: '8vyc8x-TXwGwYgjlAic24w',
    createdAt: '2026-09-10T12:00:00.000Z',
    expiresAt: '2026-10-10T12:00:00.000Z',
  };

  it('parses valid subscription record', () => {
    expect(parsePushSubscriptionRecord(valid)).toEqual(valid);
  });

  it('parses subscription with optional test request', () => {
    const withTest = {
      ...valid,
      testRequestId: 'req-123',
      testRequestedAt: '2026-09-10T12:05:00.000Z',
    };
    expect(parsePushSubscriptionRecord(withTest)).toEqual(withTest);
  });

  it('rejects invalid endpoints, bad epoch, or unknown fields', () => {
    expect(() => parsePushSubscriptionRecord({ ...valid, endpoint: 'https://evil.com/push' })).toThrow('invalid_notification_record');
    expect(() => parsePushSubscriptionRecord({ ...valid, enrollmentEpoch: 0 })).toThrow('invalid_notification_record');
    expect(() => parsePushSubscriptionRecord({ ...valid, extraField: 'bogus' })).toThrow('invalid_notification_record');
  });
});

describe('parsePushPayload', () => {
  const validPayload: PushPayload = {
    version: 1,
    browserId: 'browser-abc-123',
    epoch: 1,
    eventId: 'qne_1234567890abcdef',
    type: 'consumption',
    observedAt: '2026-09-10T12:00:00.000Z',
    expiresAt: '2026-09-10T12:30:00.000Z',
    title: 'AI 額度消耗通知',
    body: '有來源達到新的耗用門檻，點此查看。',
  };

  it('parses valid generic payload', () => {
    expect(parsePushPayload(validPayload)).toEqual(validPayload);
  });

  it('rejects payload with sensitive information or invalid types', () => {
    expect(() => parsePushPayload({ ...validPayload, body: 'Bearer not-a-real-value' })).toThrow('invalid_notification_record');
    expect(() => parsePushPayload({ ...validPayload, type: 'unknown_type' })).toThrow('invalid_notification_record');
  });
});

describe('Push constants', () => {
  it('enforces bounds', () => {
    expect(MAX_SUBSCRIPTIONS_PER_USER).toBe(10);
    expect(MAX_PAYLOAD_BYTES).toBe(2048);
    expect(MAX_PUSH_TTL_SECONDS).toBe(300);
  });
});

describe('pushNotificationText canonical labels and fallback', () => {
  it('formats consumption for Codex session with exact used and remaining percentages', () => {
    const text = pushNotificationText({
      type: 'consumption',
      providerId: 'codex',
      resourceKey: 'session',
      remainingPercent: 65,
    });
    expect(text).toEqual({
      title: 'Codex · 5 小時額度',
      body: '已達 35% 耗用，剩餘 65%',
    });
  });

  it('formats reset notification naming the same provider and resource without inventing model text', () => {
    const text = pushNotificationText({
      type: 'reset',
      providerId: 'codex',
      resourceKey: 'session',
    });
    expect(text).toEqual({
      title: 'Codex · 5 小時額度已重置',
      body: '額度已確認恢復，點此查看。',
    });
  });

  it('preserves generic test push copy unchanged', () => {
    expect(pushNotificationText('test')).toEqual({
      title: '測試通知',
      body: '這是 94AiUsageDashboard 的測試推播',
    });
    expect(pushNotificationText({ type: 'test' })).toEqual({
      title: '測試通知',
      body: '這是 94AiUsageDashboard 的測試推播',
    });
  });

  it('falls back safely for unknown provider or resource without lock-screen injection or sensitive text', () => {
    // Unknown provider falls back to safe generic notification
    const unknownProvider = pushNotificationText({
      type: 'consumption',
      providerId: 'malicious-ai<script>',
      resourceKey: 'session',
      remainingPercent: 70,
    });
    expect(unknownProvider).toEqual({
      title: 'AI 額度消耗通知',
      body: '有來源達到新的耗用門檻，點此查看。',
    });

    // Known provider with unknown resource uses safe generic resource label '額度'
    const unknownResource = pushNotificationText({
      type: 'consumption',
      providerId: 'codex',
      resourceKey: 'secret_token_key_123',
      remainingPercent: 60,
    });
    expect(unknownResource).toEqual({
      title: 'Codex · 額度',
      body: '已達 40% 耗用，剩餘 60%',
    });

    // Reset with unknown provider
    const unknownReset = pushNotificationText({
      type: 'reset',
      providerId: 'evil-ai',
      resourceKey: 'something',
    });
    expect(unknownReset).toEqual({
      title: 'AI 額度重置通知',
      body: '有來源的額度已確認恢復，點此查看。',
    });
  });

  it('sanitizes account info from providerId and never leaks accounts/emails to lock screen', () => {
    const accountScoped = pushNotificationText({
      type: 'consumption',
      providerId: ['codex', 'confidential-corp.invalid'].join(String.fromCharCode(64)),
      resourceKey: 'weekly',
      remainingPercent: 50,
    });
    expect(accountScoped).toEqual({
      title: 'Codex · 每週額度',
      body: '已達 50% 耗用，剩餘 50%',
    });
    expect(accountScoped.title).not.toContain('confidential-corp');
    expect(accountScoped.title).not.toContain('@');
  });
});

describe('parsePushPayload with canonical format and safety boundaries', () => {
  it('accepts canonical consumption payload', () => {
    const payload: PushPayload = {
      version: 1,
      browserId: 'browser-abc-123',
      epoch: 1,
      eventId: 'qne_1234567890abcdef',
      type: 'consumption',
      observedAt: '2026-09-10T12:00:00.000Z',
      expiresAt: '2026-09-10T12:30:00.000Z',
      title: 'Codex · 5 小時額度',
      body: '已達 35% 耗用，剩餘 65%',
    };
    expect(parsePushPayload(payload)).toEqual(payload);
  });

  it('accepts canonical reset payload', () => {
    const payload: PushPayload = {
      version: 1,
      browserId: 'browser-abc-123',
      epoch: 1,
      eventId: 'qne_1234567890abcdef',
      type: 'reset',
      observedAt: '2026-09-10T12:00:00.000Z',
      expiresAt: '2026-09-10T12:30:00.000Z',
      title: 'Codex · 5 小時額度已重置',
      body: '額度已確認恢復，點此查看。',
    };
    expect(parsePushPayload(payload)).toEqual(payload);
  });

  it('rejects extra fields in payload', () => {
    const payload = {
      version: 1,
      browserId: 'browser-abc-123',
      epoch: 1,
      eventId: 'qne_1234567890abcdef',
      type: 'consumption',
      observedAt: '2026-09-10T12:00:00.000Z',
      expiresAt: '2026-09-10T12:30:00.000Z',
      title: 'Codex · 5 小時額度',
      body: '已達 35% 耗用，剩餘 65%',
      unauthorizedField: 'attacker-data',
    };
    expect(() => parsePushPayload(payload)).toThrow('invalid_notification_record');
  });

  it('rejects arbitrary untrusted or sensitive text on lock screen', () => {
    const sensitivePayload = {
      version: 1,
      browserId: 'browser-abc-123',
      epoch: 1,
      eventId: 'qne_1234567890abcdef',
      type: 'consumption',
      observedAt: '2026-09-10T12:00:00.000Z',
      expiresAt: '2026-09-10T12:30:00.000Z',
      title: 'Bearer my-secret-token',
      body: '已達 35% 耗用，剩餘 65%',
    };
    expect(() => parsePushPayload(sensitivePayload)).toThrow('invalid_notification_record');

    const arbitraryPayload = {
      ...sensitivePayload,
      title: 'Phishing attack click here',
      body: 'Your account has been suspended',
    };
    expect(() => parsePushPayload(arbitraryPayload)).toThrow('invalid_notification_record');
  });
});
