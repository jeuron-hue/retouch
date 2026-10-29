// retouch service worker.
//
// What it does, in plain words:
// 1. On install it downloads the app shell (the page, manifest, icons, fonts)
//    into a cache, so the app opens with no network at all. MediaPipe and its
//    models (about 34 MB) go in a second cache named by their pinned version, so
//    an app release does not download them again; only a new pin does. Mediabunny
//    (the video reader and writer, 0.7 MB) has a third cache, named the same way.
// 2. On every request for one of our own files it answers from that cache first.
//    It never touches any other website: requests to other origins are ignored.
// 3. It receives photos and videos shared from Android's share sheet (the
//    manifest's share_target). The shared file is parked in a separate cache, then
//    the app is opened and picks it up from there. Nothing is uploaded anywhere.
//
// Release rule: bump CACHE_VERSION with every release. It must match APP_VERSION
// in retouch.html (retouch_checks.cjs fails if they differ). A new version makes
// the browser install a fresh worker, and the app shows "Update available".

const CACHE_VERSION = '0.8.0';
const CACHE = 'retouch-v' + CACHE_VERSION;
const SHARE_CACHE = 'retouch-share';
const SHARE_KEY = 'shared-image';
// Must name the @mediapipe/tasks-vision version in the retouch.html build notes
// (retouch_checks.cjs enforces it). Change it whenever a file below changes.
const VENDOR_CACHE = 'retouch-mediapipe-0.10.35';
// Must name the mediabunny version in the build notes, the same way.
const VIDEO_CACHE = 'retouch-mediabunny-1.61.6';

const SHELL = [
  './',
  'index.html',
  'retouch.html',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-180.png',
  'vendor/fonts/barlow-semi-condensed-latin-400-normal.woff2',
  'vendor/fonts/barlow-semi-condensed-latin-600-normal.woff2',
  'vendor/fonts/ibm-plex-mono-latin-400-normal.woff2',
  'vendor/fonts/ibm-plex-mono-latin-500-normal.woff2',
  'vendor/fonts/source-sans-3-latin-600-normal.woff2',
  'vendor/fonts/playfair-display-latin-700-normal.woff2',
  'vendor/fonts/bebas-neue-latin-400-normal.woff2',
  'vendor/fonts/caveat-latin-600-normal.woff2',
];

const VENDOR = [
  'vendor/mediapipe/vision_bundle.js',
  'vendor/mediapipe/vision_wasm_internal.js',
  'vendor/mediapipe/vision_wasm_internal.wasm',
  'vendor/mediapipe/selfie_multiclass_256x256.tflite',
  'vendor/mediapipe/magic_touch.tflite',
];

const VIDEO_VENDOR = [
  'vendor/mediabunny/mediabunny.js',
];

// Fill a pinned cache with whatever it is missing (a new pin starts empty).
async function fillPinned(name, list) {
  const cache = await caches.open(name);
  const have = await Promise.all(list.map((u) => cache.match(u)));
  const missing = list.filter((u, i) => !have[i]);
  await cache.addAll(missing.map((u) => new Request(u, { cache: 'reload' })));
}

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the browser's HTTP cache so a new release never
  // caches a stale copy of a file.
  event.waitUntil(Promise.all([
    caches.open(CACHE).then((cache) =>
      cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))
    ),
    fillPinned(VENDOR_CACHE, VENDOR),
    fillPinned(VIDEO_CACHE, VIDEO_VENDOR),
  ]));
  // No skipWaiting here: an updated worker waits until the user taps
  // "Reload" in the app, so an edit in progress is never swapped out.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => (k.startsWith('retouch-v') && k !== CACHE) || (k.startsWith('retouch-mediapipe-') && k !== VENDOR_CACHE) ||
        (k.startsWith('retouch-mediabunny-') && k !== VIDEO_CACHE))
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never handle other origins

  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET') return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Navigations may carry a query (?shared=1); the cached page is the same file.
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' }) ||
      await (await caches.open(VENDOR_CACHE)).match(req) ||
      await (await caches.open(VIDEO_CACHE)).match(req);
    if (hit) return hit;
    return fetch(req);
  })());
});

async function receiveShare(req) {
  const scope = self.registration.scope;
  try {
    const form = await req.formData();
    // 'media' is the field name from 0.8.0; an installed app whose Android copy of
    // the manifest is older still sends 'image', so both are read.
    const file = [...form.getAll('media'), ...form.getAll('image')].find((f) => f && typeof f !== 'string');
    if (file) {
      const cache = await caches.open(SHARE_CACHE);
      await cache.put(new URL(SHARE_KEY, scope).href, new Response(file, {
        headers: {
          'content-type': file.type || 'application/octet-stream',
          'x-filename': encodeURIComponent(file.name || 'shared'),
        },
      }));
    }
    return Response.redirect(new URL('retouch.html?shared=1', scope).href, 303);
  } catch (e) {
    return Response.redirect(new URL('retouch.html?shared=0', scope).href, 303);
  }
}
