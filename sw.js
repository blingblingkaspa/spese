/* Offline support: the site's own files are cached; Google sign-in, Drive and price calls always go to the network. */
var VERSION = "spese-v4";
var FILES = [
  "./", "index.html", "privacy.html", "config.js", "manifest.webmanifest",
  "js/core.js", "js/drive.js", "js/charts.js", "js/patrimonio.js", "js/app.js",
  "vendor/sql-wasm.js", "vendor/sql-wasm.wasm", "vendor/fonts/mona-sans.woff2",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return; // Google: straight to the network
  // Network first so a new version shows up at once; the cache answers when offline
  e.respondWith(fetch(e.request).then(function (res) {
    if (res && res.ok) { var copy = res.clone(); caches.open(VERSION).then(function (c) { c.put(e.request, copy); }); }
    return res;
  }).catch(function () {
    return caches.match(e.request, { ignoreSearch: true }).then(function (r) { return r || caches.match("index.html"); });
  }));
});
