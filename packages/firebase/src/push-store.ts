import {collection,doc,onSnapshot,setDoc,runTransaction,type Firestore} from 'firebase/firestore';
import {parsePushProducerRecord,parsePushSubscriptionRecord,type PushProducerRecord,type PushSubscriptionRecord} from '@94ai/core';
import {pushProducerDocPath,pushSubscriptionDocPath} from './paths';
import {encodeValue,decodeMap,restDocumentUrl,composeSignal,type FetchLike} from './rest';
function fields(value:object):Record<string,unknown>{return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,encodeValue(v)]));}
function owner(uid:string,value:{userId:string}){if(value.userId!==uid)throw Error('push_uid_mismatch');}
const responseBounds = new WeakMap<Response, ReturnType<typeof composeSignal>>();
function releaseResponse(response: Response): void {
 const bound = responseBounds.get(response); bound?.cleanup(); responseBounds.delete(response);
 if (response.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
}
async function json(response: Response): Promise<Record<string, unknown>> {
 const bound = responseBounds.get(response) ?? composeSignal();
 const reader = response.body?.getReader(); let size = 0;
 const chunks: Uint8Array[] = []; let abortListener: (() => void) | undefined;
 const aborted = new Promise<never>((_resolve, reject) => {
  abortListener = () => { void reader?.cancel().catch(() => undefined); reject(new Error('push_response_aborted')); };
  bound.signal.addEventListener('abort', abortListener, {once: true});
 });
 try {
  bound.signal.throwIfAborted();
  if (reader) for (;;) {
   const row = await Promise.race([reader.read(), aborted]); bound.signal.throwIfAborted();
   if (row.done) break;
   size += row.value.length; if (size > 131072) throw new Error('push_response_limit'); chunks.push(row.value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const value: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes) || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_push_response');
  return value as Record<string, unknown>;
 } finally {
  if (abortListener) bound.signal.removeEventListener('abort', abortListener);
  void reader?.cancel().catch(() => undefined); bound.cleanup(); responseBounds.delete(response);
 }
}
async function request(projectId:string,idToken:string,relative:string,method:string,fetcher:FetchLike,signal?:AbortSignal,body?:unknown,params?:Record<string,string>):Promise<Response>{
 const bounded=composeSignal(signal);
 try {
  const url=new URL(restDocumentUrl(projectId,relative));
  for(const [key,value] of Object.entries(params??{}))url.searchParams.set(key,value);
  const response=await fetcher(url.toString(),{method,signal:bounded.signal,headers:{authorization:`Bearer ${idToken}`,accept:'application/json',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  responseBounds.set(response,bounded); return response;
 } catch(error) {bounded.cleanup();throw error;}
}

export async function writePushProducerRest(projectId:string,idToken:string,value:PushProducerRecord,fetcher:FetchLike=fetch,signal?:AbortSignal,expectedUid?:string):Promise<void>{
 const p=parsePushProducerRecord(value);if(!expectedUid)throw Error('push_expected_uid_required');owner(expectedUid,p);
 const response=await request(projectId,idToken,pushProducerDocPath(expectedUid,p.deviceId),'PATCH',fetcher,signal,{fields:fields(p)});releaseResponse(response);if(!response.ok)throw Error(`push_producer_write_${response.status}`);
}
async function list<T extends {userId:string}>(projectId:string,idToken:string,uid:string,kind:'pushProducers'|'pushSubscriptions',parse:(value:unknown)=>T,fetcher:FetchLike,signal?:AbortSignal):Promise<T[]>{
 // Validate path segments with the same helpers used for individual documents.
 (kind==='pushProducers'?pushProducerDocPath:pushSubscriptionDocPath)(uid,'example');
 const response=await request(projectId,idToken,`users/${uid}/${kind}`,'GET',fetcher,signal,undefined,{pageSize:'21'});if(!response.ok){releaseResponse(response);throw Error(`push_list_${response.status}`);}
 const body=await json(response);if(body.nextPageToken)throw Error('push_collection_incomplete');
 const documents=Object.hasOwn(body,'documents')?body.documents:[];if(!Array.isArray(documents)||documents.length>20)throw Error('push_collection_limit');
 const prefix=`projects/${projectId}/databases/(default)/documents/users/${uid}/${kind}/`,ids=new Set<string>();
 return documents.map(raw=>{
  if(!raw||typeof raw!=='object'||typeof raw.name!=='string'||!raw.name.startsWith(prefix)||!raw.fields||typeof raw.fields!=='object')throw Error('push_document_path_invalid');
  const parsed=parse(decodeMap(raw.fields));owner(uid,parsed);const id=kind==='pushProducers'?(parsed as unknown as PushProducerRecord).deviceId:(parsed as unknown as PushSubscriptionRecord).browserId;
  if(raw.name!==prefix+id||ids.has(id))throw Error('push_document_identity_invalid');ids.add(id);return parsed;
 });
}
export function readPushProducersRest(projectId:string,idToken:string,uid:string,fetcher:FetchLike=fetch,signal?:AbortSignal):Promise<PushProducerRecord[]>{return list(projectId,idToken,uid,'pushProducers',parsePushProducerRecord,fetcher,signal);}
export function readPushSubscriptionsRest(projectId:string,idToken:string,uid:string,fetcher:FetchLike=fetch,signal?:AbortSignal):Promise<PushSubscriptionRecord[]>{return list(projectId,idToken,uid,'pushSubscriptions',parsePushSubscriptionRecord,fetcher,signal);}
export async function deletePushSubscriptionRest(projectId:string,idToken:string,uid:string,browserId:string,fetcher:FetchLike=fetch,signal?:AbortSignal,expectedEpoch?:number):Promise<void>{
 const relative=pushSubscriptionDocPath(uid,browserId);let params:Record<string,string>|undefined;
 if(expectedEpoch!==undefined){const response=await request(projectId,idToken,relative,'GET',fetcher,signal);if(response.status===404){releaseResponse(response);return;}if(!response.ok){releaseResponse(response);throw Error('push_revoke_read_failed');}const current=await json(response);const row=parsePushSubscriptionRecord(decodeMap(current.fields as Parameters<typeof decodeMap>[0]));owner(uid,row);if(row.browserId!==browserId||row.enrollmentEpoch!==expectedEpoch)return;if(typeof current.updateTime!=='string'||!Number.isFinite(Date.parse(current.updateTime)))throw Error('push_revoke_revision_missing');params={'currentDocument.updateTime':current.updateTime};}
 const response=await request(projectId,idToken,relative,'DELETE',fetcher,signal,undefined,params);releaseResponse(response);if(!response.ok&&response.status!==404&&response.status!==409&&response.status!==412)throw Error(`push_revoke_${response.status}`);
}
function subscribe<T extends {userId:string}>(db:Firestore,uid:string,kind:'pushProducers'|'pushSubscriptions',parse:(v:unknown)=>T,onValue:(v:T[])=>void,onError:(e:Error)=>void):()=>void{
 let active=true;const stop=onSnapshot(collection(db,'users',uid,kind),{includeMetadataChanges:true},snapshot=>{
  if(!active||snapshot.metadata.fromCache||snapshot.metadata.hasPendingWrites)return;
  try{if(snapshot.size>20)throw Error('push_collection_limit');const values=snapshot.docs.map(entry=>{const p=parse(entry.data());owner(uid,p);const id=kind==='pushProducers'?(p as unknown as PushProducerRecord).deviceId:(p as unknown as PushSubscriptionRecord).browserId;if(entry.id!==id)throw Error('push_document_identity_invalid');return p;});onValue(values);}
  catch{onError(new Error('push_settings_unavailable'));}
 },()=>{if(active)onError(new Error('push_settings_unavailable'));});return()=>{active=false;stop();};
}
export function subscribePushProducers(db:Firestore,uid:string,onValue:(v:PushProducerRecord[])=>void,onError:(e:Error)=>void):()=>void{return subscribe(db,uid,'pushProducers',parsePushProducerRecord,onValue,onError);}
export function subscribePushSubscriptions(db:Firestore,uid:string,onValue:(v:PushSubscriptionRecord[])=>void,onError:(e:Error)=>void):()=>void{return subscribe(db,uid,'pushSubscriptions',parsePushSubscriptionRecord,onValue,onError);}
export async function writePushSubscription(db:Firestore,uid:string,value:PushSubscriptionRecord):Promise<void>{const row=parsePushSubscriptionRecord(value);owner(uid,row);await setDoc(doc(db,pushSubscriptionDocPath(uid,row.browserId)),row);}
export async function deletePushSubscription(db:Firestore,uid:string,browserId:string,expectedEpoch?:number):Promise<void>{const ref=doc(db,pushSubscriptionDocPath(uid,browserId));await runTransaction(db,async tx=>{const snap=await tx.get(ref);if(!snap.exists())return;const row=parsePushSubscriptionRecord(snap.data());owner(uid,row);if(row.browserId!==browserId)throw Error('push_identity_invalid');if(expectedEpoch!==undefined&&row.enrollmentEpoch!==expectedEpoch)return;tx.delete(ref);});}
export async function requestPushTest(db:Firestore,uid:string,browserId:string,epoch:number,requestId:string,requestedAt:string):Promise<void>{const ref=doc(db,pushSubscriptionDocPath(uid,browserId));await runTransaction(db,async tx=>{const snap=await tx.get(ref);if(!snap.exists())throw Error('push_not_enrolled');const row=parsePushSubscriptionRecord(snap.data());owner(uid,row);if(row.browserId!==browserId||row.enrollmentEpoch!==epoch)throw Error('push_enrollment_changed');const next=parsePushSubscriptionRecord({...row,testRequestId:requestId,testRequestedAt:requestedAt});tx.set(ref,next);});}
