/* =============================================================================
 * TCM BrewOps — service worker
 * -----------------------------------------------------------------------------
 * Registered by TCM.registerServiceWorker() once a page has passed its auth
 * guard. Previously this file existed but no page ever registered it, so none
 * of it ran.
 *
 * Strategy:
 *   - HTML documents          -> network only, never cached
 *   - own static assets       -> stale-while-revalidate
 *   - anything cross-origin   -> not intercepted at all
 *   - anything non-GET        -> not intercepted at all
 * ========================================================================== */

const CACHE_NAME = 'tcm-po-v4';

// Only genuinely static, non-sensitive files. HTML is deliberately absent: the
// dashboards are behind a login and must not be served from a stale cache to
// whoever opens the browser next.
const PRECACHE = [
  './manifest.json',
  './assets/tcm-boot.js',
  './assets/tcm-core.js',
  './assets/tcm-theme.js',
  './assets/bg-dashboard.jpg',
  './assets/bg-login.jpg',
  './assets/login-card.jpg',
  './assets/name.png',
  './assets/page-header.png',
  './assets/favicon.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      // addAll rejects the whole install if any single file 404s; this way a
      // renamed asset degrades to "not precached" instead of a broken worker.
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Never touch writes, auth calls, or Firestore's streaming channel.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Cross-origin (CDN scripts, Google Fonts, Firebase APIs) is left entirely to
  // the browser's own HTTP cache. The previous network-first handler intercepted
  // these too, which meant the 2.8 MB Babel bundle was re-fetched from the
  // network on every load instead of being served from the immutable HTTP cache.
  if (url.origin !== self.location.origin) return;

  // Never serve an authenticated page from cache.
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(fetch(req));
    return;
  }

  // Static same-origin assets: serve instantly, refresh in the background.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => cached);

      return cached || network;
    })
  );
});
