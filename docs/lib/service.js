/**
 * 브라우저 서비스 계층 — 서버 없이(GitHub Pages) 동작하도록 예전 서버 API 역할을 브라우저 안에서 수행
 *  - 사전 데이터 불러오기: Cache API 에 보관 → 두 번째 방문부터 즉시·오프라인 동작
 *  - 검색 조립: 병음 분절 → 입력기 후보 순위 → 사전 → 한국어 뜻
 *  - 무료 API(키 불필요, 브라우저 직접 호출 가능): Google 입력 도구 / Google 번역 / MyMemory / Google TTS
 *  - 결과 캐시: IndexedDB
 *
 * 주의: github.io 주소는 같은 계정의 다른 앱(TSC NOTE)과 출처(origin)를 공유한다.
 *  - localStorage 는 TSC NOTE 의 학습 데이터가 쓰는 공간이라 캐시 용도로 쓰지 않는다.
 *  - 캐시 이름은 모두 'pinyin-search-' 로 시작하고, 지울 때도 이 접두어만 지운다.
 */
(function (root) {
'use strict';

const { Dictionary, HAN_RE, HANGUL_RE } = root.DictLib;
const { parseQuery } = root.PinyinLib;

const DATA_FILES = ['cedict', 'mmah', 'unihan', 'hun', 'kowikt', 'hsk', 'freq'];
const REQUIRED = new Set(['cedict', 'mmah', 'unihan', 'hun']);
const CACHE_PREFIX = 'pinyin-search-';
const DATA_CACHE_PREFIX = CACHE_PREFIX + 'data-';
const META_CACHE = CACHE_PREFIX + 'meta';
const DAY = 24 * 60 * 60 * 1000;

const abs = (p) => new URL(p, document.baseURI).href;

/* ---------------- IndexedDB 키-값 저장소 (TTL) ---------------- */
const kv = (() => {
  const mem = new Map();
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve) => {
      try {
        const req = indexedDB.open('pinyin-search', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null); // 사생활 보호 모드 등 → 메모리 캐시만 사용
      }
    });
    return dbp;
  }
  async function get(key, ttl) {
    let rec = mem.get(key);
    if (rec === undefined) {
      const db = await open();
      if (db) {
        rec = await new Promise((resolve) => {
          try {
            const r = db.transaction('kv').objectStore('kv').get(key);
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => resolve(undefined);
          } catch {
            resolve(undefined);
          }
        });
        if (rec !== undefined) mem.set(key, rec);
      }
    }
    if (!rec) return undefined;
    if (ttl && Date.now() - rec.t > ttl) return undefined;
    return rec.v;
  }
  async function set(key, v) {
    const rec = { t: Date.now(), v };
    mem.set(key, rec);
    const db = await open();
    if (!db) return;
    try {
      db.transaction('kv', 'readwrite').objectStore('kv').put(rec, key);
    } catch {
      /* 저장 실패는 무시 (캐시일 뿐) */
    }
  }
  return { get, set };
})();

/* ---------------- 네트워크 도우미 ---------------- */
class Breaker {
  constructor(name, failures = 4, coolMs = 3 * 60 * 1000) {
    this.name = name;
    this.max = failures;
    this.coolMs = coolMs;
    this.fails = 0;
    this.openUntil = 0;
    this.lastError = null;
  }
  get open() {
    return Date.now() < this.openUntil;
  }
  ok() {
    this.fails = 0;
    this.lastError = null;
  }
  fail(err) {
    this.lastError = String((err && err.message) || err);
    if (++this.fails >= this.max) {
      this.openUntil = Date.now() + this.coolMs;
      this.fails = 0;
      console.warn(`[${this.name}] 연속 실패 → 잠시 쉼: ${this.lastError}`);
    }
  }
}

function limiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

async function fetchJSON(url, timeout = 7000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const online = () => navigator.onLine !== false;
const hasCaches = () => typeof caches !== 'undefined' && root.isSecureContext !== false;

/* ---------------- 사전 데이터 불러오기 ---------------- */
const dict = new Dictionary();
let readyPromise = null;
let dataInfo = null;

async function getMeta() {
  const url = abs('data/meta.json');
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const meta = await res.clone().json();
    if (hasCaches()) {
      try {
        await (await caches.open(META_CACHE)).put(url, res);
      } catch {
        /* noop */
      }
    }
    return meta;
  } catch {
    if (hasCaches()) {
      try {
        const hit = await (await caches.open(META_CACHE)).match(url);
        if (hit) return await hit.json();
      } catch {
        /* noop */
      }
    }
    throw new Error('사전 데이터를 불러오지 못했어요. 처음 한 번은 인터넷 연결이 필요해요.');
  }
}

async function loadFile(cache, name, version) {
  const url = abs(`data/${name}.json`);
  let res = cache ? await cache.match(url) : null;
  if (!res) {
    res = await fetch(`${url}?v=${version}`);
    if (!res.ok) throw new Error(`${name}.json: HTTP ${res.status}`);
    if (cache) {
      try {
        await cache.put(url, res.clone());
      } catch {
        /* 저장 공간 부족 등 → 다음에 다시 받음 */
      }
    }
  }
  return res.json();
}

/** 사전 준비. onProgress(완료 수, 전체 수, 이름) */
function init(onProgress) {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    const t0 = performance.now();
    const meta = await getMeta();
    const cacheName = DATA_CACHE_PREFIX + meta.version;
    let cache = null;
    if (hasCaches()) {
      try {
        cache = await caches.open(cacheName);
      } catch {
        cache = null;
      }
    }
    const hadCache = cache ? !!(await cache.match(abs('data/cedict.json'))) : false;
    let done = 0;
    const total = DATA_FILES.length + 1;
    const step = (name) => onProgress && onProgress(++done, total, name, hadCache);
    const radicalsP = fetchJSON(abs('lib/radicals.json'), 20000).then((x) => (step('radicals'), x));
    const parts = await Promise.all(
      DATA_FILES.map((n) =>
        loadFile(cache, n, meta.version)
          .then((x) => (step(n), x))
          .catch((err) => {
            if (REQUIRED.has(n)) throw err;
            step(n);
            return null; // 선택 데이터는 없어도 동작
          }),
      ),
    );
    const data = Object.fromEntries(DATA_FILES.map((n, i) => [n, parts[i]]));
    dict.loadData({ ...data, radicals: await radicalsP });
    // 옛 버전 데이터 캐시 정리 — 이 앱의 접두어가 붙은 것만
    if (hasCaches()) {
      try {
        for (const k of await caches.keys()) if (k.startsWith(DATA_CACHE_PREFIX) && k !== cacheName) await caches.delete(k);
      } catch {
        /* noop */
      }
    }
    dataInfo = { version: meta.version, built: meta.built, ms: Math.round(performance.now() - t0), fromCache: hadCache };
    return dataInfo;
  })();
  readyPromise.catch(() => {
    readyPromise = null; // 다음 호출 때 다시 시도
  });
  return readyPromise;
}

/* ---------------- 무료 API ---------------- */
const ime = new Breaker('Google 입력 도구');
const gtx = new Breaker('Google 번역');
const mym = new Breaker('MyMemory', 3, 30 * 60 * 1000);
const net = limiter(4);
const recentMiss = new Map();

/** 병음 → 한자 후보 (사용 빈도순). 입력 전체를 덮는 후보만 사용 */
async function imeCandidates(text, num = 40) {
  if (!text) return [];
  const key = `ime:${text}|${num}`;
  const hit = await kv.get(key, 30 * DAY);
  if (hit) return hit;
  if (ime.open || !online()) return [];
  const url =
    'https://inputtools.google.com/request?' +
    new URLSearchParams({ text, itc: 'zh-t-i0-pinyin', num: String(num), cp: '0', cs: '1', ie: 'utf-8', oe: 'utf-8', app: 'demopage' });
  try {
    const data = await net(() => fetchJSON(url, 4000));
    if (data[0] !== 'SUCCESS') throw new Error('응답 상태 ' + data[0]);
    const item = data[1] && data[1][0];
    const words = (item && item[1]) || [];
    const matched = ((item && item[3]) || {}).matched_length || [];
    const out = words.filter((w, i) => matched[i] == null || matched[i] >= text.length);
    ime.ok();
    kv.set(key, out);
    return out;
  } catch (err) {
    ime.fail(err);
    return [];
  }
}

async function gtxRaw(text, sl, tl) {
  const p = new URLSearchParams({ client: 'gtx', sl, tl, q: text });
  p.append('dt', 't');
  p.append('dt', 'bd');
  return net(() => fetchJSON('https://translate.googleapis.com/translate_a/single?' + p, 6000));
}

const joinSegments = (data) =>
  ((data && data[0]) || [])
    .map((seg) => seg && seg[0])
    .filter(Boolean)
    .join('')
    .trim();

async function gtxMeaning(word) {
  if (gtx.open || !online()) return null;
  try {
    const data = await gtxRaw(word, 'zh-CN', 'ko');
    const text = joinSegments(data);
    const alts = Array.isArray(data[1])
      ? data[1].filter((b) => Array.isArray(b) && Array.isArray(b[1])).map((b) => ({ pos: b[0] || '', terms: b[1].slice(0, 8) }))
      : [];
    gtx.ok();
    if (!text || text === word) return alts.length ? { text: alts[0].terms[0], alts, provider: 'Google 번역', kind: 'mt' } : null;
    return { text, alts, provider: 'Google 번역', kind: 'mt' };
  } catch (err) {
    gtx.fail(err);
    return null;
  }
}

async function myMemoryMeaning(word) {
  if (mym.open || !online()) return null;
  try {
    const url = 'https://api.mymemory.translated.net/get?' + new URLSearchParams({ q: word, langpair: 'zh-CN|ko' });
    const data = await net(() => fetchJSON(url, 7000));
    if (data.quotaFinished) throw new Error('일일 할당량 소진');
    const text = String((data.responseData && data.responseData.translatedText) || '').trim();
    if (Number(data.responseStatus) !== 200 || !text || /MYMEMORY WARNING|INVALID/i.test(text)) {
      throw new Error(text || '응답 오류 ' + data.responseStatus);
    }
    mym.ok();
    return text === word ? null : { text, alts: [], provider: 'MyMemory', kind: 'mt' };
  } catch (err) {
    mym.fail(err);
    return null;
  }
}

async function machineMeaning(word) {
  const key = 'ko:' + word;
  const hit = await kv.get(key, 180 * DAY);
  if (hit) return hit;
  if ((recentMiss.get(word) || 0) > Date.now()) return null;
  const m = (await gtxMeaning(word)) || (await myMemoryMeaning(word));
  if (m) kv.set(key, m);
  else recentMiss.set(word, Date.now() + 10 * 60 * 1000);
  return m;
}

/** 한국어 → 중국어 (한글로 검색) */
async function koreanToChinese(text) {
  const key = 'rev:' + text;
  const hit = await kv.get(key, 90 * DAY);
  if (hit) return hit;
  if (gtx.open || !online()) return [];
  try {
    const data = await gtxRaw(text, 'ko', 'zh-CN');
    const out = [];
    const main = joinSegments(data);
    if (main) out.push(main);
    if (Array.isArray(data[1])) for (const b of data[1]) for (const t of (b && b[1]) || []) if (!out.includes(t)) out.push(t);
    gtx.ok();
    const words = out.map((s) => s.replace(/[。．.!！?？,，\s]+$/u, '')).filter(Boolean).slice(0, 12);
    kv.set(key, words);
    return words;
  } catch (err) {
    gtx.fail(err);
    return [];
  }
}

/* ---------------- 공개 함수 (화면에서 사용) ---------------- */
async function paginate(payload, groups, offset, limit) {
  const slice = groups.slice(offset, offset + limit).map((g) => dict.serializeGroup(g));
  await Promise.all(
    slice.map(async (s) => {
      // 1순위: 위키낱말사전(사전 뜻) · 2순위: 이미 받아 둔 자동 번역 — 없으면 화면이 meanings() 로 요청
      s.korean = dict.koreanDict(s.word) || (await kv.get('ko:' + s.word, 180 * DAY)) || null;
    }),
  );
  return { ...payload, total: groups.length, offset, groups: slice };
}

async function search(q, { offset = 0, limit = 20 } = {}) {
  await init();
  q = String(q || '').trim().slice(0, 80);
  if (!q) return { mode: 'pinyin', total: 0, offset: 0, groups: [] };

  if (HAN_RE.test(q)) return paginate({ mode: 'hanzi', query: q }, dict.searchHanzi(q).groups, offset, limit);

  if (HANGUL_RE.test(q)) {
    const translations = await koreanToChinese(q);
    const ids = [];
    const rank = new Map();
    translations.forEach((w, i) => {
      if (!rank.has(w)) rank.set(w, i);
      ids.push(...dict.exactIds(w));
    });
    const warnings = translations.length
      ? []
      : [online() ? '한국어 → 중국어 번역을 가져오지 못했어요' : '한국어로 찾기는 인터넷 연결이 필요해요'];
    return paginate({ mode: 'korean', query: q, translations, warnings }, dict.buildGroups(ids, { imeRank: rank }), offset, limit);
  }

  const parsed = parseQuery(q);
  const imeWords = parsed.imeText ? await imeCandidates(parsed.imeText) : [];
  const r = dict.searchPinyin(q, { imeWords });
  const warnings = [];
  if (!imeWords.length && parsed.imeText && (ime.lastError || !online())) {
    warnings.push(online() ? '입력기 순위를 못 받아 사전 빈도순으로 정렬했어요' : '오프라인이라 사전 빈도순으로 정렬했어요');
  }
  return paginate(
    { mode: 'pinyin', query: q, interpretations: r.interpretations, toneRelaxed: r.toneRelaxed, invalid: r.invalid, warnings },
    r.groups,
    offset,
    limit,
  );
}

async function meanings(words) {
  await init();
  const items = {};
  await Promise.all(
    [...new Set(words)].slice(0, 30).map(async (w) => {
      items[w] = dict.koreanDict(w) || (await machineMeaning(w));
    }),
  );
  return { items };
}

async function charInfo(c, trad) {
  await init();
  if (!HAN_RE.test(String(c || ''))) throw new Error('한자 한 글자가 필요해요');
  return dict.charInfo(c, { trad: trad || null });
}

function status() {
  return {
    ready: dict.loaded,
    data: dataInfo,
    counts: dict.loaded ? dict.stats() : null,
    online: online(),
    providers: {
      candidates: ime.open ? '사전 빈도순 (Google 입력 도구 일시 중지)' : 'Google 입력 도구 + 빈도순',
      korean: '위키낱말사전 → ' + (gtx.open ? (mym.open ? '자동 번역 일시 중지' : 'MyMemory') : 'Google 번역(무료)'),
    },
  };
}

/** 브라우저에 중국어 음성이 없을 때 쓰는 발음 주소 */
function ttsUrl(text) {
  return (
    'https://translate.googleapis.com/translate_tts?' +
    new URLSearchParams({ client: 'gtx', ie: 'UTF-8', tl: 'zh-CN', q: String(text).slice(0, 60) })
  );
}

root.PinyinService = { init, search, meanings, charInfo, status, ttsUrl, dict };
})(typeof self !== 'undefined' ? self : this);
