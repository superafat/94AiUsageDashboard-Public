import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
type DeliveryState='pending'|'accepted'|'terminal';
interface Entry {expiresAt:number;attempts:number;lastAttempt:number;state:DeliveryState}
/** Bounded local delivery attempts. Never stores endpoints, message bodies or signing keys. */
export class PushDeliveryJournal {
 private readonly root:string; private readonly inode:fs.Stats;
 constructor(root:string){const s=fs.lstatSync(root);if(!s.isDirectory()||s.isSymbolicLink())throw Error('delivery_directory_rejected');this.root=fs.realpathSync(root);this.inode=s;}
 private check(){const s=fs.lstatSync(this.root);if(s.ino!==this.inode.ino||s.dev!==this.inode.dev||s.isSymbolicLink())throw Error('delivery_directory_changed');}
 private transaction<T>(now:number,action:(rows:Record<string,Entry>)=>T):T{
  if(!Number.isFinite(now)||now<0)throw Error('delivery_clock_invalid');this.check();
  const lock=path.join(this.root,'delivery.lock'),file=path.join(this.root,'delivery.json');
  const fd=fs.openSync(lock,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600),own=fs.fstatSync(fd);
  try{
   const rows:Record<string,Entry>=Object.create(null);let input:unknown={};
   let readFd:number|undefined;
   try{readFd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK|fs.constants.O_NOFOLLOW);}
   catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw Error('delivery_read_rejected');}
   if(readFd!==undefined){try{const s=fs.fstatSync(readFd);if(!s.isFile()||s.nlink!==1||s.size>131072)throw Error('delivery_file_rejected');const b=Buffer.alloc(131073);let size=0,n;while(size<b.length&&(n=fs.readSync(readFd,b,size,b.length-size,null))>0)size+=n;if(size>131072)throw Error('delivery_file_limit');input=JSON.parse(b.subarray(0,size).toString());}finally{fs.closeSync(readFd);}}
   if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length>512)throw Error('delivery_corrupt');
   for(const [key,v]of Object.entries(input)){
    const r=v as Entry;if(!/^[a-f0-9]{64}$/.test(key)||!r||typeof r!=='object'||Object.keys(r).sort().join(',')!=='attempts,expiresAt,lastAttempt,state'||!Number.isFinite(r.expiresAt)||!Number.isFinite(r.lastAttempt)||r.lastAttempt<0||!Number.isInteger(r.attempts)||r.attempts<1||r.attempts>3||!['pending','accepted','terminal'].includes(r.state))throw Error('delivery_corrupt');
    if(r.expiresAt>now)rows[key]={...r};
   }
   const result=action(rows);if(Object.keys(rows).length>512)throw Error('delivery_item_limit');
   const bytes=Buffer.from(JSON.stringify(rows));if(bytes.length>131072)throw Error('delivery_byte_limit');
   this.check();const tmp=path.join(this.root,'delivery-'+randomUUID()+'.tmp');const writeFd=fs.openSync(tmp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);let renamed=false;
   try{try{fs.writeFileSync(writeFd,bytes);fs.fsyncSync(writeFd);}finally{fs.closeSync(writeFd);}this.check();fs.renameSync(tmp,file);renamed=true;const dir=fs.openSync(this.root,fs.constants.O_RDONLY);try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}finally{if(!renamed)fs.unlinkSync(tmp);}
   return result;
  }finally{fs.closeSync(fd);const s=fs.lstatSync(lock);if(s.ino===own.ino&&s.dev===own.dev&&!s.isSymbolicLink())fs.unlinkSync(lock);}
 }
 begin(id:string,expiresAt:number,now:number):{send:boolean;state:DeliveryState;attempt:number}{
  if(!/^[a-f0-9]{64}$/.test(id)||!Number.isFinite(expiresAt)||expiresAt<=now||expiresAt-now>1800000)throw Error('delivery_invalid');
  return this.transaction(now,rows=>{const r=rows[id];if(r?.state==='accepted'||r?.state==='terminal')return{send:false,state:r.state,attempt:r.attempts};if(r&&now-r.lastAttempt<30000)return{send:false,state:'pending',attempt:r.attempts};if(r&&r.attempts>=3){r.state='terminal';return{send:false,state:'terminal',attempt:r.attempts};}const attempt=(r?.attempts??0)+1;rows[id]={expiresAt,attempts:attempt,lastAttempt:now,state:'pending'};return{send:true,state:'pending',attempt};});
 }
 finish(id:string,attempt:number,state:DeliveryState,now:number){this.transaction(now,rows=>{const row=rows[id];if(row&&row.attempts===attempt&&row.state==='pending')row.state=state;});}
}
