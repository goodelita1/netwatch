/**
 * NetWatch Service Worker
 * Стратегия: Cache-First для статики, Network-First для API
 * При офлайн показывает кэшированный UI
 */

// Cache version — auto-derived from SW file modification date
// Increment the number below after any deployment to invalidate old caches
const CACHE_VERSION = 3;
const CACHE_NAME    = `netwatch-v${CACHE_VERSION}`;
const CACHE_STATIC  = `netwatch-static-v${CACHE_VERSION}`;

// Статика которую кэшируем при установке
const PRECACHE = [
  '/',
  '/static/css/main.css',
  '/static/js/globals.js',
  '/static/js/traceroute.js',
  '/static/js/topology.js',
  '/static/js/groups.js',
  '/static/js/snmp.js',
  '/static/js/dashboard.js',
  '/static/js/notifications.js',
  '/static/js/twofa.js',
  '/static/js/sla.js',
  '/static/js/mikrotik.js',
  '/static/js/websocket.js',
  '/static/manifest.json',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
];

// API пути — никогда не кэшируем
const API_PATHS = ['/api/', '/login', '/logout', '/socket.io/'];

// ── Install ───────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_STATIC)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ── Activate ──────────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== CACHE_STATIC)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Пропускаем WebSocket и API — всегда через сеть
  if (event.request.method !== 'GET') return;
  if (API_PATHS.some(p => url.pathname.startsWith(p))) return;
  if (url.protocol === 'chrome-extension:') return;

  // Статика: Cache-First
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (!response || response.status !== 200) return response;
          const clone = response.clone();
          caches.open(CACHE_STATIC).then(c => c.put(event.request, clone));
          return response;
        });
      })
    );
    return;
  }

  // Главная страница: Network-First с fallback на кэш
  if (url.pathname === '/' || url.pathname === '') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }
});

// ── Push notifications (Web Push API) ────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    event.waitUntil(
      self.registration.showNotification(data.title || 'NetWatch', {
        body:    data.body  || '',
        icon:    '/static/icons/icon-192.png',
        badge:   '/static/icons/icon-72.png',
        tag:     data.tag   || 'netwatch',
        data:    data.url   || '/',
        vibrate: [200, 100, 200],
      })
    );
  } catch(e) {
    console.error('[sw] push error:', e);
  }
});

// Клик по уведомлению — открыть приложение
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) return clients.openWindow(url);
      })
  );
});