// Service worker: caches the app shell so it opens offline after the first visit.
const VERSION = 'ks-v2';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/main.js', 'js/engine.js', 'js/store.js', 'js/wav.js', 'js/zip.js', 'js/lyrics.js',
  'js/recorder-worklet.js', 'manifest.webmanifest', 'catalog.json', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png',
  'fonts/rubik-hebrew-400-normal.woff2', 'fonts/rubik-hebrew-500-normal.woff2', 'fonts/rubik-hebrew-700-normal.woff2',
  'fonts/rubik-latin-400-normal.woff2', 'fonts/rubik-latin-500-normal.woff2', 'fonts/rubik-latin-700-normal.woff2'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // network first (fresh updates), fall back to cache when offline
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
