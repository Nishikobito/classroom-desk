'use strict';
// Service Worker: 通常は常にサーバーから最新を取り(更新がすぐ反映される)、オフラインのときだけ保存した分を使う。
const CACHE = 'classroom-desk-static';
const ASSETS = [
  "./",
  "./app.js",
  "./assets/classroom-logo-dark.svg",
  "./assets/classroom-logo.png",
  "./backend.js",
  "./classroom-core.js",
  "./icons/favicon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./index.html",
  "./logic.js",
  "./manifest.webmanifest",
  "./style.css"
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // Googleとの通信には関わらない
  if (url.pathname.endsWith('/version.json')) return; // 更新の確認は、常にネットワークから
  e.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache' }); // 毎回サーバーに確認する
      if (res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
      return res;
    } catch {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') { const idx = await caches.match('./index.html'); if (idx) return idx; }
      return Response.error();
    }
  })());
});
