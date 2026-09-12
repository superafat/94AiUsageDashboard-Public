/* global self, caches, indexedDB */
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

const PUSH_DB_NAME = '94ai-push-db';
const ENROLLMENT_STORE = 'enrollment';
const DEDUP_STORE = 'dedup';
const MAX_PAYLOAD_BYTES = 2048;
const MAX_TTL_MS = 30 * 60 * 1000;
const ISO_REGEX = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/;
const ALLOWED_PAYLOAD_KEYS = new Set([
  'version', 'browserId', 'epoch', 'eventId', 'type', 'observedAt', 'expiresAt', 'title', 'body',
]);

function isValidCalendarDate(year, month, day) {
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
  const maxDays = [0, 31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (maxDays[month] || 31);
}

function parseDateIso(str) {
  if (typeof str !== 'string' || str.length > 64) return null;
  const m = ISO_REGEX.exec(str);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (!isValidCalendarDate(y, mo, d)) return null;
  const ms = Date.parse(str);
  return Number.isFinite(ms) ? ms : null;
}

function openPushDb() {
  if (typeof indexedDB === 'undefined' || !indexedDB) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(PUSH_DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(ENROLLMENT_STORE)) db.createObjectStore(ENROLLMENT_STORE);
        if (!db.objectStoreNames.contains(DEDUP_STORE)) db.createObjectStore(DEDUP_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

const SENSITIVE_PATTERN = /(?:\bBearer\s+\S+|\/(?:Users|home|var|tmp|etc|opt|private)\/[^\s"']+|[a-zA-Z]:\\[^\s"']+|\b(?:sk-(?:ant-|proj-)?[a-zA-Z0-9_-]{10,}|AIza[0-9A-Za-z-_]{35})\b|\b(?:ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{20,}\b|\bgithub_pat_[a-zA-Z0-9_]{30,}\b|(?:access|refresh)[_-]?token\s*[=:]\s*\S+|(?:api[_-]?key)\s*[=:]\s*\S+)/i;

const KNOWN_PROVIDER_NAMES = new Set([
  'Codex', 'Antigravity', 'Claude Code', 'Copilot', 'Cursor', 'Devin',
  'Grok', 'Ollama (Cloud)', 'OpenCode', 'OpenRouter', 'Zai',
]);

const KNOWN_RESOURCE_LABELS = new Set([
  '額度', '5 小時額度', '每週額度', 'Spark 5 小時', 'Spark 每週',
  'gpt-reserve', 'Gemini 5 小時', 'Gemini 每週', '非 Gemini 5 小時',
  '非 Gemini 每週', 'Fable 每週', 'Sonnet 每週', '額外用量',
]);

function isSafeText(str, max) {
  if (typeof str !== 'string' || !str.length || str.length > max) return false;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) < 32) return false;
  }
  return !SENSITIVE_PATTERN.test(str);
}

function genericNotificationText(type) {
  if (type === 'test') return { title: '測試通知', body: '這是 94AiUsageDashboard 的測試推播' };
  if (type === 'reset') return { title: 'AI 額度重置通知', body: '有來源的額度已確認恢復，點此查看。' };
  return { title: 'AI 額度消耗通知', body: '有來源達到新的耗用門檻，點此查看。' };
}

function resolveNotificationDisplay(type, rawTitle, rawBody) {
  const generic = genericNotificationText(type);
  const title = (rawTitle === undefined || rawTitle === null) ? generic.title : rawTitle;
  const body = (rawBody === undefined || rawBody === null) ? generic.body : rawBody;

  if (!isSafeText(title, 128) || !isSafeText(body, 512)) return null;

  if (type === 'test') {
    if (title === '測試通知' && body === '這是 94AiUsageDashboard 的測試推播') {
      return { title, body };
    }
    return null;
  }

  if (type === 'reset') {
    if (title === 'AI 額度重置通知' && (body === '有來源的額度已確認恢復，點此查看。' || body === '額度已確認恢復，點此查看。')) {
      return { title, body };
    }
    if (body !== '額度已確認恢復，點此查看。') return null;
    const match = /^([^\s·]+(?:\s+[^\s·]+)*)\s*·\s*(.+?)已重置$/.exec(title);
    if (!match) return null;
    if (KNOWN_PROVIDER_NAMES.has(match[1]) && KNOWN_RESOURCE_LABELS.has(match[2])) {
      return { title, body };
    }
    return null;
  }

  if (type === 'consumption') {
    if (title === 'AI 額度消耗通知' && body === '有來源達到新的耗用門檻，點此查看。') {
      return { title, body };
    }
    const match = /^([^\s·]+(?:\s+[^\s·]+)*)\s*·\s*(.+)$/.exec(title);
    if (!match) return null;
    if (!KNOWN_PROVIDER_NAMES.has(match[1]) || !KNOWN_RESOURCE_LABELS.has(match[2])) {
      return null;
    }
    if (body === '有來源達到新的耗用門檻，點此查看。') return { title, body };
    const bodyMatch = /^已達 (\d{1,3})% 耗用，剩餘 (\d{1,3})%$/.exec(body);
    if (!bodyMatch) return null;
    const used = Number(bodyMatch[1]);
    const rem = Number(bodyMatch[2]);
    if (used >= 0 && used <= 100 && rem >= 0 && rem <= 100 && used + rem === 100) {
      return { title, body };
    }
    return null;
  }

  return null;
}

function getByteLength(str) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str).length;
  }
  return unescape(encodeURIComponent(str)).length;
}

// Claim a bounded event ID and read the active enrollment in one durable transaction.
function claimPush(db, payload, now, expiresTime) {
  return new Promise((resolve) => {
    let accepted = false;
    try {
      const tx = db.transaction([ENROLLMENT_STORE, DEDUP_STORE], 'readwrite');
      tx.oncomplete = () => { db.close?.(); resolve(accepted); };
      tx.onabort = tx.onerror = () => { db.close?.(); resolve(false); };
      const current = tx.objectStore(ENROLLMENT_STORE).get('current');
      current.onsuccess = () => {
        const enrollment = current.result;
        if (!enrollment || enrollment.browserId !== payload.browserId || enrollment.epoch !== payload.epoch) return;
        const store = tx.objectStore(DEDUP_STORE), request = store.get('recent');
        request.onsuccess = () => {
          const stored = request.result ?? {};
          if (!stored || typeof stored !== 'object' || Array.isArray(stored) || Object.keys(stored).length > 512) return;
          const rows = Object.create(null);
          for (const [key, expiry] of Object.entries(stored)) {
            if (typeof expiry !== 'number' || !Number.isFinite(expiry) || key.length > 400) return;
            if (expiry > now) rows[key] = expiry;
          }
          const id = `${payload.browserId}:${payload.epoch}:${payload.eventId}`;
          if (rows[id] || Object.keys(rows).length >= 512) return;
          rows[id] = expiresTime;
          store.put(rows, 'recent');
          accepted = true;
        };
      };
    } catch { db.close?.(); resolve(false); }
  });
}

async function handlePushEvent(event) {
  if (!event || !event.data) return;
  let rawText = '';
  let payload = null;
  try {
    if (typeof event.data.text === 'function') {
      rawText = event.data.text();
      if (getByteLength(rawText) > MAX_PAYLOAD_BYTES) return;
    }
    if (typeof event.data.json === 'function') {
      payload = event.data.json();
    } else if (rawText) {
      payload = JSON.parse(rawText);
    }
  } catch {
    return;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;

  const rawBytes = getByteLength(rawText || JSON.stringify(payload));
  if (rawBytes > MAX_PAYLOAD_BYTES) return;

  for (const key of Object.keys(payload)) {
    if (!ALLOWED_PAYLOAD_KEYS.has(key)) return;
  }

  if (payload.version !== 1) return;
  if (typeof payload.browserId !== 'string' || !payload.browserId || payload.browserId.length > 128) return;
  if (typeof payload.epoch !== 'number' || !Number.isInteger(payload.epoch) || payload.epoch < 1) return;
  if (typeof payload.eventId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(payload.eventId) || payload.eventId.length > 128) return;
  if (payload.type !== 'consumption' && payload.type !== 'reset' && payload.type !== 'test') return;

  const observedTime = parseDateIso(payload.observedAt);
  const expiresTime = parseDateIso(payload.expiresAt);
  if (observedTime === null || expiresTime === null) return;
  if (expiresTime <= observedTime || (expiresTime - observedTime) > MAX_TTL_MS) return;

  const now = Date.now();
  if (observedTime > now + 60_000) return; // no future events
  if (expiresTime <= now) return; // no expired events

  const db = await openPushDb();
  if (!db) return; // fail-closed

  if (!await claimPush(db, payload, now, expiresTime)) return;

  const display = resolveNotificationDisplay(payload.type, payload.title, payload.body);
  if (!display) return;
  const { title, body } = display;
  const tag = `${payload.browserId}:${payload.eventId}`;

  if (self.registration && self.registration.showNotification) {
    await self.registration.showNotification(title, {
      body,
      tag,
      renotify: false,
      data: {
        origin: self.location.origin,
      },
    });
  }
}

let pushQueue = Promise.resolve();
self.addEventListener('push', (event) => {
  const task = pushQueue.then(() => handlePushEvent(event));
  pushQueue = task.catch(() => undefined);
  event.waitUntil(pushQueue);
});

self.addEventListener('notificationclick', (event) => {
  if (event.notification) event.notification.close();
  const rootUrl = new URL('/', self.location.origin).href;
  event.waitUntil((async () => {
    if (!self.clients) return;
    try {
      const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of allClients) {
        try {
          const clientUrl = new URL(client.url);
          if (clientUrl.origin === self.location.origin) {
            return client.focus();
          }
        } catch {
          // ignore
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(rootUrl);
      }
    } catch {
      // ignore
    }
  })());
});
