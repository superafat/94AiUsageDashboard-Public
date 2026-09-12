import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../apps/web/public/sw.js', import.meta.url), 'utf8');
function worker() {
  const events = new Map();
  const writes = [];
  const cache = { put: async (...args) => writes.push(args), match: async () => undefined };
  vm.runInNewContext(source, {
    self: { location: { origin: 'https://dashboard.example' }, addEventListener: (key, handler) => events.set(key, handler) },
    URL, Response, fetch: async () => new Response('static'),
    caches: { open: async () => cache, keys: async () => [], delete: async () => true },
  });
  return { events, writes };
}

for (const path of ['/__/auth/handler?code=private-code', '/__/auth/iframe', '/api/private', '/?token=private-token']) {
  test(`service worker leaves non-static or credential-bearing requests alone: ${path.split('?')[0]}`, async () => {
    const { events } = worker();
    let response;
    events.get('fetch')({ request: { url: `https://dashboard.example${path}`, method: 'GET', mode: 'navigate' }, respondWith: (value) => { response = value; } });
    if (response) await response;
    assert.equal(response, undefined);
  });
}

function createMockIdb(initialData = {}) {
  const stores={enrollment:new Map(Object.entries(initialData.enrollment||{})),dedup:new Map(Object.entries(initialData.dedup||{}))};
  return {stores,open:()=>{
    const db={objectStoreNames:{contains:name=>name in stores},close:()=>undefined,transaction:()=>{
      let pending=0;
      const tx={oncomplete:null,onerror:null,onabort:null,objectStore:name=>{
        const request=action=>{pending++;const req={result:undefined,onsuccess:null,onerror:null};queueMicrotask(()=>{req.result=action();req.onsuccess?.({target:req});pending--;queueMicrotask(()=>{if(!pending)tx.oncomplete?.({target:tx});});});return req;};
        return {get:key=>request(()=>stores[name].get(key)||null),put:(value,key)=>request(()=>{stores[name].set(key,value);return key;})};
      }};return tx;
    }};
    const req={result:db,onsuccess:null,onerror:null};queueMicrotask(()=>req.onsuccess?.({target:req}));return req;
  }};
}

test('service worker handles valid canonical consumption push and displays canonical title and body', async () => {
  const events = new Map();
  let shownTitle = null;
  let shownOptions = null;
  const mockIdb = createMockIdb({
    enrollment: { current: { browserId: 'b-1', epoch: 2 } },
  });

  vm.runInNewContext(source, {
    self: {
      location: { origin: 'https://dashboard.example' },
      addEventListener: (key, handler) => events.set(key, handler),
      registration: {
        showNotification: async (title, opts) => {
          shownTitle = title;
          shownOptions = opts;
        },
      },
    },
    URL, Response, fetch: async () => new Response('static'),
    caches: { open: async () => ({ put: async () => {}, match: async () => undefined }), keys: async () => [] },
    indexedDB: mockIdb,
    Date,
  });

  const payload = {
    version: 1,
    browserId: 'b-1',
    epoch: 2,
    eventId: 'qne_123',
    type: 'consumption',
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    title: 'Codex · 5 小時額度',
    body: '已達 35% 耗用，剩餘 65%',
  };

  let waitPromise = null;
  events.get('push')({
    data: { json: () => payload, text: () => JSON.stringify(payload) },
    waitUntil: (p) => { waitPromise = p; },
  });
  await waitPromise;

  assert.equal(shownTitle, 'Codex · 5 小時額度');
  assert.equal(shownOptions.body, '已達 35% 耗用，剩餘 65%');
  assert.equal(shownOptions.tag, 'b-1:qne_123');
  assert.equal(shownOptions.renotify, false);
});

test('service worker handles canonical reset push naming the provider and resource', async () => {
  const events = new Map();
  let shownTitle = null;
  let shownOptions = null;
  const mockIdb = createMockIdb({
    enrollment: { current: { browserId: 'b-1', epoch: 2 } },
  });

  vm.runInNewContext(source, {
    self: {
      location: { origin: 'https://dashboard.example' },
      addEventListener: (key, handler) => events.set(key, handler),
      registration: {
        showNotification: async (title, opts) => {
          shownTitle = title;
          shownOptions = opts;
        },
      },
    },
    URL, Response, fetch: async () => new Response('static'),
    caches: { open: async () => ({ put: async () => {}, match: async () => undefined }), keys: async () => [] },
    indexedDB: mockIdb,
    Date,
  });

  const payload = {
    version: 1,
    browserId: 'b-1',
    epoch: 2,
    eventId: 'qne_reset_1',
    type: 'reset',
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    title: 'Codex · 5 小時額度已重置',
    body: '額度已確認恢復，點此查看。',
  };

  let waitPromise = null;
  events.get('push')({
    data: { json: () => payload, text: () => JSON.stringify(payload) },
    waitUntil: (p) => { waitPromise = p; },
  });
  await waitPromise;

  assert.equal(shownTitle, 'Codex · 5 小時額度已重置');
  assert.equal(shownOptions.body, '額度已確認恢復，點此查看。');
});

test('service worker rejects payload with extra or unsafe fields', async () => {
  const events = new Map();
  let notificationShown = false;
  const mockIdb = createMockIdb({
    enrollment: { current: { browserId: 'b-1', epoch: 2 } },
  });

  vm.runInNewContext(source, {
    self: {
      location: { origin: 'https://dashboard.example' },
      addEventListener: (key, handler) => events.set(key, handler),
      registration: {
        showNotification: async () => { notificationShown = true; },
      },
    },
    URL, Response, fetch: async () => new Response('static'),
    caches: { open: async () => ({ put: async () => {}, match: async () => undefined }), keys: async () => [] },
    indexedDB: mockIdb,
    Date,
  });

  const extraFieldPayload = {
    version: 1,
    browserId: 'b-1',
    epoch: 2,
    eventId: 'qne_extra',
    type: 'consumption',
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    title: 'Codex · 5 小時額度',
    body: '已達 35% 耗用，剩餘 65%',
    malicious: 'extra_field',
  };

  let waitPromise = null;
  events.get('push')({
    data: { json: () => extraFieldPayload, text: () => JSON.stringify(extraFieldPayload) },
    waitUntil: (p) => { waitPromise = p; },
  });
  await waitPromise;

  assert.equal(notificationShown, false);
});

test('service worker suppresses push when epoch mismatches or revoked', async () => {
  const events = new Map();
  let notificationShown = false;
  const mockIdb = createMockIdb({
    enrollment: { current: { browserId: 'b-1', epoch: 3 } },
  });

  vm.runInNewContext(source, {
    self: {
      location: { origin: 'https://dashboard.example' },
      addEventListener: (key, handler) => events.set(key, handler),
      registration: {
        showNotification: async () => { notificationShown = true; },
      },
    },
    URL, Response, fetch: async () => new Response('static'),
    caches: { open: async () => ({ put: async () => {}, match: async () => undefined }), keys: async () => [] },
    indexedDB: mockIdb,
    Date,
  });

  const payload = {
    version: 1,
    browserId: 'b-1',
    epoch: 2,
    eventId: 'qne_old',
    type: 'consumption',
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  let waitPromise = null;
  events.get('push')({
    data: { json: () => payload, text: () => JSON.stringify(payload) },
    waitUntil: (p) => { waitPromise = p; },
  });
  await waitPromise;

  assert.equal(notificationShown, false);
});

test('service worker suppresses future events (>60s in future)', async () => {
  const events = new Map();
  let notificationShown = false;
  const mockIdb = createMockIdb({
    enrollment: { current: { browserId: 'b-1', epoch: 1 } },
  });

  vm.runInNewContext(source, {
    self: {
      location: { origin: 'https://dashboard.example' },
      addEventListener: (key, handler) => events.set(key, handler),
      registration: {
        showNotification: async () => { notificationShown = true; },
      },
    },
    URL, Response, fetch: async () => new Response('static'),
    caches: { open: async () => ({ put: async () => {}, match: async () => undefined }), keys: async () => [] },
    indexedDB: mockIdb,
    Date,
  });

  const payload = {
    version: 1,
    browserId: 'b-1',
    epoch: 1,
    eventId: 'qne_future',
    type: 'consumption',
    observedAt: new Date(Date.now() + 120_000).toISOString(),
    expiresAt: new Date(Date.now() + 180_000).toISOString(),
  };

  let waitPromise = null;
  events.get('push')({
    data: { json: () => payload, text: () => JSON.stringify(payload) },
    waitUntil: (p) => { waitPromise = p; },
  });
  await waitPromise;

  assert.equal(notificationShown, false);
});

test('service worker suppresses expired events', async () => {
  const events = new Map();
  let notificationShown = false;
  const mockIdb = createMockIdb({
    enrollment: { current: { browserId: 'b-1', epoch: 1 } },
  });

  vm.runInNewContext(source, {
    self: {
      location: { origin: 'https://dashboard.example' },
      addEventListener: (key, handler) => events.set(key, handler),
      registration: {
        showNotification: async () => { notificationShown = true; },
      },
    },
    URL, Response, fetch: async () => new Response('static'),
    caches: { open: async () => ({ put: async () => {}, match: async () => undefined }), keys: async () => [] },
    indexedDB: mockIdb,
    Date,
  });

  const payload = {
    version: 1,
    browserId: 'b-1',
    epoch: 1,
    eventId: 'qne_expired',
    type: 'consumption',
    observedAt: new Date(Date.now() - 600_000).toISOString(),
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  };

  let waitPromise = null;
  events.get('push')({
    data: { json: () => payload, text: () => JSON.stringify(payload) },
    waitUntil: (p) => { waitPromise = p; },
  });
  await waitPromise;

  assert.equal(notificationShown, false);
});

test('service worker suppresses duplicate event before showing', async () => {
  const events = new Map();
  let showCount = 0;
  const mockIdb = createMockIdb({
    enrollment: { current: { browserId: 'b-1', epoch: 1 } },
  });

  vm.runInNewContext(source, {
    self: {
      location: { origin: 'https://dashboard.example' },
      addEventListener: (key, handler) => events.set(key, handler),
      registration: {
        showNotification: async () => { showCount += 1; },
      },
    },
    URL, Response, fetch: async () => new Response('static'),
    caches: { open: async () => ({ put: async () => {}, match: async () => undefined }), keys: async () => [] },
    indexedDB: mockIdb,
    Date,
  });

  const payload = {
    version: 1,
    browserId: 'b-1',
    epoch: 1,
    eventId: 'qne_dup',
    type: 'test',
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  let waitPromise1 = null;
  events.get('push')({
    data: { json: () => payload, text: () => JSON.stringify(payload) },
    waitUntil: (p) => { waitPromise1 = p; },
  });
  await waitPromise1;
  assert.equal(showCount, 1);

  let waitPromise2 = null;
  events.get('push')({
    data: { json: () => payload, text: () => JSON.stringify(payload) },
    waitUntil: (p) => { waitPromise2 = p; },
  });
  await waitPromise2;
  assert.equal(showCount, 1); // Second call suppressed by dedup!
});

test('service worker suppresses same event repeated after a real context restart', async () => {
  const db=createMockIdb({enrollment:{current:{browserId:'b-1',epoch:1}}});let shown=0;
  const payload={version:1,browserId:'b-1',epoch:1,eventId:'qne_restart',type:'test',observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};
  async function inNewContext(){
    const events=new Map();
    vm.runInNewContext(source,{self:{location:{origin:'https://dashboard.example'},addEventListener:(name,handler)=>events.set(name,handler),registration:{showNotification:async()=>{shown++;}}},URL,Response,Date,TextEncoder,indexedDB:db,caches:{},fetch:async()=>new Response('')});
    let finished;events.get('push')({data:{json:()=>payload,text:()=>JSON.stringify(payload)},waitUntil:p=>{finished=p;}});await finished;
  }
  await inNewContext();assert.equal(shown,1,'first real event must display');
  await inNewContext();assert.equal(shown,1,'fresh worker must read persisted dedup, not show again');
});

test('service worker opens same-origin app root on notification click', async () => {
  const events = new Map();
  let closed = false;
  let openedUrl = null;

  vm.runInNewContext(source, {
    self: {
      location: { origin: 'https://dashboard.example' },
      addEventListener: (key, handler) => events.set(key, handler),
      clients: {
        matchAll: async () => [],
        openWindow: async (url) => { openedUrl = url; },
      },
    },
    URL, Response, fetch: async () => new Response('static'),
    caches: { open: async () => ({ put: async () => {}, match: async () => undefined }), keys: async () => [] },
    indexedDB: undefined,
  });

  let waitPromise = null;
  events.get('notificationclick')({
    notification: {
      close: () => { closed = true; },
      data: { url: 'https://evil.attacker.com/malicious' },
    },
    waitUntil: (p) => { waitPromise = p; },
  });
  await waitPromise;

  assert.equal(closed, true);
  assert.equal(openedUrl, 'https://dashboard.example/');
});

test('concurrent identical push events produce one visible notification',async()=>{
 const events=new Map(),idb=createMockIdb({enrollment:{current:{browserId:'b-concurrent',epoch:1}}});let count=0;
 vm.runInNewContext(source,{self:{location:{origin:'https://dashboard.example'},addEventListener:(key,fn)=>events.set(key,fn),registration:{showNotification:async()=>{count++;}}},URL,Response,Date,indexedDB:idb,caches:{},TextEncoder,fetch:async()=>new Response('')});
 const payload={version:1,browserId:'b-concurrent',epoch:1,eventId:'concurrent-event',type:'reset',observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};
 const pending=[];for(let i=0;i<2;i++)events.get('push')({data:{text:()=>JSON.stringify(payload),json:()=>payload},waitUntil:p=>pending.push(p)});
 await Promise.all(pending);assert.equal(count,1);
});
