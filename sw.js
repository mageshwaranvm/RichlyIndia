// Richly offline shell and network-first data requests.
const CACHE = 'richly-shell-v6';
const SHELL = ['./','./index.html','./manifest.json','./icon-192.png','./icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).catch(()=>{}));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(keys.filter(k=>k.startsWith('richly-')&&k!==CACHE).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const req=event.request;
  if(req.method!=='GET') return;
  const url=new URL(req.url);
  // App shell: network first, cached app shell when offline.
  if(url.origin===self.location.origin && (url.pathname.endsWith('.html')||url.pathname.endsWith('/')||url.pathname===new URL('./',self.registration.scope).pathname)){
    event.respondWith((async()=>{
      try{
        const fresh=await fetch(req);
        if(fresh&&fresh.ok){const c=await caches.open(CACHE);c.put(req,fresh.clone());}
        return fresh;
      }catch(err){
        return (await caches.match(req))||(await caches.match('./index.html'))||Response.error();
      }
    })());
    return;
  }
  // Same-origin static files and successful CDN GETs are cached after first use.
  event.respondWith((async()=>{
    try{
      const fresh=await fetch(req);
      if(fresh&&fresh.ok&&(url.origin===self.location.origin||url.hostname.includes('cdnjs.cloudflare.com')||url.hostname.includes('fonts.googleapis.com')||url.hostname.includes('fonts.gstatic.com'))){
        const c=await caches.open(CACHE);c.put(req,fresh.clone());
      }
      return fresh;
    }catch(err){return (await caches.match(req))||Response.error();}
  })());
});
