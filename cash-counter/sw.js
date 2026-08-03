// Offline shell for the Cash Counter. Bump CACHE when the app files change.
const CACHE = 'tcm-cash-counter-v3'
const SHELL = ['./', './index.html', './manifest.webmanifest', './logo-192.png', './icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  // wa.me and anything else off-origin must always go to the network.
  if (new URL(request.url).origin !== self.location.origin) return

  // The page itself is network-first, so a redeploy reaches the phone on the
  // next open instead of waiting for the cache name to change. With no signal
  // it falls back to the copy saved on the last successful load.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put('./index.html', copy))
          return res
        })
        .catch(() =>
          caches.match('./index.html').then((hit) => hit || caches.match('./')),
        ),
    )
    return
  }

  // Icon and manifest change rarely: serve from cache, refresh behind it.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(request, copy))
          return res
        })
        .catch(() => hit)
      return hit || network
    }),
  )
})
