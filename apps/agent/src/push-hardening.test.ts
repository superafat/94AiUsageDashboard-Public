import {describe, expect, it} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import webPush from 'web-push';
import {parsePushProducerRecord, parsePushPayload, type PushSubscriptionRecord} from '@94ai/core';
import {getOrCreateLocalPushKeys,pushScopeHash} from './local-push-keys';
import {NotificationJournal} from './notification-journal';
import {evaluateQuotaNotifications, type UsageSnapshot} from '@94ai/core';
import {isRoutableIp, sendPushNotification} from './push-transport';
import {runPushNotificationSync} from './push-runtime';

const baseTime=Date.parse('2026-09-11T00:00:00.000Z');
const keys=webPush.generateVAPIDKeys();
const ec=crypto.createECDH('prime256v1');ec.generateKeys();
const basePayload={version:1,browserId:'test-browser',epoch:1,eventId:'test-event',type:'test',observedAt:new Date(baseTime).toISOString(),expiresAt:new Date(baseTime+300000).toISOString(),title:'測試通知',body:'這是 94AiUsageDashboard 的測試推播'};
const subscription=(publicKey:string):PushSubscriptionRecord=>({schemaVersion:1,userId:'test-user',browserId:'test-browser',targetDeviceId:'test-device',enrollmentEpoch:1,applicationServerKey:publicKey,endpoint:'https://fcm.googleapis.com/fcm/send/example',p256dh:ec.getPublicKey('base64url'),auth:crypto.randomBytes(16).toString('base64url'),createdAt:new Date(baseTime).toISOString(),expiresAt:new Date(baseTime+86400000).toISOString()});
async function owned<T>(fn:(root:string)=>Promise<T>):Promise<T>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'usage29-owned-'));try{return await fn(root);}finally{fs.rmSync(root,{recursive:true,force:true});}}

describe('source security counterexamples',()=>{
 it('rejects malformed public-key bytes and an impossible calendar date',()=>{
  const row={schemaVersion:1,userId:'test-user',deviceId:'test-device',publicKey:keys.publicKey,updatedAt:new Date(baseTime).toISOString()};
  expect(()=>parsePushProducerRecord({...row,publicKey:'ABCDEFGH'})).toThrow();
  expect(()=>parsePushProducerRecord({...row,updatedAt:'2026-02-30T00:00:00.000Z'})).toThrow();
 });
 it('does not accept arbitrary account prose as default lock-screen notification text',()=>{
  expect(()=>parsePushPayload({...basePayload,type:'consumption',title:'Account information',body:'Confidential account details'})).toThrow();
 });
 it('rejects carrier-grade and encoded mapped/local destination addresses',()=>{
  for(const ip of ['100.64.0.1','198.18.0.1','0:0:0:0:0:ffff:7f00:1','::','2001:db8::1'])expect(isRoutableIp(ip),ip).toBe(false);
 });
 it('calls a push-service 201 acceptance, not phone delivery',async()=>{
  const sub=subscription(keys.publicKey);
  const result=await sendPushNotification({subscription:{endpoint:sub.endpoint,keys:{p256dh:sub.p256dh,auth:sub.auth}},payload:JSON.stringify(basePayload),vapidKeys:keys,dnsLookup:async()=>['142.250.190.46'],httpRequest:async()=>({statusCode:201,headers:{}})});
  expect(result.status).toBe('accepted');
 });
 it('does not share signing keys between different scope tuples',async()=>owned(async(rootDir)=>{
  const a=await getOrCreateLocalPushKeys({rootDir,backendId:'a:b',userId:'c',deviceId:'d'});
  const b=await getOrCreateLocalPushKeys({rootDir,backendId:'a',userId:'b:c',deviceId:'d'});
  expect(a.status).toBe('ready');expect(b.status).toBe('ready');expect(a.publicKey).not.toBe(b.publicKey);
 }));
 it('rejects existing keys reached through a symlinked scope directory',async()=>owned(async(rootDir)=>{
  const first=await getOrCreateLocalPushKeys({rootDir,backendId:'backend',userId:'test-user',deviceId:'test-device'});expect(first.status).toBe('ready');
  const parent=path.join(rootDir,'push-keys');const scope=fs.readdirSync(parent)[0]!;const from=path.join(parent,scope),outside=path.join(rootDir,'detached');fs.renameSync(from,outside);fs.symlinkSync(outside,from);
  expect((await getOrCreateLocalPushKeys({rootDir,backendId:'backend',userId:'test-user',deviceId:'test-device'})).status).not.toBe('ready');
 }));
 it('sends a test request at most once across repeated syncs',async()=>owned(async(rootDir)=>{
  let publicKey='',sends=0;
  const options={rootDir,backendId:'demo-test',userId:'test-user',deviceId:'test-device',projectId:'demo-test',idToken:'not-a-real-value',now:()=>new Date(baseTime),snapshots:[],preferences:[],writeProducer:async(p:{publicKey:string})=>{publicKey=p.publicKey;},fetchSubscriptions:async()=>[{...subscription(publicKey),testRequestId:'test-request',testRequestedAt:new Date(baseTime).toISOString()}],sendPush:async()=>{sends++;return {status:'accepted' as never};}};
  await runPushNotificationSync(options);await runPushNotificationSync(options);expect(sends).toBe(1);
 }));
});

it('suppresses pending quota events after the provider notification switch is turned off',async()=>owned(async(rootDir)=>{
 let now=baseTime,publicKey='',sends=0;
 const snap=(remaining:number)=>({schemaVersion:1 as const,userId:'test-user',deviceId:'test-device',providerId:'codex',fetchedAt:new Date(now-1000).toISOString(),syncedAt:new Date(now).toISOString(),expiresAt:new Date(now+300000).toISOString(),stale:false,resources:{session:{kind:'consumption' as const,unit:'percent',remaining}}});
 const pref={schemaVersion:1 as const,userId:'test-user',family:'codex',enabled:true,updatedAt:new Date(baseTime).toISOString(),notifications:{lowQuota:true,reset:true}};
 const options={rootDir,backendId:'demo-test',userId:'test-user',deviceId:'test-device',projectId:'demo-test',idToken:'not-a-real-value',now:()=>new Date(now),snapshots:[snap(100)],preferences:[pref],writeProducer:async(p:{publicKey:string})=>{publicKey=p.publicKey;},fetchSubscriptions:async()=>[] as PushSubscriptionRecord[],sendPush:async()=>{sends++;return {status:'accepted' as never};}};
 await runPushNotificationSync(options);now+=60000;await runPushNotificationSync({...options,snapshots:[snap(60)]});
 now+=60000;await runPushNotificationSync({...options,snapshots:[],preferences:[{...pref,enabled:false}],fetchSubscriptions:async()=>[subscription(publicKey)]});expect(sends).toBe(0);
}));
it('rejects future-dated test requests without sending a push',async()=>owned(async(rootDir)=>{
 let publicKey='',sends=0;
 await runPushNotificationSync({rootDir,backendId:'demo-test',userId:'test-user',deviceId:'test-device',projectId:'demo-test',idToken:'not-a-real-value',now:()=>new Date(baseTime),snapshots:[],preferences:[],writeProducer:async p=>{publicKey=p.publicKey;},fetchSubscriptions:async()=>[{...subscription(publicKey),testRequestId:'future-test',testRequestedAt:new Date(baseTime+60000).toISOString()}],sendPush:async()=>{sends++;return {status:'accepted' as never};}});expect(sends).toBe(0);
}));

it('does not resend an accepted event when another event in its former group expires',async()=>owned(async(rootDir)=>{
 const scope={backendId:'demo-test',userId:'test-user',deviceId:'test-device'};
 const vapid=await getOrCreateLocalPushKeys({rootDir,...scope});expect(vapid.status).toBe('ready');
 const journalDir=path.join(rootDir,'push-keys',pushScopeHash(scope),'journal');fs.mkdirSync(journalDir,{mode:0o700});
 const journal=new NotificationJournal({rootDir:journalDir,...scope});
 for(const [resourceKey,ttl]of [['session',30_000],['weekly',300_000]] as const){
  const snapshot=(remaining:number,fetchedAt:number):UsageSnapshot=>({schemaVersion:1,userId:scope.userId,deviceId:scope.deviceId,providerId:'codex',fetchedAt:new Date(fetchedAt).toISOString(),syncedAt:new Date(baseTime).toISOString(),expiresAt:new Date(baseTime+ttl).toISOString(),stale:false,resources:{[resourceKey]:{kind:'consumption',unit:'percent',remaining}}});
  const settings={...scope,resourceKey,sourceEnabled:true,notifyConsumption:true,notifyReset:false,now:baseTime};
  const first=await evaluateQuotaNotifications({...settings,snapshot:snapshot(100,baseTime-2000)});
  const next=await evaluateQuotaNotifications({...settings,previousState:first.state,snapshot:snapshot(80,baseTime-1000)});
  expect(next.events).toHaveLength(1);await journal.saveStateAndEvents(next.state!,next.events);
 }
 let time=baseTime,acceptedPhoneSends=0;
 const firstPhone={...subscription(vapid.publicKey!),browserId:'phone-a',createdAt:new Date(baseTime-10000).toISOString()},secondPhone={...firstPhone,browserId:'phone-b'};
 const options={rootDir,...scope,projectId:'demo-test',idToken:'not-a-real-value',now:()=>new Date(time),snapshots:[],preferences:[{schemaVersion:1 as const,userId:scope.userId,family:'codex',enabled:true,updatedAt:new Date(baseTime-10000).toISOString(),notifications:{lowQuota:true,reset:false}}],writeProducer:async()=>undefined,fetchSubscriptions:async()=>[firstPhone,secondPhone],sendPush:async(sub:PushSubscriptionRecord)=>{if(sub.browserId==='phone-a'){acceptedPhoneSends++;return{status:'accepted' as const};}return{status:'transient_error' as const};}};
 await runPushNotificationSync(options);expect(acceptedPhoneSends).toBe(2);
 time+=60000;await runPushNotificationSync(options);expect(acceptedPhoneSends).toBe(2);
}));

it('drops an event that expires while subscriptions are being fetched',async()=>owned(async(rootDir)=>{
 const scope={backendId:'demo-test',userId:'test-user',deviceId:'test-device'};
 const vapid=await getOrCreateLocalPushKeys({rootDir,...scope});
 const dir=path.join(rootDir,'push-keys',pushScopeHash(scope),'journal');fs.mkdirSync(dir,{mode:0o700});const journal=new NotificationJournal({rootDir:dir,...scope});
 const sample=(remaining:number,at:number):UsageSnapshot=>({schemaVersion:1,userId:scope.userId,deviceId:scope.deviceId,providerId:'codex',fetchedAt:new Date(at).toISOString(),syncedAt:new Date(baseTime).toISOString(),expiresAt:new Date(baseTime+2000).toISOString(),stale:false,resources:{session:{kind:'consumption',unit:'percent',remaining}}});
 const settings={...scope,resourceKey:'session',sourceEnabled:true,notifyConsumption:true,now:baseTime};
 const first=await evaluateQuotaNotifications({...settings,snapshot:sample(100,baseTime-2000)}),next=await evaluateQuotaNotifications({...settings,previousState:first.state,snapshot:sample(80,baseTime-1000)});
 await journal.saveStateAndEvents(next.state!,next.events);let time=baseTime,sends=0;
 await runPushNotificationSync({rootDir,...scope,projectId:'demo-test',idToken:'not-a-real-value',now:()=>new Date(time),snapshots:[],preferences:[{schemaVersion:1,userId:scope.userId,family:'codex',enabled:true,updatedAt:new Date(baseTime-2000).toISOString(),notifications:{lowQuota:true}}],writeProducer:async()=>undefined,fetchSubscriptions:async()=>{time+=10000;return[{...subscription(vapid.publicKey!),createdAt:new Date(baseTime-5000).toISOString()}];},sendPush:async()=>{sends++;return{status:'accepted'};}});
 expect(sends).toBe(0);
}));
