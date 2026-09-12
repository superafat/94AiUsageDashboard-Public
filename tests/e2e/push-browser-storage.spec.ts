import {test,expect} from '@playwright/test';
import {build} from 'esbuild';
import path from 'node:path';

test('actual browser-first IndexedDB upgrades both stores and commits enrollment removal',async({page})=>{
 await page.goto('/');
 await page.evaluate(async()=>new Promise<void>((resolve,reject)=>{
  const req=indexedDB.open('94ai-push-db',1);req.onupgradeneeded=()=>req.result.createObjectStore('enrollment');req.onsuccess=()=>{req.result.close();resolve();};req.onerror=()=>reject(req.error);
 }));
 const bundled=await build({entryPoints:[path.resolve('apps/web/src/notifications.ts')],bundle:true,format:'iife',globalName:'pushBrowserProbe',platform:'browser',write:false,logLevel:'silent'});
 await page.addScriptTag({content:bundled.outputFiles[0]!.text});
 const actual=await page.evaluate(async()=>{
  const probe=(window as unknown as {pushBrowserProbe:{createIndexedDbStorage:()=>{set:(v:unknown)=>Promise<void>;get:()=>Promise<unknown>;clear:()=>Promise<void>}}}).pushBrowserProbe;
  const first=probe.createIndexedDbStorage();const synthetic={uid:'synthetic-user',backendId:'synthetic-project',browserId:'synthetic-browser',epoch:1,applicationServerKey:'not-a-real-signing-key'};
  await first.set(synthetic);const reread=await probe.createIndexedDbStorage().get();await first.clear();const removed=await probe.createIndexedDbStorage().get();
  const stores=await new Promise<string[]>((resolve,reject)=>{const req=indexedDB.open('94ai-push-db',2);req.onsuccess=()=>{const names=[...req.result.objectStoreNames];req.result.close();resolve(names);};req.onerror=()=>reject(req.error);});
  return{reread,removed,stores};
 });
 expect(actual.reread).toEqual(expect.objectContaining({browserId:'synthetic-browser',epoch:1}));expect(actual.removed).toBeNull();expect(actual.stores.sort()).toEqual(['dedup','enrollment']);
});
