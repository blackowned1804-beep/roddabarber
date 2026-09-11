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
    data: { url: data.url || '/', apptId: data.apptId, apptToken: data.apptToken },
    requireInteraction: !!data.requireInteraction,
    renotify: !!data.renotify,
  };
  if (data.tag) opts.tag = data.tag;
  if (data.vibrate) opts.vibrate = data.vibrate;
  if (data.actions) opts.actions = data.actions; // Confirm / Cancel buttons
  e.waitUntil(self.registration.showNotification(data.title, opts));
});

// Tapping the notification (or a Confirm/Cancel button) is handled here.
self.addEventListener('notificationclick', (e) => {
  const d = e.notification.data || {};
  e.notification.close();

  // Appointment reminder action buttons — confirm/cancel without opening the app.
  if (e.action === 'confirm-appt' || e.action === 'cancel-appt') {
    const action = e.action === 'confirm-appt' ? 'confirm' : 'cancel';
    e.waitUntil((async () => {
      let ok = false;
      try {
        const r = await fetch('/api/appt/act', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: d.apptId, token: d.apptToken, action }),
        });
        ok = r.ok;
      } catch (_) {}
      await self.registration.showNotification(
        ok ? (action === 'confirm' ? '✅ Appointment confirmed' : '✕ Appointment cancelled') : 'Could not update',
        { body: ok ? 'Done.' : 'Open the app to try again.', icon: '/img/icon-192.png', badge: '/img/icon-192.png', tag: 'appt-result', data: { url: '/barber' } }
      );
    })());
    return;
  }

  // Plain tap → open/focus the app.
  const url = d.url || '/';
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
