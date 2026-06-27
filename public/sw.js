/*
 * Minimal service worker — its only job is to make the app installable on
 * Android (Chrome requires a SW with a fetch handler). It is deliberately
 * NETWORK-ONLY with no caching, because the queue is live data and must never
 * be served stale. Offline simply isn't supported (the app needs the network).
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* pass through to the network */ });
