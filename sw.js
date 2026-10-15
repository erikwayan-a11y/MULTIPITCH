/* Offline support: app shell is cached; map tiles and topo images you have viewed are kept for use without signal. */
const SHELL = 'shell-v2';
const TILES = 'tiles-v1';
const MAX_TILES = 4000;
const SHELL_FILES = ['./', 'index.html', 'app.js', 'data.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== TILES).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

let writes = 0;
async function trim() {
  const c = await caches.open(TILES); const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isTile = url.hostname === 'wmts.geo.admin.ch' || url.hostname.endsWith('wikimedia.org') || (req.destination === 'image' && url.origin !== location.origin);
  if (isTile) {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') { c.put(req, res.clone()); if (++writes % 200 === 0) trim(); }
        return res;
      } catch (err) { return hit || Response.error(); }
    }));
    return;
  }
  if (url.origin === location.origin || url.hostname === 'unpkg.com') {
    // network first for the app itself (so updates arrive), cache as fallback offline
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })));
  }
});
