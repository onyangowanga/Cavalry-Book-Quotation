const CACHE_NAME = 'cavalry-quote-builder-v11';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './favicon/favicon.svg',
  './favicon/favicon-96x96.png',
  './favicon/favicon.ico',
  './favicon/apple-touch-icon.png',
  './favicon/site.webmanifest',
  './favicon/web-app-manifest-192x192.png',
  './favicon/web-app-manifest-512x512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
  );
  self.clients.claim();
});

// Network-first for API calls, cache-first for app shell assets.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      return response;
    }).catch(() => cached))
  );
});
