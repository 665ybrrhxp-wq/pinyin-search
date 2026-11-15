/* 병음 사전 서비스 워커
 * - 화면 파일(같은 출처): 네트워크 우선 → 실패하면 캐시. 온라인이면 재배포가 바로 반영되고, 오프라인이면 마지막 사본으로 열림.
 * - 사전 데이터(data/): 페이지(lib/service.js)가 Cache API 로 직접 관리하므로 여기서는 관여하지 않음.
 * - 획순 데이터·웹폰트(CDN): 캐시 우선.
 * - Google·MyMemory API: 관여하지 않음(항상 네트워크).
 *
 * 같은 github.io 주소의 다른 앱(TSC NOTE)과 캐시 저장소를 함께 쓰므로,
 * 캐시는 'pinyin-search-' 로 시작하는 이름만 만들고 지운다. 다른 이름의 캐시는 절대 건드리지 않는다.
 */
const PREFIX = 'pinyin-search-';
const SHELL = PREFIX + 'shell-v2';
const RUNTIME = PREFIX + 'runtime-v1';
const OWNED = [SHELL, RUNTIME]; // 이 워커가 관리하는 캐시 (data-*, meta 는 페이지 담당)

const SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './lib/pinyin.js',
  './lib/dict.js',
  './lib/service.js',
  './lib/radicals.json',
  './vendor/hanzi-writer.min.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
];

const CDN_HOSTS = new Set(['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com']);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => (k.startsWith(PREFIX + 'shell-') || k.startsWith(PREFIX + 'runtime-')) && !OWNED.includes(k))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(req) {
  try {
    // GitHub Pages 는 10분 브라우저 캐시를 걸어 두므로, 항상 서버에 확인(바뀐 게 없으면 304라 가벼움) → 재배포가 바로 반영
    const res = await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(SHELL).then((cache) => cache.put(req, copy));
    }
    return res;
  } catch (err) {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    if (req.mode === 'navigate') {
      const page = (await caches.match('./index.html')) || (await caches.match('./'));
      if (page) return page;
    }
    return Response.error();
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) {
    const copy = res.clone();
    caches.open(RUNTIME).then((cache) => cache.put(req, copy));
  }
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.includes('/data/')) return; // 사전 데이터는 페이지가 직접 캐시
    event.respondWith(networkFirst(req));
  } else if (CDN_HOSTS.has(url.hostname)) {
    event.respondWith(cacheFirst(req));
  }
  // 그 밖의 외부 요청(Google·MyMemory API 등)은 브라우저 기본 동작
});
