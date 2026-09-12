import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {evaluateQuotaNotifications,parseProviderPreference,parsePushSubscriptionRecord,parseUsageSnapshot,pushNotificationText,providerFamilyOf,resolveFamilyEnabled,type ProviderPreference,type PushProducerRecord,type PushSubscriptionRecord,type UsageSnapshot,type PushPayload,type QuotaNotificationEvent} from '@94ai/core';
import {deletePushSubscriptionRest,readPushSubscriptionsRest,writePushProducerRest} from '@94ai/firebase';
import {NotificationJournal} from './notification-journal';
import {getOrCreateLocalPushKeys,pushScopeHash} from './local-push-keys';
import {PushDeliveryJournal} from './push-delivery-journal';
import {sendPushNotification,type PushDeliveryResult} from './push-transport';
export interface PushNotificationSyncOptions {
 rootDir?:string;backendId:string;userId:string;deviceId:string;projectId:string;idToken:string;now?:()=>Date;signal?:AbortSignal;
 snapshots:UsageSnapshot[];preferences?:ProviderPreference[];
 writeProducer?:(producer:PushProducerRecord)=>Promise<void>;fetchSubscriptions?:()=>Promise<PushSubscriptionRecord[]>;
 sendPush?:(sub:PushSubscriptionRecord,payload:string)=>Promise<PushDeliveryResult>;
 revokeSubscription?:(browserId:string)=>Promise<void>;
}
export interface PushNotificationSyncResult {status:'ok'|'keys_failed'|'disabled'|'error';eventsEvaluated:number;eventsAccepted:number;error?:string}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function runPushNotificationSync(o:PushNotificationSyncOptions):Promise<PushNotificationSyncResult>{
 let eventsEvaluated=0,eventsAccepted=0;let failed=false;
 const result=(status:PushNotificationSyncResult['status'],error?:string):PushNotificationSyncResult=>({status,eventsEvaluated,eventsAccepted,...(error?{error}:{})});
 try{
  const now=o.now?o.now():new Date(),time=now.getTime();
  if(!Number.isFinite(time)||o.backendId!==o.projectId||!Array.isArray(o.snapshots)||o.snapshots.length>128)throw Error('invalid_push_scope');
  const prefs=new Map<string,ProviderPreference>();
  if(!Array.isArray(o.preferences)||o.preferences.length>11)throw Error('invalid_preferences');
  for(const value of o.preferences){const p=parseProviderPreference(value);if(p.userId!==o.userId||prefs.has(p.family))throw Error('invalid_preferences');prefs.set(p.family,p);}
  const snapshots=o.snapshots.map(parseUsageSnapshot);if(snapshots.some(s=>s.userId!==o.userId||s.deviceId!==o.deviceId))throw Error('invalid_snapshot_scope');
  const abort=AbortSignal.timeout(14000),signal=o.signal?AbortSignal.any([o.signal,abort]):abort;signal.throwIfAborted();
  const base=o.rootDir??path.join(os.homedir(),'.config','94ai-usage-dashboard');
  const keys=await getOrCreateLocalPushKeys({rootDir:base,backendId:o.backendId,userId:o.userId,deviceId:o.deviceId});
  if(keys.status!=='ready'||!keys.keys)return result('keys_failed','push_keys_unavailable');
  const write=o.writeProducer??(p=>writePushProducerRest(o.projectId,o.idToken,p,fetch,signal,o.userId));
  await write({schemaVersion:1,userId:o.userId,deviceId:o.deviceId,publicKey:keys.keys.publicKey,updatedAt:now.toISOString()});signal.throwIfAborted();
  const journalDir=path.join(base,'push-keys',pushScopeHash(o),'journal');
  try{fs.mkdirSync(journalDir,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  const journal=new NotificationJournal({rootDir:journalDir,backendId:o.backendId,userId:o.userId,deviceId:o.deviceId}),delivery=new PushDeliveryJournal(journalDir);
  await journal.pruneExpired(time);
  const enabledMap=Object.fromEntries([...prefs].map(([family,p])=>[family,p.enabled]));
  for(const snapshot of snapshots){
   const family=providerFamilyOf(snapshot.providerId),pref=prefs.get(family);
   for(const [resourceKey,resource]of Object.entries(snapshot.resources)){
    if(resource.kind!=='consumption')continue;if(++eventsEvaluated>512)throw Error('resource_bound');signal.throwIfAborted();
    const previous=await journal.getState(snapshot.providerId,resourceKey);
    const evaluated=await evaluateQuotaNotifications({backendId:o.backendId,userId:o.userId,deviceId:o.deviceId,snapshot,resourceKey,sourceEnabled:resolveFamilyEnabled(family,enabledMap),notifyConsumption:pref?.notifications?.lowQuota===true,notifyReset:pref?.notifications?.reset===true,...(pref?{preferenceRevision:pref.updatedAt}:{}),now,...(previous?{previousState:previous}:{})});
    if(evaluated.state)await journal.saveStateAndEvents(evaluated.state,evaluated.events);
   }
  }
  const received=await(o.fetchSubscriptions??(()=>readPushSubscriptionsRest(o.projectId,o.idToken,o.userId,fetch,signal)))();signal.throwIfAborted();
  if(!Array.isArray(received)||received.length>20)throw Error('subscription_bound');
  const subscriptions:PushSubscriptionRecord[]=[],seen=new Set<string>();
  for(const value of received){const sub=parsePushSubscriptionRecord(value);if(sub.userId!==o.userId||seen.has(sub.browserId))throw Error('subscription_scope');seen.add(sub.browserId);if(sub.targetDeviceId===o.deviceId&&sub.applicationServerKey===keys.keys.publicKey&&Date.parse(sub.expiresAt)>time&&Date.parse(sub.createdAt)<=time)subscriptions.push(sub);}
  let budget=4;
  const send=o.sendPush??((sub,payload)=>sendPushNotification({subscription:{endpoint:sub.endpoint,keys:{p256dh:sub.p256dh,auth:sub.auth}},payload,vapidKeys:keys.keys!,signal}));
  const dispatch = async (sub:PushSubscriptionRecord,payload:PushPayload,parts:Array<{eventId:string;expiresAt:string;observedAt:string}>=[payload]):Promise<boolean> => {
   if(budget<=0||signal.aborted)return false;
   // Persist acceptance per original event and browser, not a changing coalesced group.
   const sendTime=(o.now?.()??new Date()).getTime();
   if(!Number.isFinite(sendTime)||sendTime<time)return false;
   const unexpired=parts.filter(part=>Date.parse(part.expiresAt)>sendTime);
   if(!unexpired.length)return true;
   const attempts=unexpired.map(part=>({id:hash([sub.browserId,sub.enrollmentEpoch,part.eventId]),part,
    result:delivery.begin(hash([sub.browserId,sub.enrollmentEpoch,part.eventId]),Date.parse(part.expiresAt),sendTime)}));
   const due=attempts.filter(attempt=>attempt.result.send);
   const covered=attempts.filter(attempt=>!attempt.result.send).every(attempt=>attempt.result.state==='accepted'||attempt.result.state==='terminal');
   if(!due.length)return covered;
   const dueIds=due.map(attempt=>attempt.part.eventId).sort();
   const combined={...payload,eventId:payload.type==='test'?payload.eventId:'qng_'+hash(dueIds),observedAt:new Date(Math.min(...due.map(item=>Date.parse(item.part.observedAt)))).toISOString(),expiresAt:new Date(Math.min(...due.map(item=>Date.parse(item.part.expiresAt)))).toISOString()};
   budget--;let response:PushDeliveryResult;
   try{response=await send(sub,JSON.stringify(combined));}catch{response={status:'transient_error'};}
   const state=response.status==='accepted'?'accepted':response.status==='rejected'||response.status==='not_registered'?'terminal':'pending';
   for(const attempt of due)delivery.finish(attempt.id,attempt.result.attempt,state,sendTime);
   if(state==='accepted')eventsAccepted++;else failed=true;
   if(response.status==='not_registered'){
    if(o.revokeSubscription)await o.revokeSubscription(sub.browserId);
    else await deletePushSubscriptionRest(o.projectId,o.idToken,o.userId,sub.browserId,fetch,signal,sub.enrollmentEpoch);
   }
   return state!=='pending'&&covered;
  };

  for(const sub of subscriptions){
   if(!sub.testRequestId||!sub.testRequestedAt)continue;
   const requested=Date.parse(sub.testRequestedAt);if(requested>time||time-requested>=900000||requested<Date.parse(sub.createdAt))continue;
   await dispatch(sub,{version:1,browserId:sub.browserId,epoch:sub.enrollmentEpoch,eventId:sub.testRequestId,type:'test',observedAt:sub.testRequestedAt,expiresAt:new Date(requested+900000).toISOString(),...pushNotificationText('test')});
  }
  const pending=await journal.getPendingEvents(),groups=new Map<string,QuotaNotificationEvent[]>(),drop:string[]=[];
  for(const event of pending){
   const family=providerFamilyOf(event.providerId),pref=prefs.get(family),state=await journal.getState(event.providerId,event.resourceKey);
   if(!resolveFamilyEnabled(family,enabledMap)||(event.type==='reset'?pref?.notifications?.reset!==true:pref?.notifications?.lowQuota!==true)||!state||Date.parse(event.observedAt)<Date.parse(state.cycleStartedAt)){drop.push(event.eventId);continue;}
   const key=JSON.stringify([event.providerId,event.resourceKey,event.type]);groups.set(key,[...(groups.get(key)??[]),event]);
  }
  if(drop.length)await journal.acknowledgeEvents(drop);
  for(const events of groups.values()){
   const ids=events.map(e=>e.eventId).sort(),type=events[0]!.type;
   const observedAt=new Date(Math.max(...events.map(e=>Date.parse(e.observedAt)))).toISOString();
   const expiresAt=new Date(Math.min(...events.map(e=>Date.parse(e.expiresAt)))).toISOString();
   const latestEvent=events.reduce((prev,curr)=>Date.parse(curr.observedAt)>=Date.parse(prev.observedAt)?curr:prev,events[0]!);
   const textData=pushNotificationText({type,providerId:latestEvent.providerId,resourceKey:latestEvent.resourceKey,remainingPercent:latestEvent.remainingPercent});
   let terminal=true;
   for(const sub of subscriptions){if(Date.parse(sub.createdAt)>Date.parse(observedAt))continue;
    const ok=await dispatch(sub,{version:1,browserId:sub.browserId,epoch:sub.enrollmentEpoch,eventId:'qng_'+hash(ids),type,observedAt,expiresAt,...textData},events);terminal=terminal&&ok;
   }
   // No receiver is permission to discard old alerts, never to replay them to a future subscriber.
   if(terminal)await journal.acknowledgeEvents(ids);
  }
  return result(failed?'error':'ok',failed?'push_delivery_pending':undefined);
 }catch{return result('error','push_dispatch_failed');}
}
