/* agent-office — service worker.
   Guarda só a "casca" do app (HTML, JS, CSS) para a janela instalada abrir
   mesmo com o servidor fora do ar. Nunca intercepta /api, /events nem /ws:
   dados de sessão não passam pelo cache.
   VERSION e PRECACHE são preenchidos no build (sw-plugin.ts). */
const VERSION = '__SW_VERSION__';
const PRECACHE = ['__SW_PRECACHE__'];
const CACHE = `agent-office-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('agent-office-') && k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

/** Rede primeiro; sem rede, o que estiver guardado. */
async function networkFirst(request, key = request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(key, response.clone());
    return response;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}

/** Arquivos com hash no nome nunca mudam: cache primeiro. */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (path.startsWith('/api/') || path.startsWith('/events') || path.startsWith('/ws')) return;
  if (request.mode === 'navigate') event.respondWith(networkFirst(request, '/'));
  else if (path.startsWith('/assets/')) event.respondWith(cacheFirst(request));
  else event.respondWith(networkFirst(request));
});
