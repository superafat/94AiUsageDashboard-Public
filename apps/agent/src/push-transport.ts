import * as https from 'node:https';
import * as dns from 'node:dns';
import * as net from 'node:net';
import webPush from 'web-push';
import {
  MAX_PAYLOAD_BYTES,
  MAX_PUSH_TTL_SECONDS,
  validatePushEndpoint,
  validatePushKey,
  parsePushPayload,
} from '@94ai/core';

export type PushDeliveryStatus =
  | 'accepted'
  | 'not_registered'
  | 'rate_limited'
  | 'transient_error'
  | 'rejected';

export interface PushDeliveryResult {
  status: PushDeliveryStatus;
  statusCode?: number;
  errorCategory?: string;
}

export interface SendPushOptions {
  subscription: {
    endpoint: string;
    keys: {
      p256dh: string;
      auth: string;
    };
  };
  payload: string;
  vapidKeys: {
    publicKey: string;
    privateKey: string;
    subject?: string;
  };
  ttlSeconds?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  dnsLookup?: (hostname: string) => Promise<string[]>;
  httpRequest?: (
    options: https.RequestOptions,
    body: Buffer | Uint8Array,
    timeoutMs: number,
  ) => Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined> }>;
}

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums;
}

export function isRoutableIp(ip: string): boolean {
  if (net.isIP(ip) === 0) return false;

  const lower = ip.toLowerCase();
  if (net.isIPv4(ip)) {
    const parts = parseIpv4(ip);
    if (!parts || parts.length < 2) return false;
    const a = parts[0];
    const b = parts[1];
    if (a === undefined || b === undefined) return false;

    // 0.0.0.0/8
    if (a === 0) return false;
    // 10.0.0.0/8
    if (a === 10) return false;
    // 100.64.0.0/10 (Carrier-grade NAT)
    if (a === 100 && b >= 64 && b <= 127) return false;
    // 127.0.0.0/8 (Loopback)
    if (a === 127) return false;
    // 169.254.0.0/16 (Link-local)
    if (a === 169 && b === 254) return false;
    // 172.16.0.0/12 (Private)
    if (a === 172 && b >= 16 && b <= 31) return false;
    // 192.0.0.0/24 (IETF Protocol Assignments)
    if (a === 192 && b === 0) return false;
    // 192.168.0.0/16 (Private)
    if (a === 192 && b === 168) return false;
    // 198.18.0.0/15 (Benchmarking)
    if (a === 198 && (b === 18 || b === 19)) return false;
    // 224.0.0.0/4 (Multicast)
    if (a >= 224 && a <= 239) return false;
    // 240.0.0.0/4 (Reserved / Broadcast)
    if (a >= 240) return false;

    return true;
  }

  if (net.isIPv6(ip)) {
    // Accept global unicast only, excluding transition/documentation ranges.
    if (lower.includes('.') || lower.includes('%')) return false;
    const parts=lower.split(':');
    const first=Number.parseInt(parts[0] || '0',16), second=Number.parseInt(parts[1] || '0',16);
    if (first < 0x2000 || first > 0x3fff || first === 0x2002) return false;
    if (first === 0x2001 && (second === 0x0db8 || second <= 0x01ff)) return false;
    return true;
  }

  return false;
}

async function defaultDnsLookup(hostname: string): Promise<string[]> {
  const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

function defaultHttpRequest(options: https.RequestOptions, body: Buffer | Uint8Array, timeoutMs: number): Promise<{statusCode:number;headers:Record<string,string|string[]|undefined>}> {
  return new Promise((resolve,reject)=>{
    const abort=new AbortController();
    const timer=setTimeout(()=>abort.abort(),timeoutMs);
    const req=https.request({...options,signal:options.signal?AbortSignal.any([options.signal,abort.signal]):abort.signal,agent:false,rejectUnauthorized:true},res=>{
      let size=0;
      res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>4096)res.destroy(new Error('push_response_limit'));});
      res.once('error',reject);res.once('aborted',()=>reject(new Error('push_response_aborted')));
      res.once('end',()=>resolve({statusCode:res.statusCode??500,headers:res.headers}));
    });
    req.once('error',reject);req.once('close',()=>clearTimeout(timer));req.end(body);
  });
}
async function bounded<T>(operation:Promise<T>,ms:number):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([operation,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('push_timeout')),ms);})]);}
  finally{if(timer)clearTimeout(timer);}
}
/** Acceptance by a push service is not proof that a phone displayed it. */
export async function sendPushNotification(options: SendPushOptions): Promise<PushDeliveryResult> {
  let url:URL,body:Buffer,headers:Record<string,string>,timeoutMs:number;
  try {
    if(!validatePushEndpoint(options.subscription.endpoint).valid)return {status:'rejected',errorCategory:'illegal_endpoint'};
    url=new URL(options.subscription.endpoint);
    if(typeof options.payload!=='string'||Buffer.byteLength(options.payload)>MAX_PAYLOAD_BYTES)return {status:'rejected',errorCategory:'payload_too_large'};
    parsePushPayload(JSON.parse(options.payload));
    validatePushKey(options.subscription.keys.p256dh,65);validatePushKey(options.subscription.keys.auth,16);
    validatePushKey(options.vapidKeys.publicKey,65);validatePushKey(options.vapidKeys.privateKey,32);
    timeoutMs=options.timeoutMs??10000;
    const ttl=options.ttlSeconds??MAX_PUSH_TTL_SECONDS;
    if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000||!Number.isInteger(ttl)||ttl<0||ttl>MAX_PUSH_TTL_SECONDS)return {status:'rejected',errorCategory:'invalid_limits'};
    const result=webPush.generateRequestDetails(options.subscription,options.payload,{vapidDetails:{subject:options.vapidKeys.subject??'https://github.com/superafat/94AiUsageDashboard-Public',publicKey:options.vapidKeys.publicKey,privateKey:options.vapidKeys.privateKey},TTL:ttl,contentEncoding:'aes128gcm',urgency:'normal'});
    body=Buffer.from(result.body??[]);headers=result.headers;
  } catch{return {status:'rejected',errorCategory:'invalid_payload_or_keys'};}
  const deadline=Date.now()+timeoutMs;
  let ips:string[];
  try{ips=await bounded((options.dnsLookup??defaultDnsLookup)(url.hostname),timeoutMs);}
  catch{return {status:'transient_error',errorCategory:'dns_resolution_failed'};}
  if(!Array.isArray(ips)||ips.length===0||ips.length>16)return {status:'rejected',errorCategory:'dns_no_records'};
  if(ips.some(ip=>!isRoutableIp(ip)))return {status:'rejected',errorCategory:'dns_private_ip'};
  const remaining=deadline-Date.now();if(remaining<=0)return {status:'transient_error',errorCategory:'network_timeout'};
  if(options.signal?.aborted)return {status:'transient_error',errorCategory:'aborted'};
  const request:https.RequestOptions={...(options.signal?{signal:options.signal}:{}),method:'POST',host:ips[0]!,port:443,path:url.pathname+url.search,servername:url.hostname,headers:{...headers,host:url.hostname},agent:false,rejectUnauthorized:true};
  try{
    const response=await bounded((options.httpRequest??defaultHttpRequest)(request,body,remaining),remaining);
    const code=response.statusCode;
    if(code>=200&&code<300)return {status:'accepted',statusCode:code};
    if(code===404||code===410)return {status:'not_registered',statusCode:code};
    if(code===429)return {status:'rate_limited',statusCode:code};
    if(code>=500&&code<600)return {status:'transient_error',statusCode:code};
    return {status:'rejected',statusCode:code};
  }catch{return {status:'transient_error',errorCategory:'network_error'};}
}
