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
