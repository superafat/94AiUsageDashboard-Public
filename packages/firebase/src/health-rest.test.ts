import { describe, expect, it } from 'vitest';
import { healthDocPath } from './paths';
import { writeDeviceHealthRest } from './health-rest';

const health = {
  schemaVersion: 1 as const,
  userId: 'alice', deviceId: 'device-1', updatedAt: '2026-09-06T10:00:00.000Z',
  engine: 'ready' as const, background: 'ready' as const, sync: 'ready' as const,
  providerReadyCount: 3, providerWarningCount: 1,
};

describe('device health Firestore REST', () => {
  it('uses a stable owner/device health path', () => {
    expect(healthDocPath('alice', 'device-1')).toBe('users/alice/devices/device-1/health/current');
    expect(() => healthDocPath('alice/bob', 'device-1')).toThrow(/segment/i);
  });

  it('writes only canonical health fields with the Firebase ID token in the header', async () => {
    let url = ''; let body = ''; let authorization = '';
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      url = String(input); body = String(init?.body ?? '');
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      return new Response('{}', { status: 200 });
    };
    await writeDeviceHealthRest('demo', 'firebase-id-token', health, fakeFetch);
    expect(url).toContain('/users/alice/devices/device-1/health/current');
    expect(authorization).toBe('Bearer firebase-id-token');
    expect(body).toContain('providerReadyCount');
    expect(body).not.toMatch(/stderr|localPath|providerToken/i);
  });

  it('rejects secret-bearing health before network access', async () => {
    let called = false;
    const fakeFetch = async () => { called = true; return new Response('{}'); };
    await expect(writeDeviceHealthRest('demo', 'firebase-id-token', { ...health, token: 'private' } as never, fakeFetch)).rejects.toThrow(/unknown field/i);
    expect(called).toBe(false);
  });

  it('honors caller AbortSignal and aborts in-flight fetch in writeDeviceHealthRest', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const fakeFetch = async (_input: string | URL | Request, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_, reject) => {
        if (init?.signal) {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }
      });
    };

    const writePromise = writeDeviceHealthRest('demo', 'firebase-id-token', health, fakeFetch, controller.signal);
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(false);
    controller.abort();
    await expect(writePromise).rejects.toThrow();
    expect(observedSignal?.aborted).toBe(true);
  });
});
