import { describe, expect, it } from 'vitest';
import {
  writePushProducerRest,
  readPushSubscriptionsRest,
  deletePushSubscriptionRest,
} from './push-store';
import type { PushProducerRecord, PushSubscriptionRecord } from '@94ai/core';

describe('push-store REST methods', () => {
  const sampleProducer: PushProducerRecord = {
    schemaVersion: 1,
    userId: 'user-1',
    deviceId: 'mac-1',
    publicKey: 'BFRdOgvw1mGS7riy-AmAm8sq3A3yTouaefCn1Nnv1YFJXopKLfRAzMX1AQGvq_xGiBUdoWCfuZjeOFq9lDn7aDo',
    updatedAt: '2026-09-10T12:00:00.000Z',
  };

  const sampleSubscription: PushSubscriptionRecord = {
    schemaVersion: 1,
    userId: 'user-1',
    browserId: 'browser-1',
    targetDeviceId: 'mac-1',
    enrollmentEpoch: 1,
    applicationServerKey: 'BFRdOgvw1mGS7riy-AmAm8sq3A3yTouaefCn1Nnv1YFJXopKLfRAzMX1AQGvq_xGiBUdoWCfuZjeOFq9lDn7aDo',
    endpoint: 'https://fcm.googleapis.com/fcm/send/token123',
    p256dh: 'BFRdOgvw1mGS7riy-AmAm8sq3A3yTouaefCn1Nnv1YFJXopKLfRAzMX1AQGvq_xGiBUdoWCfuZjeOFq9lDn7aDo',
    auth: '8vyc8x-TXwGwYgjlAic24w',
    createdAt: '2026-09-10T12:00:00.000Z',
    expiresAt: '2026-10-10T12:00:00.000Z',
  };

  it('writes producer using REST with proper authorization and body', async () => {
    let requestedUrl = '';
    let method = '';
    let authHeader = '';
    let body = '';

    const mockFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requestedUrl = String(input);
      method = init?.method ?? '';
      authHeader = (init?.headers as Record<string, string>)?.authorization ?? '';
      body = String(init?.body ?? '');
      return new Response(JSON.stringify({}), { status: 200 });
    };

    await writePushProducerRest('test-proj', 'token-abc', sampleProducer, mockFetch, undefined, 'user-1');

    expect(requestedUrl).toContain('pushProducers/mac-1');
    expect(method).toBe('PATCH');
    expect(authHeader).toBe('Bearer token-abc');
    expect(JSON.parse(body).fields.publicKey.stringValue).toBe(sampleProducer.publicKey);
  });

  it('rejects cross-UID producer writes', async () => {
    const wrongUidProducer = { ...sampleProducer, userId: 'wrong-uid' };
    const mockFetch = async (): Promise<Response> => new Response(JSON.stringify({}), { status: 200 });
    await expect(writePushProducerRest('test-proj', 'token-abc', wrongUidProducer, mockFetch, undefined, 'user-1'))
      .rejects.toThrow();
  });

  it('reads push subscriptions and enforces max 10 bounds', async () => {
    const mockFetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({
        documents: [
          {
            name: 'projects/test-proj/databases/(default)/documents/users/user-1/pushSubscriptions/browser-1',
            fields: {
              schemaVersion: { integerValue: '1' },
              userId: { stringValue: 'user-1' },
              browserId: { stringValue: 'browser-1' },
              targetDeviceId: { stringValue: 'mac-1' },
              enrollmentEpoch: { integerValue: '1' },
              applicationServerKey: { stringValue: sampleSubscription.applicationServerKey },
              endpoint: { stringValue: sampleSubscription.endpoint },
              p256dh: { stringValue: sampleSubscription.p256dh },
              auth: { stringValue: sampleSubscription.auth },
              createdAt: { stringValue: sampleSubscription.createdAt },
              expiresAt: { stringValue: sampleSubscription.expiresAt },
            },
          },
        ],
      }), { status: 200 });
    };

    const subs = await readPushSubscriptionsRest('test-proj', 'token-abc', 'user-1', mockFetch);
    expect(subs).toHaveLength(1);
    expect(subs[0]!.browserId).toBe('browser-1');
  });

  it('deletes subscription via REST', async () => {
    let deletedUrl = '';
    const mockFetch = async (input: string | URL | Request): Promise<Response> => {
      deletedUrl = String(input);
      return new Response('{}', { status: 200 });
    };

    await deletePushSubscriptionRest('test-proj', 'token-abc', 'user-1', 'browser-1', mockFetch);
    expect(deletedUrl).toContain('pushSubscriptions/browser-1');
  });
});

it('uses a real Firestore query parameter, not an encoded collection name',async()=>{
 let seen='';const fake=async(url: string | URL | Request)=>{seen=String(url);return new Response('{}',{status:200});};
 await readPushSubscriptionsRest('demo-project','synthetic-token','alice',fake);
 const parsed=new URL(seen);
 expect(parsed.pathname).toBe('/v1/projects/demo-project/databases/(default)/documents/users/alice/pushSubscriptions');
 expect(parsed.searchParams.get('pageSize')).toBe('21');
});

it('keeps cancellation active until the full Firestore response body is consumed',async()=>{
 const abort=new AbortController();let cancelled=false;
 const body=new ReadableStream<Uint8Array>({pull:()=>new Promise(()=>undefined),cancel:()=>{cancelled=true;}});
 const pending=readPushSubscriptionsRest('demo-project','synthetic-token','alice',async()=>new Response(body),abort.signal);
 const rejected=expect(pending).rejects.toThrow();setTimeout(()=>abort.abort(new Error('synthetic deadline')),10);
 await rejected;expect(cancelled).toBe(true);
},500);
