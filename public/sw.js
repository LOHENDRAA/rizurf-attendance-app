// Bumped so browsers that already registered an earlier version (e.g. from
// before the app's routing was fixed, possibly caching a broken/blank page)
// throw away that old cache on activate instead of continuing to serve it.
const CACHE_NAME = 'rizurf-attendance-v2'

// The app can be served from a sub-path (e.g. /qr-system/), not just the
// domain root -- derive it from this script's own URL rather than
// hardcoding '/', which would point at the wrong place.
const BASE_PATH = self.location.pathname.replace(/sw\.js$/, '')
const APP_SHELL = [BASE_PATH, `${BASE_PATH}index.html`, `${BASE_PATH}manifest.webmanifest`]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))))
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const { request } = event

  // Never touch non-GET requests (clock in/out, leave submissions, etc.)
  // -- those must always go straight to the network.
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // Never cache API responses. Attendance/leave data must always be fresh
  // when online; there's no useful "offline" version of it anyway.
  if (url.origin !== self.location.origin || url.pathname.startsWith(`${BASE_PATH}api/`)) return

  // The HTML shell isn't content-hashed like the built JS/CSS, so a stale
  // cached copy of it never "self-heals" once it's wrong (e.g. cached while
  // the server was misconfigured) -- always prefer the network for it, and
  // only fall back to cache when actually offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
          }
          return response
        })
        .catch(() => caches.match(request))
    )
    return
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
          }
          return response
        })
        .catch(() => cached)

      // Serve the cached copy instantly if we have one (fast + works
      // offline), while still fetching in the background to keep the
      // cache warm with the latest built assets.
      return cached || networkFetch
    })
  )
})

self.addEventListener('push', (event) => {
  let data = { title: 'Rizurf Attendance', body: '' }
  try {
    data = event.data ? event.data.json() : data
  } catch {
    // Payload wasn't JSON -- fall back to the default title/body above.
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: `${BASE_PATH}favicon.svg`,
      badge: `${BASE_PATH}favicon.svg`,
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    // includeUncontrolled matters here: a tab opened before this service
    // worker (re)activated isn't "controlled" by it yet, so without this it
    // would be invisible to matchAll() -- every notification tap would then
    // open ANOTHER new tab instead of focusing the one already open,
    // piling up duplicate tabs every time a reminder is tapped.
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => client.url.includes(self.location.origin))
      if (existing) return existing.focus()
      return self.clients.openWindow(BASE_PATH)
    })
  )
})
