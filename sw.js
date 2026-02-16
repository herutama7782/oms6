

const CACHE_NAME = 'pos-mobile-cache-v17';

// File-file ini WAJIB ada agar aplikasi bisa jalan offline.
// Jika salah satu gagal, install SW gagal (standar PWA).
const CRITICAL_URLS = [
  '/',
  '/index.html',
  '/index.css',
  '/index.js',
  '/manifest.json',
  '/metadata.json',
  '/src/audio.js',
  '/src/cart.js',
  '/src/contact.js',
  '/src/db.js',
  '/src/peripherals.js',
  '/src/product.js',
  '/src/report.js',
  '/src/settings.js',
  '/src/sync.js',
  '/src/ui.js',
  '/src/html/pages.html',
  '/src/html/modals.html',
  '/src/lib/logo.png'
];

// File-file eksternal (CDN). Kita akan mencoba men-cache ini,
// tapi jika gagal (misal internet putus), aplikasi TETAP TERINSTALL
// dan bisa jalan offline (mungkin tanpa ikon/font, tapi fungsi jalan).
const OPTIONAL_URLS = [
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-solid-900.woff2',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-regular-400.woff2',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-brands-400.woff2',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-solid-900.ttf',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-regular-400.ttf',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-brands-400.ttf',
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js',
  'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  // Firebase Compat CDNs
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      // 1. Install Critical Assets (Wajib)
      await cache.addAll(CRITICAL_URLS);

      // 2. Install Optional Assets (Best Effort)
      // Kita loop satu per satu agar jika satu gagal, yang lain tetap tersimpan
      for (const url of OPTIONAL_URLS) {
        try {
          // Gunakan no-cors untuk resource lintas domain yang mungkin bermasalah
          await cache.add(new Request(url, { mode: 'no-cors' })); 
        } catch (e) {
          console.warn(`[SW] Gagal cache optional: ${url}`, e);
        }
      }
    })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  // Strategi: Network First untuk HTML (agar selalu update jika online),
  // Fallback ke Cache jika offline.
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const networkResponse = await fetch(event.request);
        return networkResponse;
      } catch (error) {
        console.warn('[SW] Offline navigation fallback:', event.request.url);
        // Jika offline/gagal, ambil dari cache
        let cachedResponse = await caches.match('/index.html');
        if (!cachedResponse) {
             // Fallback coba root path jika index.html spesifik tidak ada
             cachedResponse = await caches.match('/');
        }
        
        if (cachedResponse) {
            return cachedResponse;
        }
        
        // Jika benar-benar tidak ada di cache, biarkan error (user harus online untuk install pertama kali)
        throw error;
      }
    })());
    return;
  }
  
  // Strategi: Cache First untuk aset statis (JS, CSS, Images, Fonts)
  event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cachedResponse = await cache.match(event.request);
      
      if (cachedResponse) {
          return cachedResponse;
      }
      
      try {
          const networkResponse = await fetch(event.request);
          // Cache resource baru yang berhasil di-fetch
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
              cache.put(event.request, networkResponse.clone());
          }
          return networkResponse;
      } catch (error) {
          // Jika fetch gagal (offline) dan tidak ada di cache, biarkan browser handle (atau return 404)
          // Untuk font/gambar opsional, ini mencegah error fatal
          return new Response('', { status: 408, statusText: 'Request Timeout' });
      }
  })());
});
