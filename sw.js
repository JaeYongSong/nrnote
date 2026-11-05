/* NR 노트 service worker: works offline.
   - app shell: cache-first, refreshed when VER changes
   - manifest.json: network-first (so new note versions are seen), cache fallback
   - data/notes.bin?v=<version> and img/<hash>.bin: cache-first (their names change when content changes) */
const VER = '772ab9f50d4f-c7831';
const SHELL = 'nr-shell-' + VER, DATA = 'nr-data';
const SHELL_FILES = ['./', 'index.html', 'app.css?v=' + VER, 'app.js?v=' + VER, 'manifest.webmanifest', 'icon-180.png', 'icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('nr-shell-') && k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== 'GET') return;
  const p = u.pathname;
  if (p.endsWith('/manifest.json')) {
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(DATA).then(x => x.put('manifest.json', c)); return r; })
      .catch(() => caches.open(DATA).then(x => x.match('manifest.json'))));
    return;
  }
  if (p.includes('/data/') || p.includes('/img/')) {
    e.respondWith(caches.open(DATA).then(async c => {
      const hit = await c.match(e.request); if (hit) return hit;
      const r = await fetch(e.request); if (r.ok) c.put(e.request, r.clone());
      if (p.includes('/data/')) {  // keep only the newest notes bundle
        (await c.keys()).filter(k => k.url.includes('/data/') && k.url !== e.request.url).forEach(k => c.delete(k));
      }
      return r;
    }));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: p.endsWith('/') || p.endsWith('index.html') }).then(hit => hit || fetch(e.request)));
});
