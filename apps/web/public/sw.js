/* global self, caches */
const CACHE = '94ai-usage-dashboard-v2';
function isStaticShell(url) {
  return url.origin === self.location.origin && !url.search && (
    ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'].includes(url.pathname)
    || /^\/assets\/[^/]+\.(?:js|css|png|svg|woff2?)$/.test(url.pathname)
  );
}

async function precacheShell() {
  const cache = await caches.open(CACHE);
  const response = await fetch('/');
  if (!response.ok) throw new Error('App shell unavailable');
  await cache.put('/', response.clone());
  const html = await response.text();
  const paths = new Set(['/manifest.webmanifest']);
  for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
    const url = new URL(match[1], self.location.origin);
    if (isStaticShell(url)) paths.add(url.pathname);
  }
  await cache.addAll([...paths]);
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell());
  self.skipWaiting();
});
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const key of await caches.keys()) {
    if (key.startsWith('94ai-usage-dashboard-') && key !== CACHE) await caches.delete(key);
  }
  await self.clients.claim();
})()));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || !isStaticShell(url)) return;
  event.respondWith(fetch(event.request).then(async (response) => {
    if (response.ok) {
      const copy = response.clone();
      await caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => undefined);
    }
    return response;
  }).catch(async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(url.pathname, { ignoreSearch: true, ignoreVary: true });
    if (cached) return cached;
    if (event.request.mode === 'navigate') return (await cache.match('/', { ignoreVary: true })) || Response.error();
    return Response.error();
  }));
});
