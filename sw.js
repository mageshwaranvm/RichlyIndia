// Smart service worker - NEVER caches HTML
// Only caches static assets like icons
const CACHE = 'richly-static-v1';
const STATIC = ['icon-192.png', 'icon-512.png', 'manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  
  // NEVER cache HTML - always fetch fresh from network
  if(url.pathname.endsWith('.html') || url.pathname.endsWith('/') || url.pathname === '/richly/') {
    e.respondWith(fetch(e.request));
    return;
  }
  
  // For static assets - cache first
  if(STATIC.some(s => url.pathname.endsWith(s))){
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request))
    );
    return;
  }
  
  // Everything else - network first
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
