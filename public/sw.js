/*
 * Minimal service worker — its only job is to make the app installable on
 * Android (Chrome requires a SW with a fetch handler). It is deliberately
 * NETWORK-ONLY with no caching, because the queue is live data and must never
 * be served stale. Offline simply isn't supported (the app needs the network).
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* pass through to the network */ });

// Show push notifications. Barber "new client" pushes set requireInteraction +
// vibrate so they stay on screen and buzz hard until Rod taps them.
self.addEventListener('push', (e) => {
  let data = { title: 'Rod da Barber', body: '', url: '/' };
  try { data = Object.assign(data, e.data.json()); } catch (_) {}
  const opts = {
    body: data.body,
    icon: '/img/icon-192.png',
    badge: '/img/icon-192.png',
    data: { url: data.url || '/' },
    requireInteraction: !!data.requireInteraction,
    renotify: !!data.renotify,
  };
  if (data.tag) opts.tag = data.tag;
  if (data.vibrate) opts.vibrate = data.vibrate;
  e.waitUntil(self.registration.showNotification(data.title, opts));
});

// Tapping the notification opens (or focuses) the app.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
