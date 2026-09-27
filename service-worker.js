// BLOCK WARFARE service worker — created by Shayan
// Caches the app shell (client code, weapon models, icons) so PLAY OFFLINE
// keeps working without a connection, and so PWA Builder / browsers see a
// valid, installable PWA. Online multiplayer still needs a live connection
// to server/server.js — this worker never touches that WebSocket traffic.

const CACHE_NAME = 'block-warfare-v1';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './models/ak-47.glb',
  './models/hk-g28-sniper.glb',
  './models/colt-python.glb',
  './assets/icon.svg',
  './assets/icon.png',
  './assets/icon-192.png'
];

self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      return cache.addAll(APP_SHELL);
    }).then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k !== CACHE_NAME; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event){
  var req = event.request;
  if(req.method !== 'GET') return; // never intercept WebSocket/upgrade or POST traffic

  // three.js / GLTFLoader come from a CDN — network-first with a cache fallback,
  // so an update to those libraries is picked up when online but the game still
  // boots offline once they've been fetched at least once.
  if(req.url.indexOf('cdnjs.cloudflare.com') !== -1 || req.url.indexOf('jsdelivr.net') !== -1){
    event.respondWith(
      fetch(req).then(function(res){
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function(cache){ cache.put(req, copy); });
        return res;
      }).catch(function(){ return caches.match(req); })
    );
    return;
  }

  // app shell: cache-first for instant loads and offline play
  event.respondWith(
    caches.match(req).then(function(cached){
      return cached || fetch(req).then(function(res){
        var copy = res.clone();
        caches.open(CACHE_NAME).then(function(cache){ cache.put(req, copy); });
        return res;
      });
    })
  );
});
