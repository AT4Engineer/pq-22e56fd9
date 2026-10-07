/* Portfolio Tracker service worker: cache the app shell, always go network-first for data/ files.
   Scripts and styles are network-first too, so a new tab in the HTML cannot run an older router. */
const CACHE = "pq-shell-v13";
const SHELL = [
  "./",
  "index.html",
  "display.html",
  "assets/style.css?v=12",
  "assets/app.js?v=12",
  "assets/projection.js?v=12",
  "assets/display.css?v=11",
  "assets/display.js?v=11",
  "assets/favicon.svg",
  "assets/icons/icon-192.png",
  "assets/icons/icon-512.png",
  "assets/icons/apple-touch-icon.png",
  "manifest.webmanifest"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("pq-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function store(req, res) {
  if (res && res.ok) {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy));
  }
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Data (portfolio.json, charts, transactions, csv): network-first (never stale when online);
  // last good copy (stored without the cache-busting query) only when offline.
  if (url.pathname.indexOf("/data/") >= 0) {
    const key = url.origin + url.pathname;
    e.respondWith(
      fetch(req, { cache: "no-store" })
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
          return res;
        })
        .catch(() => caches.match(key).then((r) => r || Response.error()))
    );
    return;
  }

  // Page navigations: network-first so updates show up, cached shell offline.
  if (req.mode === "navigate") {
    const path = url.pathname;
    const shellKey = /display\.html$/.test(path) ? "display.html" : "index.html";
    e.respondWith(
      fetch(req)
        .then((res) => store(shellKey, res))
        .catch(() => caches.match(shellKey).then((r) => r || caches.match("index.html").then((r2) => r2 || caches.match("./"))))
    );
    return;
  }

  // Scripts and styles: network-first. A stale app.js still routes #guide to Stocks/Overview
  // while the fresh HTML already shows the Guide button.
  if (/\.(js|css)$/.test(url.pathname)) {
    e.respondWith(
      fetch(req).then((res) => store(req, res)).catch(() => caches.match(req).then((r) => r || Response.error()))
    );
    return;
  }

  // Other shell assets: stale-while-revalidate.
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((res) => store(req, res)).catch(() => cached);
      return cached || net;
    })
  );
});
