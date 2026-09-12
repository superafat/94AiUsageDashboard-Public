import type { Firestore } from 'firebase/firestore';
import type { PushNotificationService, PushPermissionStatus } from '@94ai/client';
import { parsePushProducerRecord, parsePushSubscriptionRecord, selectFreshProducer, validatePushKey,
  type PushSubscriptionRecord } from '@94ai/core';
import { deletePushSubscription, requestPushTest, subscribePushProducers, subscribePushSubscriptions,
  writePushSubscription } from '@94ai/firebase';
export { selectFreshProducer };
export interface LocalEnrollment {
  uid: string; backendId: string; browserId: string; epoch: number; applicationServerKey: string;
  targetDeviceId?: string; subscription?: PushSubscriptionRecord;
}
export interface PushStorage { get(): Promise<LocalEnrollment | null>; set(value: LocalEnrollment): Promise<void>; clear(): Promise<void> }
const DB_NAME = '94ai-push-db';
const STORE_NAME = 'enrollment';
/** Browser and service worker open the same version and both stores, in either order. */
export function createIndexedDbStorage(): PushStorage {
  const openDb = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      for (const name of [STORE_NAME, 'dedup']) if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name);
    };
    req.onsuccess = () => { const db=req.result; db.onversionchange=()=>db.close(); resolve(db); };
    req.onerror = () => reject(new Error('push_storage_unavailable'));
    req.onblocked = () => reject(new Error('push_storage_blocked'));
  });
  async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db=await openDb();
    return new Promise((resolve,reject)=>{
      let result:T;
      try {
        const tx=db.transaction(STORE_NAME,mode),req=action(tx.objectStore(STORE_NAME));
        req.onsuccess=()=>{result=req.result;};
        // Individual request success can still be followed by abort. Only commit completes a write.
        tx.oncomplete=()=>{db.close();resolve(result);};
        tx.onabort=tx.onerror=()=>{db.close();reject(new Error('push_storage_transaction_failed'));};
      } catch {db.close();reject(new Error('push_storage_unavailable'));}
    });
  }
  return {get:async()=> (await transact<LocalEnrollment | undefined>('readonly',s=>s.get('current')))??null,
    set:async value=>{await transact('readwrite',s=>s.put(value,'current'));},
    clear:async()=>{await transact('readwrite',s=>s.delete('current'));}};
}
export function urlBase64ToUint8Array(value:string):Uint8Array<ArrayBuffer> {
  const padded=value+'='.repeat((4-value.length%4)%4);
  const raw=atob(padded.replace(/-/g,'+').replace(/_/g,'/'));
  const bytes=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);return bytes;
}
export interface WebPushNotificationDependencies {
  db: Firestore; backendId?: string; now?:()=>number; getCurrentUid?:()=>string|null;
  getServiceWorkerRegistration?:()=>Promise<ServiceWorkerRegistration|undefined>;
  notificationApi?:typeof Notification|undefined; isIos?:()=>boolean; isStandalone?:()=>boolean; hasPushManager?:()=>boolean;
  storage?:PushStorage;
  writeSubscription?:(sub:PushSubscriptionRecord)=>Promise<void>;
  deleteSubscription?:(browserId:string,expectedEpoch?:number)=>Promise<void>;
  requestTestPush?:(uid:string,browserId:string,epoch:number,requestId:string,requestedAt:string)=>Promise<void>;
}
export function createWebPushNotificationService(deps:WebPushNotificationDependencies):PushNotificationService {
  let generation=0,observedUid:string|null|undefined;
  let storageQueue:Promise<unknown>=Promise.resolve();
  const serialized=<T>(action:()=>Promise<T>):Promise<T>=>{const next=storageQueue.then(action,action);storageQueue=next.catch(()=>undefined);return next;};
  const api=deps.notificationApi??(typeof Notification==='undefined'?undefined:Notification);
  const clock=deps.now??Date.now,backendId=deps.backendId??'self-hosted',storage=deps.storage??createIndexedDbStorage();
  const getReg=deps.getServiceWorkerRegistration??(async()=>typeof navigator!=='undefined'&&'serviceWorker'in navigator?navigator.serviceWorker.ready:undefined);
  const ios=deps.isIos??(()=>typeof navigator!=='undefined'&&(/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1)));
  const standalone=deps.isStandalone??(()=>typeof window!=='undefined'&&(Boolean((navigator as Navigator & {standalone?:boolean}).standalone)||window.matchMedia('(display-mode: standalone)').matches));
  const supported=deps.hasPushManager??(()=>Boolean(api&&typeof window!=='undefined'&&'PushManager'in window&&'serviceWorker'in navigator));
  const user=(uid:string)=>{if(!uid||uid.length>128||(deps.getCurrentUid&&deps.getCurrentUid()!==uid))throw new Error('push_account_changed');};
  const guard=(op:number,uid:string)=>{user(uid);if(op!==generation)throw new Error('Enrollment cancelled due to account or settings change');};
  const remove=(uid:string,browserId:string,epoch:number)=>deps.deleteSubscription?deps.deleteSubscription(browserId,epoch):deletePushSubscription(deps.db,uid,browserId,epoch);
  function localRecord(local:LocalEnrollment|null,uid:string):PushSubscriptionRecord|null {
    if(!local||local.uid!==uid||local.backendId!==backendId||!local.subscription)return null;
    try {const row=parsePushSubscriptionRecord(local.subscription);return row.userId===uid&&row.browserId===local.browserId&&row.enrollmentEpoch===local.epoch&&row.applicationServerKey===local.applicationServerKey&&row.targetDeviceId===local.targetDeviceId&&Date.parse(row.expiresAt)>clock()?row:null;}
    catch{return null;}
  }
  async function current(uid:string):Promise<PushSubscriptionRecord|null>{
    user(uid);const op=generation,local=await serialized(()=>storage.get()),row=localRecord(local,uid);if(!row)return null;
    const reg=await getReg();if(!reg)return null;
    const native=await reg.pushManager.getSubscription();guard(op,uid);if(!native)return null;
    const keys=native.toJSON().keys;
    return native.endpoint===row.endpoint&&keys?.p256dh===row.p256dh&&keys.auth===row.auth?row:null;
  }
  return {
    isSupported:supported,
    async getPermissionStatus():Promise<PushPermissionStatus>{if(!supported())return'unsupported';if(ios()&&!standalone())return'ios_needs_home_screen';return api?.permission??'unsupported';},
    async requestPermission(){if(!api||!supported()||(ios()&&!standalone()))throw new Error('push_unsupported');return api.requestPermission();},
    getCurrentSubscription:current,
    async subscribe(uid,producer){
      user(uid);const op=++generation,valid=parsePushProducerRecord(producer),time=clock();
      if(valid.userId!==uid||Date.parse(valid.updatedAt)>time+60000||time-Date.parse(valid.updatedAt)>600000)throw new Error('push_producer_unavailable');
      if(!supported()||api?.permission!=='granted'||(ios()&&!standalone()))throw new Error('push_permission_required');
      const reg=await getReg();guard(op,uid);if(!reg)throw new Error('push_worker_unavailable');
      const previous=await serialized(()=>storage.get());guard(op,uid);
      const existing=await reg.pushManager.getSubscription?.();guard(op,uid);
      if(existing){
        const raw=existing.options?.applicationServerKey;
        const actual=raw?btoa(String.fromCharCode(...new Uint8Array(raw))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''):'';
        if(actual!==valid.publicKey){await existing.unsubscribe();guard(op,uid);}
      }
      const native=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(valid.publicKey)});guard(op,uid);
      const keys=native.toJSON().keys;
      const row=parsePushSubscriptionRecord({schemaVersion:1,userId:uid,browserId:crypto.randomUUID(),targetDeviceId:valid.deviceId,enrollmentEpoch:1,applicationServerKey:valid.publicKey,
        endpoint:native.endpoint,p256dh:validatePushKey(keys?.p256dh,65),auth:validatePushKey(keys?.auth,16),createdAt:new Date(time).toISOString(),expiresAt:new Date(time+30*86400_000).toISOString()});
      try {
        guard(op,uid);await(deps.writeSubscription?deps.writeSubscription(row):writePushSubscription(deps.db,uid,row));guard(op,uid);
        await serialized(async()=>{guard(op,uid);await storage.set({uid,backendId,browserId:row.browserId,epoch:row.enrollmentEpoch,applicationServerKey:row.applicationServerKey,targetDeviceId:row.targetDeviceId,subscription:row});guard(op,uid);});
        if(previous?.uid===uid&&previous.backendId===backendId&&previous.browserId!==row.browserId)await remove(uid,previous.browserId,previous.epoch).catch(()=>undefined);
        guard(op,uid);return row;
      } catch(error) {
        await serialized(async()=>{const active=await storage.get();if(active?.browserId===row.browserId&&active.epoch===row.enrollmentEpoch)await storage.clear();}).catch(()=>undefined);
        await remove(uid,row.browserId,row.enrollmentEpoch).catch(()=>undefined);throw error;
      }
    },
    async unsubscribe(uid){
      const op=++generation;let previous:LocalEnrollment|null=null;let storageFailed=false;
      await serialized(async()=>{try{previous=await storage.get();}catch{storageFailed=true;}try{await storage.clear();}catch{storageFailed=true;}});
      let nativeRevoked=false;
      try{const reg=await getReg();if(op===generation&&reg){const native=await reg.pushManager.getSubscription();if(op===generation)nativeRevoked=native?await native.unsubscribe():true;}}catch{ /* Local epoch still suppresses old notifications when transport is offline. */ }
      const old=previous as LocalEnrollment|null;
      if(old?.uid===uid&&old.backendId===backendId)await remove(uid,old.browserId,old.epoch).catch(()=>undefined);
      if(storageFailed&&!nativeRevoked)throw new Error('push_local_revocation_failed');
    },
    async reconcileSession(uid){
      if(observedUid===uid)return;observedUid=uid;const op=++generation;
      let wrong=false;
      await serialized(async()=>{const old=await storage.get();wrong=Boolean(old&&(old.uid!==uid||old.backendId!==backendId));if(wrong)await storage.clear();});
      if(wrong&&op===generation){const reg=await getReg();if(op===generation){const native=await reg?.pushManager.getSubscription();if(op===generation)await native?.unsubscribe();}}
    },
    async requestTestPush(uid,targetDeviceId){
      const op=generation,row=await current(uid);guard(op,uid);
      if(!row||row.targetDeviceId!==targetDeviceId)throw new Error('push_not_enrolled');
      const id='req_'+crypto.randomUUID(),at=new Date(clock()).toISOString();
      await(deps.requestTestPush?deps.requestTestPush(uid,row.browserId,row.enrollmentEpoch,id,at):requestPushTest(deps.db,uid,row.browserId,row.enrollmentEpoch,id,at));guard(op,uid);
    },
    subscribeProducers:(uid,onValue,onError)=>subscribePushProducers(deps.db,uid,onValue,onError??(()=>undefined)),
    subscribeSubscriptions:(uid,onValue,onError)=>subscribePushSubscriptions(deps.db,uid,onValue,onError??(()=>undefined)),
  };
}
