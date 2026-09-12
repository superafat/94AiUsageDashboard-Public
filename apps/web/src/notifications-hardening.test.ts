import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebPushNotificationService, urlBase64ToUint8Array, type LocalEnrollment, type PushStorage } from './notifications';
import type { PushProducerRecord, PushSubscriptionRecord } from '@94ai/core';
const now = Date.parse('2026-09-11T03:00:00.000Z');
const key = 'BFRdOgvw1mGS7riy-AmAm8sq3A3yTouaefCn1Nnv1YFJXopKLfRAzMX1AQGvq_xGiBUdoWCfuZjeOFq9lDn7aDo';
const auth = '8vyc8x-TXwGwYgjlAic24w';
const producer: PushProducerRecord = {schemaVersion:1,userId:'alice',deviceId:'mac-one',publicKey:key,updatedAt:new Date(now).toISOString()};
function harness() {
  let local: LocalEnrollment | null = null;
  let remote: PushSubscriptionRecord | undefined;
  const storage: PushStorage = {get:async()=>local,set:async v=>{local=v;},clear:async()=>{local=null;}};
  const native = {endpoint:'https://fcm.googleapis.com/fcm/send/synthetic',options:{applicationServerKey:new Uint8Array(Buffer.from(key,'base64url')).buffer},toJSON:()=>({keys:{p256dh:key,auth}}),unsubscribe:vi.fn(async()=>true)};
  const manager = {getSubscription:vi.fn(async()=>native),subscribe:vi.fn(async()=>native)};
  const deps = {db:{} as never,backendId:'demo-project',now:()=>now,hasPushManager:()=>true,isIos:()=>false,notificationApi:{permission:'granted',requestPermission:async()=>'granted'} as unknown as typeof Notification,getServiceWorkerRegistration:async()=>({pushManager:manager} as unknown as ServiceWorkerRegistration),storage,writeSubscription:vi.fn(async (v:PushSubscriptionRecord)=>{remote=v;}),deleteSubscription:vi.fn(async()=>undefined)};
  return {deps,manager,storage,getLocal:()=>local,getRemote:()=>remote,setLocal:(v:LocalEnrollment)=>{local=v;}};
}
afterEach(()=>vi.unstubAllGlobals());
describe('browser enrollment correctness',()=>{
 it('rejects another user producer before browser or cloud mutation',async()=>{
  const h=harness(),service=createWebPushNotificationService(h.deps);
  await expect(service.subscribe('alice',{...producer,userId:'bob'})).rejects.toThrow();
  expect(h.manager.subscribe).not.toHaveBeenCalled();expect(h.deps.writeSubscription).not.toHaveBeenCalled();
 });
 it('rejects stale producer metadata instead of enrolling an unavailable Mac',async()=>{
  const h=harness();await expect(createWebPushNotificationService(h.deps).subscribe('alice',{...producer,updatedAt:new Date(now-900_000).toISOString()})).rejects.toThrow();
  expect(h.manager.subscribe).not.toHaveBeenCalled();
 });
 it('returns the confirmed subscription, not blank invented endpoint and dates',async()=>{
  const h=harness(),service=createWebPushNotificationService(h.deps);
  const saved=await service.subscribe('alice',producer);
  expect(await service.getCurrentSubscription('alice')).toEqual(saved);
 });
 it('never reports a current subscription when the browser registration is missing',async()=>{
  const h=harness();h.setLocal({uid:'alice',backendId:'demo-project',browserId:'old-browser',epoch:1,applicationServerKey:key});
  const service=createWebPushNotificationService({...h.deps,getServiceWorkerRegistration:async()=>undefined});
  expect(await service.getCurrentSubscription('alice')).toBeNull();
 });
 it('does not re-enable enrollment when local save completes after logout',async()=>{
  const h=harness();let release!:()=>void,entered!:()=>void;
  const began=new Promise<void>(r=>{entered=r;});const wait=new Promise<void>(r=>{release=r;});const original=h.storage.set;
  h.storage.set=async v=>{entered();await wait;await original(v);};
  const service=createWebPushNotificationService(h.deps);
  const pending=service.subscribe('alice',producer);const rejected=expect(pending).rejects.toThrow(/cancel/i);
  await began;const out=service.unsubscribe('alice');release();await out;await rejected;
  expect(h.getLocal()).toBeNull();
 });
 it('refuses a test request targeting a different backend/device',async()=>{
  const h=harness();const requestTestPush=vi.fn(async()=>undefined);
  const service=createWebPushNotificationService({...h.deps,requestTestPush});
  await service.subscribe('alice',producer);
  await expect(service.requestTestPush('alice','another-mac')).rejects.toThrow();
  expect(requestTestPush).not.toHaveBeenCalled();
 });
});
function idbWithAbort(abortWrites=false) {
 const stores=new Set<string>();
 const db={objectStoreNames:{contains:(n:string)=>stores.has(n)},createObjectStore:(n:string)=>{stores.add(n);return{clear:()=>undefined};},close:()=>undefined,
 transaction:(_name:string,mode:string)=>{
  const tx:{oncomplete:(()=>void)|null;onabort:(()=>void)|null;onerror:(()=>void)|null;error:Error|null;objectStore:(n:string)=>unknown}={oncomplete:null,onabort:null,onerror:null,error:null,objectStore:()=>undefined};
  const request=(result:unknown)=>{const req:{result:unknown;onsuccess:(()=>void)|null;onerror:(()=>void)|null}={result,onsuccess:null,onerror:null};queueMicrotask(()=>{req.onsuccess?.();queueMicrotask(()=>{if(abortWrites&&mode==='readwrite'){tx.error=new Error('synthetic_abort');tx.onabort?.();}else tx.oncomplete?.();});});return req;};
  tx.objectStore=()=>({get:()=>request(null),put:()=>request('current'),delete:()=>request(undefined)});return tx;
 }};
 return {stores,api:{open:()=>{const r:{result:typeof db;onupgradeneeded:((e:unknown)=>void)|null;onsuccess:(()=>void)|null;onerror:(()=>void)|null;onblocked:(()=>void)|null}={result:db,onupgradeneeded:null,onsuccess:null,onerror:null,onblocked:null};queueMicrotask(()=>{r.onupgradeneeded?.({oldVersion:0});r.onsuccess?.();});return r;}}};
}
describe('actual default IndexedDB adapter boundary',()=>{
 it('creates both enrollment and dedup stores when browser code opens the DB first',async()=>{
  const fake=idbWithAbort();vi.stubGlobal('indexedDB',fake.api);const h=harness();
  const {storage:_,...deps}=h.deps;void _;
  await createWebPushNotificationService(deps).getCurrentSubscription('alice');
  expect([...fake.stores].sort()).toEqual(['dedup','enrollment']);
 });
 it('does not announce successful enrollment on a transaction that aborts after request success',async()=>{
  const fake=idbWithAbort(true);vi.stubGlobal('indexedDB',fake.api);const h=harness();
  const {storage:_,...deps}=h.deps;void _;
  await expect(createWebPushNotificationService(deps).subscribe('alice',producer)).rejects.toThrow();
 });
});

it('normalizes unpadded base64url before handing bytes to a strict decoder',()=>{
 const decode=globalThis.atob;vi.stubGlobal('atob',(text:string)=>{if(text.length%4)throw new Error('strict padding required');return decode(text);});
 expect([...urlBase64ToUint8Array(key)]).toEqual([...Buffer.from(key,'base64url')]);
});
