// Rx Cloude Service Worker
// Bump this tag on every release so clients drop stale cached assets.
// Current application version: 1.3.0
// const CACHE_NAME = 'rx-cloude-v6';
// const CACHE_NAME = 'rx-cloude-v7';
// const CACHE_NAME = 'rx-cloude-v8';
const CACHE_NAME = 'rx-cloude-v9';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/features.js',
  '/app.js',
  // '/style.css',  (not used by any page)
  '/mobile.css',
  '/mobile.js',
  '/dialogs.js',
  '/vendor/sweetalert2.all.min.js',
  '/manifest.json',
  '/app_icon.png',
  '/vendor/tailwind-browser.js',
  '/vendor/lucide.js'
];

// A single failing asset must not abort the whole install.
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(STATIC_ASSETS.map((url) =>
        cache.add(url).catch(() => console.warn('[sw] could not precache', url)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Only handle same-origin GET requests. API calls, uploads, WebSocket
  // upgrades and browser-extension requests must go straight to the network.
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  e.respondWith(
    fetch(e.request)
      .then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
          const resClone = response.clone();
          // Never let a failed cache write surface as an unhandled rejection.
          caches.open(CACHE_NAME)
            .then((cache) => cache.put(e.request, resClone))
            .catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(e.request).then((cached) => {
        if (cached) return cached;
        // Only navigations may fall back to the app shell. Returning index.html
        // for a script or stylesheet is what produced
        // "Uncaught SyntaxError: Unexpected token '<'" at features.js:1 when
        // the server was briefly unavailable.
        if (e.request.mode === 'navigate') return caches.match('/index.html');
        return Response.error();
      }))
  );
});
