/* Ledger Service Worker
   - Offline caching (cache-first with network update)
   - Notification click handling
   - Best-effort periodic sync for daily reminder
*/

const CACHE_VERSION = 'ledger-v3';
const CORE_ASSETS = [
  './',
  './index.html',
  './ledger.html',
  './manifest.json',
  './icon.svg'
];

// CDN assets to pre-cache when possible (cross-origin, may fail silently)
const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // Core assets: must succeed (with individual catches so one missing file doesn't fail install)
    await Promise.all(
      CORE_ASSETS.map(url =>
        cache.add(url).catch(err => console.warn('Skip caching', url, err))
      )
    );
    // CDN assets: best effort
    await Promise.all(
      CDN_ASSETS.map(url =>
        cache.add(new Request(url, { mode: 'cors' })).catch(() => {})
      )
    );
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // For navigation requests, prefer network so users get fresh HTML when online,
  // fall back to cache when offline
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_VERSION);
        cache.put(req, fresh.clone()).catch(() => {});
        return fresh;
      } catch (e) {
        const cached = await caches.match(req);
        return cached || caches.match('./ledger.html') || caches.match('./index.html');
      }
    })());
    return;
  }

  // For everything else: cache-first, update in background
  event.respondWith((async () => {
    const cached = await caches.match(req);
    const fetchPromise = fetch(req).then(res => {
      if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
        const clone = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(req, clone)).catch(() => {});
      }
      return res;
    }).catch(() => cached);
    return cached || fetchPromise;
  })());
});

// Notification click — focus or open the app
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of allClients) {
      if ('focus' in c) {
        await c.focus();
        return;
      }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow('./');
    }
  })());
});

// Periodic Background Sync (Chrome PWAs that support it).
// Tag 'ledger-daily-check' is registered from the page on load when supported.
self.addEventListener('periodicsync', event => {
  if (event.tag === 'ledger-daily-check') {
    event.waitUntil(showReminderIfNeeded());
  }
});

async function showReminderIfNeeded() {
  // The SW can't read localStorage; we just fire a generic reminder.
  // The page will suppress duplicates if already logged today (in-app banner reads state).
  try {
    await self.registration.showNotification('Ledger', {
      body: "Don't forget to log today's expenses",
      icon: 'icon.svg',
      badge: 'icon.svg',
      tag: 'ledger-daily',
      renotify: false,
      requireInteraction: false
    });
  } catch (e) {}
}

// Allow page to message the SW (future: pass state for smarter notifications)
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
