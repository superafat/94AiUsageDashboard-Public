import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash, createECDH, timingSafeEqual} from 'node:crypto';
import webPush from 'web-push';
import {SENSITIVE_PATTERN, validatePushKey} from '@94ai/core';
export interface VapidKeys {publicKey: string; privateKey: string}
export interface LocalPushKeysOptions {rootDir?: string; backendId: string; userId: string; deviceId: string}
export interface LocalPushKeysResult {status: 'ready' | 'corrupt' | 'missing' | 'error'; keys?: VapidKeys; publicKey?: string; error?: string}
function identity(value: unknown): string {
  if(typeof value !== 'string' || !value.length || value.length > 128 || SENSITIVE_PATTERN.test(value) || [...value].some(c=>c.charCodeAt(0)<32)) throw Error('invalid_push_identity');
  return value;
}
export function pushScopeHash(options: Pick<LocalPushKeysOptions, 'backendId'|'userId'|'deviceId'>): string {
  return createHash('sha256').update(JSON.stringify([identity(options.backendId),identity(options.userId),identity(options.deviceId)])).digest('hex');
}
function directory(value: string): string {
  try { fs.mkdirSync(value,{mode:0o700}); } catch(e) { if((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  const st=fs.lstatSync(value);
  if(!st.isDirectory() || st.isSymbolicLink()) throw Error('invalid_push_directory');
  return fs.realpathSync(value);
}
export async function getOrCreateLocalPushKeys(options: LocalPushKeysOptions): Promise<LocalPushKeysResult> {
  try {
    const scope=pushScopeHash(options);
    const base=options.rootDir ?? path.join(os.homedir(),'.config','94ai-usage-dashboard');
    if(!fs.existsSync(base)) fs.mkdirSync(base,{recursive:true,mode:0o700});
    const root=directory(base), parent=directory(path.join(root,'push-keys')), dir=directory(path.join(parent,scope));
    const dirIdentity=fs.statSync(dir), file=path.join(dir,'vapid.json');
    const checkDir=()=>{const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||s.dev!==dirIdentity.dev||s.ino!==dirIdentity.ino)throw Error('push_directory_changed');};
    const read=():VapidKeys|undefined=>{
      checkDir();let fd:number;
      try {fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK|fs.constants.O_NOFOLLOW);}
      catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw Error('push_key_read_rejected');}
      try {
        const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>2048||(stat.mode&0o077)!==0)throw Error('invalid_push_key_file');
        const buf=Buffer.alloc(2049);let count=0,n=0;while(count<buf.length&&(n=fs.readSync(fd,buf,count,buf.length-count,null))>0)count+=n;
        if(count>2048)throw Error('push_key_file_too_large');
        const r=JSON.parse(buf.subarray(0,count).toString('utf8'));
        if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).sort().join(',')!=='privateKey,publicKey')throw Error('invalid_push_keys');
        const keys={publicKey:validatePushKey(r.publicKey,65),privateKey:validatePushKey(r.privateKey,32)};
        const ec=createECDH('prime256v1');ec.setPrivateKey(Buffer.from(keys.privateKey,'base64url'));
        if(!timingSafeEqual(ec.getPublicKey(),Buffer.from(keys.publicKey,'base64url')))throw Error('push_key_pair_mismatch');
        checkDir();const after=fs.lstatSync(file);if(after.ino!==stat.ino||after.dev!==stat.dev||after.isSymbolicLink())throw Error('push_key_changed');
        return keys;
      } finally {fs.closeSync(fd);}
    };
    let keys=read();
    if(!keys){
      const generated=webPush.generateVAPIDKeys();checkDir();let fd:number;
      try {fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);}
      catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const existing=read();if(!existing)throw Error('push_keys_unavailable');return {status:'ready',keys:existing,publicKey:existing.publicKey};}
      const own=fs.fstatSync(fd);let complete=false;
      try {fs.writeFileSync(fd,JSON.stringify(generated));fs.fsyncSync(fd);complete=true;}
      finally {fs.closeSync(fd);if(!complete){const st=fs.lstatSync(file);if(st.ino===own.ino&&st.dev===own.dev)fs.unlinkSync(file);}}
      const parentFd=fs.openSync(dir,fs.constants.O_RDONLY);try{fs.fsyncSync(parentFd);}finally{fs.closeSync(parentFd);}
      keys=read();
    }
    if(!keys)throw Error('push_keys_unavailable');
    return {status:'ready',keys,publicKey:keys.publicKey};
  } catch {return {status:'corrupt',error:'push_keys_unavailable'};}
}
