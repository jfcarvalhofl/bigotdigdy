// gerado por build-sw.py
const VERSION = '8b43983c40';
const CACHE = 'pspp-' + VERSION;
const RUNTIME = 'pspp-runtime';
const PRECACHE = [
"./",
"app.css",
"icons/icon-192.png",
"icons/icon-512.png",
"index.html",
"js/app.js",
"js/common.js",
"js/db.js",
"js/finish.js",
"js/library.js",
"js/pdf.js",
"js/pdfexport.js",
"js/reader.js",
"manifest.webmanifest",
"vendor/fflate.js",
"vendor/pdf-lib.esm.min.js",
"vendor/pdf.min.mjs",
"vendor/pdf.worker.min.mjs",
"vendor/standard_fonts/FoxitDingbats.pfb",
"vendor/standard_fonts/FoxitFixed.pfb",
"vendor/standard_fonts/FoxitFixedBold.pfb",
"vendor/standard_fonts/FoxitFixedBoldItalic.pfb",
"vendor/standard_fonts/FoxitFixedItalic.pfb",
"vendor/standard_fonts/FoxitSerif.pfb",
"vendor/standard_fonts/FoxitSerifBold.pfb",
"vendor/standard_fonts/FoxitSerifBoldItalic.pfb",
"vendor/standard_fonts/FoxitSerifItalic.pfb",
"vendor/standard_fonts/FoxitSymbol.pfb",
"vendor/standard_fonts/LiberationSans-Bold.ttf",
"vendor/standard_fonts/LiberationSans-BoldItalic.ttf",
"vendor/standard_fonts/LiberationSans-Italic.ttf",
"vendor/standard_fonts/LiberationSans-Regular.ttf",
"vendor/wasm/jbig2.wasm",
"vendor/wasm/jbig2_nowasm_fallback.js",
"vendor/wasm/openjpeg.wasm",
"vendor/wasm/openjpeg_nowasm_fallback.js",
"vendor/wasm/qcms_bg.wasm"
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== RUNTIME).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const hit = await caches.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    if (e.request.mode === 'navigate') { const idx = await caches.match('./'); if (idx) return idx; }
    const res = await fetch(e.request);
    if (res.ok && url.pathname.includes('/vendor/cmaps/')) (await caches.open(RUNTIME)).put(e.request, res.clone());
    return res;
  })());
});
