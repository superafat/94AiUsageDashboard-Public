import {useCallback,useEffect,useRef,useState} from 'react';
import type {AppClientServices,PushPermissionStatus} from '@94ai/client';
import {parsePushProducerRecord,parsePushSubscriptionRecord,type PushProducerRecord,type PushSubscriptionRecord} from '@94ai/core';
export type PushDisplayStatus='unsupported'|'ios_needs_home_screen'|'denied'|'missing-Mac'|'waiting'|'error'|'enabled'|'default';
interface State {services:AppClientServices|undefined;uid:string|undefined;permission:PushPermissionStatus|null;producers:PushProducerRecord[];subscriptions:PushSubscriptionRecord[];local:PushSubscriptionRecord|null;loading:boolean;error:boolean;queued:boolean}
const empty=(services:AppClientServices|undefined,uid:string|undefined):State=>({services,uid,permission:null,producers:[],subscriptions:[],local:null,loading:Boolean(services?.notifications&&uid),error:false,queued:false});
export function usePushSettings(services:AppClientServices|undefined,uid:string|undefined){
 const [state,setState]=useState<State>(()=>empty(services,uid)),[busy,setBusy]=useState(false),[selected,setSelected]=useState(''),[time,setTime]=useState(services?.clock.now()??Date.now()),[online,setOnline]=useState(services?.connectivity.current()!=='offline');
 const generation=useRef(0);const matches=state.services===services&&state.uid===uid;const current=matches?state:empty(services,uid);
 useEffect(()=>{
  const op=++generation.current;let active=true;const service=services?.notifications;
  setState(empty(services,uid));setBusy(false);setSelected('');setTime(services?.clock.now()??Date.now());setOnline(services?.connectivity.current()!=='offline');
  const update=(fn:(s:State)=>State)=>{if(active&&generation.current===op)setState(s=>fn(s));};
  if(!service||!uid)return()=>{active=false;};
  const refreshLocal=()=>service.getCurrentSubscription(uid).then(row=>update(s=>({...s,local:row}))).catch(()=>update(s=>({...s,error:true})));
  void Promise.all([service.getPermissionStatus().then(permission=>update(s=>({...s,permission}))),refreshLocal()]).then(()=>update(s=>({...s,loading:false}))).catch(()=>update(s=>({...s,error:true,loading:false})));
  const stopProducer=service.subscribeProducers(uid,records=>{
   try{const parsed=records.map(parsePushProducerRecord);if(parsed.some(p=>p.userId!==uid))throw Error();update(s=>({...s,producers:parsed}));}catch{update(s=>({...s,error:true}));}
  },()=>update(s=>({...s,error:true})));
  const stopSubs=service.subscribeSubscriptions(uid,records=>{
   try{const parsed=records.map(parsePushSubscriptionRecord);if(parsed.some(p=>p.userId!==uid))throw Error();update(s=>({...s,subscriptions:parsed}));void refreshLocal();}catch{update(s=>({...s,error:true}));}
  },()=>update(s=>({...s,error:true})));
  const stopClock=services.clock.every(60000,()=>{if(active)setTime(services.clock.now());});
  const stopOnline=services.connectivity.subscribe(value=>{if(active)setOnline(value==='online');});
  return()=>{active=false;stopProducer();stopSubs();stopClock();stopOnline();};
 },[services,uid]);
 const fresh=current.producers.filter(p=>Date.parse(p.updatedAt)<=time+60000&&time-Date.parse(p.updatedAt)<=600000);
 const local=current.local;
 const enrolled=Boolean(local&&Date.parse(local.expiresAt)>time&&current.subscriptions.some(s=>s.browserId===local.browserId&&s.enrollmentEpoch===local.enrollmentEpoch&&s.applicationServerKey===local.applicationServerKey&&s.targetDeviceId===local.targetDeviceId));
 const target=fresh.find(p=>p.deviceId===(selected||local?.targetDeviceId))??(fresh.length===1?fresh[0]:undefined);
 let displayStatus:PushDisplayStatus='default';
 if(!services?.notifications||!services.notifications.isSupported()||current.permission==='unsupported')displayStatus='unsupported';
 else if(current.permission==='ios_needs_home_screen')displayStatus='ios_needs_home_screen';
 else if(current.permission==='denied')displayStatus='denied';
 else if(busy||current.loading)displayStatus='waiting';
 else if(current.error)displayStatus='error';
 else if(enrolled&&current.permission==='granted')displayStatus='enabled';
 else if(current.permission==='granted'&&!fresh.length)displayStatus='missing-Mac';
 const modify=useCallback((op:number,fn:(s:State)=>State)=>{if(generation.current===op)setState(fn);},[]);
 async function enable(){
  const service=services?.notifications;if(!service||!uid||!online||!target)return;
  const op=generation.current;const permissionPromise=service.requestPermission(); // Initiated synchronously by the button gesture.
  setBusy(true);modify(op,s=>({...s,error:false,queued:false}));
  try{const permission=await permissionPromise;if(op!==generation.current)return;modify(op,s=>({...s,permission}));if(permission!=='granted')return;
   const row=await service.subscribe(uid,target);modify(op,s=>({...s,local:row,subscriptions:[...s.subscriptions.filter(x=>x.browserId!==row.browserId),row]}));
  }catch{modify(op,s=>({...s,error:true}));}finally{if(op===generation.current)setBusy(false);}
 }
 async function disable(){const service=services?.notifications;if(!service||!uid)return;const op=generation.current;setBusy(true);
  try{await service.unsubscribe(uid);modify(op,s=>({...s,local:null,subscriptions:s.subscriptions.filter(x=>x.browserId!==local?.browserId),error:false,queued:false}));}
  catch{modify(op,s=>({...s,error:true}));}finally{if(op===generation.current)setBusy(false);}
 }
 async function test(){const service=services?.notifications;if(!service||!uid||!local||!online)return;const op=generation.current;setBusy(true);
  try{await service.requestTestPush(uid,local.targetDeviceId);modify(op,s=>({...s,queued:true,error:false}));}catch{modify(op,s=>({...s,error:true}));}finally{if(op===generation.current)setBusy(false);}
 }
 return{displayStatus,busy,online,producers:fresh,selectedDevice:target?.deviceId??selected,setSelectedDevice:setSelected,enable,disable,test,canEnable:Boolean(target&&online),canDisable:Boolean(local),canTest:enrolled&&online,queued:current.queued};
}
