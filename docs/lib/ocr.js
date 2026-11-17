/**
 * 사진 속 한자 인식 (브라우저 안에서 Tesseract.js 로 처리 — 사진은 밖으로 나가지 않음)
 *  - 📷 를 처음 누를 때만 인식 엔진·중국어 데이터(약 5MB)를 CDN 에서 받음 → 이후 기기에 저장되어 오프라인 동작
 *  - 사진 위를 끌어서 인식할 부분만 고를 수 있음 (가장자리 글자 오인식이 줄어듦)
 *  - 결과는 바로 검색하지 않고 고칠 수 있게 보여 준 뒤 검색
 * app.js 의 search() 를 사용하므로 app.js 다음에 불러옴.
 */
(function () {
'use strict';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const MAX_SIDE = 1800; // 인식에 넘길 이미지의 긴 변 (휴대폰 사진은 이 크기로 줄임)
const KEEP_RE = /[㐀-鿿豈-﫿，。！？、；：“”‘’《》（）·…—]/u;
const HAN_RE = /[㐀-鿿豈-﫿]/u;

const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const st = {
  img: null, // 미리보기 <img>
  crop: null, // { x, y, w, h } (원본 픽셀)
  drag: null,
  worker: null,
  workerLangs: '',
  busy: false,
};

/* ---------- 엔진 불러오기 ---------- */
let scriptPromise = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = TESSERACT_URL;
      s.onload = () => resolve(window.Tesseract);
      s.onerror = () => {
        scriptPromise = null;
        reject(new Error('인식 엔진을 불러오지 못했어요 (처음 한 번은 인터넷 연결이 필요해요)'));
      };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

const STATUS_KO = {
  'loading tesseract core': '인식 엔진 불러오는 중',
  'initializing tesseract': '인식 엔진 준비 중',
  'loading language traineddata': '언어 데이터 불러오는 중',
  'loading language traineddata (from cache)': '언어 데이터 여는 중',
  'initializing api': '준비 중',
  'recognizing text': '글자 인식 중',
};

async function getWorker(langs, onStatus) {
  if (st.worker && st.workerLangs === langs) return st.worker;
  if (st.worker) {
    await st.worker.terminate().catch(() => {});
    st.worker = null;
  }
  const T = await loadTesseract();
  st.worker = await T.createWorker(langs, 1, {
    logger: (m) => onStatus(STATUS_KO[m.status] || m.status, m.progress),
  });
  st.workerLangs = langs;
  return st.worker;
}

/* ---------- 결과 정리 ---------- */
/** 줄마다 한자·중국어 문장부호만 남김 (Tesseract 가 넣는 글자 사이 공백, 한글, 잡기호 제거) */
function cleanText(text) {
  const FULL = { '?': '？', '!': '！', ',': '，', ';': '；', ':': '：', '(': '（', ')': '）' };
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/[?!,;:()]/g, (c) => FULL[c]))
    .map((line) => [...line].filter((c) => KEEP_RE.test(c)).join(''))
    .map((line) => line.replace(/^[，。！？、；：”’》）·…—]+/u, '')) // 줄 앞의 떨어진 문장부호
    .filter((line) => HAN_RE.test(line));
}

/* ---------- 이미지 준비 ---------- */
function regionCanvas() {
  const img = st.img;
  const c = st.crop || { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
  // 큰 사진만 줄이고 키우지는 않음 — 실험상 확대·밝기 보정·여백은 정확도를 높이지 못했음
  const scale = Math.min(1, MAX_SIDE / Math.max(c.w, c.h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(c.w * scale));
  canvas.height = Math.max(1, Math.round(c.h * scale));
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, c.x, c.y, c.w, c.h, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/* ---------- 화면 ---------- */
function openSheet() {
  $('#ocr').hidden = false;
  $('#ocr-scrim').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeSheet() {
  $('#ocr').hidden = true;
  $('#ocr-scrim').hidden = true;
  document.body.style.overflow = '';
  if (st.img && st.img.src.startsWith('blob:')) URL.revokeObjectURL(st.img.src);
}

function setStatus(html) {
  $('#ocr-status').innerHTML = html;
}

function render(file) {
  const url = URL.createObjectURL(file);
  $('#ocr-body').innerHTML = `
    <p class="legend">인식할 부분을 손가락(마우스)으로 끌어서 고르세요. 고르지 않으면 사진 전체를 읽어요.</p>
    <div class="ocr-stage" id="ocr-stage">
      <img id="ocr-img" alt="고른 사진" draggable="false">
      <div class="ocr-rect" id="ocr-rect" hidden></div>
    </div>
    <div class="ocr-opts">
      <label><input type="checkbox" id="ocr-kor"> 한글이 섞인 페이지 (교재 등)</label>
      <button type="button" class="chip" id="ocr-reset">전체 선택</button>
    </div>
    <button type="button" class="search-btn ocr-go" id="ocr-go">인식하기</button>
    <p class="status" id="ocr-status" aria-live="polite"></p>
    <div id="ocr-result"></div>`;
  st.crop = null;
  st.img = $('#ocr-img');
  st.img.src = url;
  bindCrop();
}

function bindCrop() {
  const stage = $('#ocr-stage');
  const rectEl = $('#ocr-rect');
  const pos = (e) => {
    const r = st.img.getBoundingClientRect();
    return {
      x: Math.min(Math.max(e.clientX - r.left, 0), r.width),
      y: Math.min(Math.max(e.clientY - r.top, 0), r.height),
      r,
    };
  };
  stage.addEventListener('pointerdown', (e) => {
    if (!st.img.naturalWidth) return;
    stage.setPointerCapture(e.pointerId);
    st.drag = pos(e);
    e.preventDefault();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!st.drag) return;
    const p = pos(e);
    const x = Math.min(st.drag.x, p.x);
    const y = Math.min(st.drag.y, p.y);
    const w = Math.abs(p.x - st.drag.x);
    const h = Math.abs(p.y - st.drag.y);
    Object.assign(rectEl.style, { left: `${x + st.img.offsetLeft}px`, top: `${y + st.img.offsetTop}px`, width: `${w}px`, height: `${h}px` });
    rectEl.hidden = false;
    const k = st.img.naturalWidth / p.r.width;
    st.crop = w > 8 && h > 8 ? { x: x * k, y: y * k, w: w * k, h: h * k } : null;
  });
  const end = () => {
    st.drag = null;
    if (!st.crop) rectEl.hidden = true;
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
}

async function recognize() {
  if (st.busy || !st.img || !st.img.naturalWidth) return;
  st.busy = true;
  const btn = $('#ocr-go');
  btn.disabled = true;
  $('#ocr-result').innerHTML = '';
  // 한글 섞인 페이지는 '한국어 먼저' 순서여야 한글 줄이 엉뚱한 한자로 바뀌지 않음 (chi_sim+kor 는 효과 없었음)
  // 중국어만 있는 사진은 chi_sim 단독이 조금 더 정확해서 기본값은 chi_sim
  const langs = $('#ocr-kor').checked ? 'kor+chi_sim' : 'chi_sim';
  const first = !window.Tesseract;
  setStatus(`<span class="loading">${first ? '인식 엔진 받는 중 (처음 한 번, 약 5MB)' : '준비 중'}</span>`);
  try {
    const worker = await getWorker(langs, (label, p) =>
      setStatus(`<span class="loading">${esc(label)}${p != null && p > 0 && p < 1 ? ` ${Math.round(p * 100)}%` : ''}</span>`),
    );
    const t0 = performance.now();
    const { data } = await worker.recognize(regionCanvas());
    const lines = cleanText(data.text);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (!lines.length) {
      setStatus(`<span class="warn">한자를 찾지 못했어요 (${secs}초). 글자 부분만 크게 골라 다시 해 보세요.</span>`);
    } else {
      setStatus(`<span>${lines.length}줄 인식 (${secs}초) · 틀린 글자는 고친 뒤 검색하세요</span>`);
      showResult(lines);
    }
  } catch (err) {
    setStatus(`<span class="err">${esc(err.message || err)}</span>`);
  } finally {
    st.busy = false;
    btn.disabled = false;
  }
}

function showResult(lines) {
  const box = $('#ocr-result');
  box.innerHTML = `
    ${
      lines.length > 1
        ? `<div class="ocr-lines">${lines
            .map((l) => `<button type="button" class="chip" data-ocr-line="${esc(l)}" lang="zh-Hans" title="이 줄만 검색">${esc(l)}</button>`)
            .join('')}</div>`
        : ''
    }
    <textarea id="ocr-text" class="ocr-text" rows="${Math.min(6, lines.length + 1)}" lang="zh-Hans" spellcheck="false">${esc(lines.join('\n'))}</textarea>
    <button type="button" class="search-btn ocr-go" id="ocr-search">이 글자로 검색</button>`;
}

function searchText(text) {
  const q = String(text || '').replace(/\s+/g, '').slice(0, 80);
  if (!q) return;
  closeSheet();
  if (typeof window.search === 'function') window.search(q);
}

/* ---------- 연결 ---------- */
function init() {
  const fileInput = $('#ocr-file');
  if (!fileInput) return;
  $('#ocr-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = ''; // 같은 사진을 다시 골라도 동작하게
    if (!file) return;
    render(file);
    openSheet();
    loadTesseract().catch(() => {}); // 사진을 고르는 동안 미리 받아 둠
  });
  $('#ocr-close').addEventListener('click', closeSheet);
  $('#ocr-scrim').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#ocr').hidden) closeSheet();
  });
  $('#ocr').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'ocr-go') return recognize();
    if (t.id === 'ocr-search') return searchText($('#ocr-text').value);
    if (t.id === 'ocr-reset') {
      st.crop = null;
      $('#ocr-rect').hidden = true;
      return;
    }
    if (t.dataset.ocrLine) return searchText(t.dataset.ocrLine);
  });
}

window.PinyinOCR = { cleanText }; // 테스트·점검용
init();
})();
