const CACHE_NAME = 'richly-v9';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// Always network first, never serve stale
self.addEventListener('fetch', event => {
  event.respondWith(fetch(event.request));
});
