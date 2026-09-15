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

// Clock-in/out reminders, sent by api/cron-reminders.php. The payload is
// always our own {title, body} JSON -- nothing here executes anything from
// it, just displays it.
self.addEventListener('push', (event) => {
  let data = { title: 'Rizurf Attendance', body: 'Reminder from Rizurf Attendance.' }
  try {
    if (event.data) data = { ...data, ...event.data.json() }
  } catch { /* a non-JSON push body just falls back to the default text */ }

  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: './favicon.svg',
    badge: './favicon.svg',
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    // includeUncontrolled -- an already-open tab from before this worker
    // took control of it is otherwise invisible here, and every tap would
    // open a new tab instead of focusing the existing one.
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => new URL(client.url).origin === self.location.origin)
      if (existing) return existing.focus()
      return self.clients.openWindow('./')
    })
  )
})
