// アプリ本体のファイルをキャッシュして、オフラインでも起動できるようにする。
// 予定のデータ（Google API）はここでは扱わない（store.js がブラウザ内に保存する）。
// ファイルを更新したら VERSION を上げる。
const VERSION = 'v1';
const CACHE = `our-calendar-${VERSION}`;
const FILES = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'auth.js',
  'api.js',
  'store.js',
  'dates.js',
  'config.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 同じサイトのファイルは「ネット優先、つながらなければキャッシュ」。
// 更新がすぐ反映され、オフラインでも開ける。
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request, { ignoreSearch: true })
        .then((hit) => hit || (request.mode === 'navigate' ? caches.match('./') : undefined))
        .then((hit) => hit || Response.error())),
  );
});
