const CACHE_NAME = 'insaengjjim-v28';
const SHELL = [
  './', './index.html', './style.css', './app.js', './manifest.json',
  './icon.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME && k !== 'share-inbox').map(k => caches.delete(k))))
  );
  self.clients.claim();
});

/* Android "공유 → 인생찜": the share arrives as a POST. Park a shared image in a cache, then
   redirect to the app with the shared text/link in the query string. */
async function handleShare(request) {
  const form = await request.formData();
  const params = new URLSearchParams();
  ['title', 'text', 'url'].forEach(k => { const v = form.get(k); if (v) params.set(k, String(v)); });
  const file = form.get('photo');
  if (file && typeof file === 'object' && file.size) {
    const cache = await caches.open('share-inbox');
    await cache.put(new URL('share-photo', self.registration.scope).href, new Response(file, { headers: { 'Content-Type': file.type || 'image/jpeg' } }));
    params.set('photo', '1');
  }
  return Response.redirect(new URL('./?' + params.toString(), self.registration.scope).href, 303);
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.searchParams.has('share')) {
    e.respondWith(handleShare(e.request));
    return;
  }
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
