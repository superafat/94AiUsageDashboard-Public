import {test,expect} from '@playwright/test';
import {build} from 'esbuild';
import path from 'node:path';

// Desktop Chromium capability; actual iPhone permission and delivery are separate acceptance.
test.use({isMobile:false,hasTouch:false});

test('real browser storage and background handler display a synthetic notification with page closed and reject replay after restart',async({page,context})=>{
 test.setTimeout(45000);
 await page.goto('/');const origin=new URL(page.url()).origin;
 await context.grantPermissions(['notifications']); // Only this isolated synthetic browser context.
 console.log('ISOLATED_PERMISSION_PREFLIGHT',await page.evaluate(async()=>({secure:isSecureContext,notification:Notification.permission,query:(await navigator.permissions.query({name:'notifications'})).state})));
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 const bundled=await build({entryPoints:[path.resolve('apps/web/src/notifications.ts')],bundle:true,format:'iife',globalName:'pushBrowserProbe',platform:'browser',write:false,logLevel:'silent'});
 await page.addScriptTag({content:bundled.outputFiles[0]!.text});
 await page.evaluate(async()=>{
   const probe=(window as unknown as {pushBrowserProbe:{createIndexedDbStorage:()=>{set:(value:unknown)=>Promise<void>}}}).pushBrowserProbe;
   await probe.createIndexedDbStorage().set({uid:'synthetic-browser-user',backendId:'synthetic-project',browserId:'synthetic-browser',epoch:1,applicationServerKey:'synthetic-not-a-live-key'});
   await navigator.serviceWorker.ready;
 });
 const storeNames=await page.evaluate(async()=>new Promise<string[]>((resolve,reject)=>{
  const r=indexedDB.open('94ai-push-db',2);r.onsuccess=()=>{const names=[...r.result.objectStoreNames];r.result.close();resolve(names);};r.onerror=()=>reject(r.error);
 }));
 expect(storeNames.sort()).toEqual(['dedup','enrollment']);
 const control=await context.newPage();const cdp=await context.newCDPSession(control);
 let registrationId='',versionId='';
 cdp.on('ServiceWorker.workerRegistrationUpdated',(event:{registrations:Array<{registrationId:string;scopeURL:string}>})=>{for(const r of event.registrations)if(r.scopeURL===origin+'/')registrationId=r.registrationId;});
 cdp.on('ServiceWorker.workerVersionUpdated',(event:{versions:Array<{registrationId:string;versionId:string}>})=>{for(const v of event.versions)if(v.registrationId===registrationId)versionId=v.versionId;});
 await cdp.send('ServiceWorker.enable');
 await expect.poll(()=>registrationId).not.toBe('');
 const worker=context.serviceWorkers().find(w=>w.url()===origin+'/sw.js');expect(worker).toBeDefined();
 expect(await page.evaluate(()=>Notification.permission)).toBe('granted');
 expect(await worker!.evaluate('Notification.permission')).toBe('granted');
 await page.close();expect(context.pages().filter(p=>p.url().startsWith(origin))).toHaveLength(0);
 const at=Date.now();const payload={version:1,browserId:'synthetic-browser',epoch:1,eventId:'native-restart-example',type:'reset',observedAt:new Date(at).toISOString(),expiresAt:new Date(at+60000).toISOString()};
 // Invoke the real background handler with synthetic data; this is not a remote push-service receipt.
 await worker!.evaluate(`handlePushEvent({data:{text:()=>${JSON.stringify(JSON.stringify(payload))},json:()=>(${JSON.stringify(payload)})}})`);
 const receiver=await context.newPage();await receiver.goto(origin+'/manifest.webmanifest');
 await expect.poll(()=>receiver.evaluate(async()=> (await (await navigator.serviceWorker.getRegistration())!.getNotifications()).length)).toBe(1);
 await receiver.evaluate(async()=>{for(const n of await (await navigator.serviceWorker.getRegistration())!.getNotifications())n.close();});
 await expect.poll(()=>versionId).not.toBe('');await cdp.send('ServiceWorker.stopWorker',{versionId});
 const restartedPromise=context.waitForEvent('serviceworker');
 await cdp.send('ServiceWorker.startWorker',{scopeURL:origin+'/'});
 const restarted=await restartedPromise;await restarted.evaluate(`handlePushEvent({data:{text:()=>${JSON.stringify(JSON.stringify(payload))},json:()=>(${JSON.stringify(payload)})}})`);
 expect(await receiver.evaluate(async()=> (await (await navigator.serviceWorker.getRegistration())!.getNotifications()).length)).toBe(0);
 await receiver.close();await control.close();
});
