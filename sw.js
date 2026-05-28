const CACHE = 'ai-stiri-v1';
const ASSETS = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Rețeaua primul — pentru știri proaspete
  if (e.request.url.includes('/rss') || e.request.url.includes('/ai')) {
    return; // Nu cache-uim RSS și AI
  }
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
