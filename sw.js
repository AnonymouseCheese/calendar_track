// Service worker: lets the app open offline.
// Network first (so code updates arrive quickly), saved copy when offline.
// It only ever caches the app's own files - never any notes.
var CACHE = 'ct-v6';
var SHELL = ['./', './index.html', './style.css?v=6', './app.js?v=6',
  './manifest.webmanifest', './icon-180.png', './icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); })
    .then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(networkFirst(req));
});

function withTimeout(p, ms) {
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
    p.then(function (r) { clearTimeout(t); resolve(r); }, function (err) { clearTimeout(t); reject(err); });
  });
}

function networkFirst(req) {
  return caches.open(CACHE).then(function (cache) {
    return withTimeout(fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }), 4000)
      .then(function (res) {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      })
      .catch(function (err) {
        return cache.match(req).then(function (hit) {
          if (hit) return hit;
          if (req.mode === 'navigate') return cache.match('./index.html');
          throw err;
        });
      });
  });
}
