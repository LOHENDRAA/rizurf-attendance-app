const CACHE_NAME = 'rizurf-attendance-v4'
// Only genuinely static, always-200 files -- not '/' or '/index.html'. In
// production '/' redirects to the gateway for anyone without a session
// (a non-cacheable cross-origin response), and the build moves index.html
// to app.shell.html so that path 404s outright. cache.addAll() is all-or-
// nothing, so either one crashed install entirely.
const APP_SHELL = ['./manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {}))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))))
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const requestIsPage = event.request.mode === 'navigate' || event.request.headers.get('accept')?.includes('text/html')
  if (requestIsPage) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)))
    return
  }
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)))
})
