'use strict';

/* ================= 공통 ================= */
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const TONE_KO = { 1: '1성', 2: '2성', 3: '3성', 4: '4성', 5: '경성' };
const ETYM_KO = { pictographic: '상형자', ideographic: '회의자', pictophonetic: '형성자' };
const IDS_KO = {
  '⿰': '좌우 결합', '⿱': '상하 결합', '⿲': '좌·중·우 결합', '⿳': '상·중·하 결합', '⿴': '전체를 에워쌈',
  '⿵': '위에서 에워쌈', '⿶': '아래에서 에워쌈', '⿷': '왼쪽에서 에워쌈', '⿸': '왼쪽 위에서 에워쌈',
  '⿹': '오른쪽 위에서 에워쌈', '⿺': '왼쪽 아래에서 에워쌈', '⿻': '겹침',
};
const PAGE = 20;

const svc = window.PinyinService;
const HW_DATA = 'https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0.1';

const state = {
  query: '',
  offset: 0,
  total: 0,
  token: 0,
  meaningQueue: new Set(),
  meaningTimer: null,
  writer: null,
};

// 儿화(r)는 앞 음절에 붙여 표기: yī diǎn r → yī diǎnr
const isErhua = (s, i) => i > 0 && /^r$/i.test(s.t);

function pinyinHTML(syllables) {
  return (syllables || [])
    .map(
      (s, i) =>
        `${i === 0 || isErhua(s, i) ? '' : ' '}<span class="t${s.tone || 5}" title="${TONE_KO[s.tone || 5]}">${esc(s.t)}</span>`,
    )
    .join('');
}

function pinyinText(syllables) {
  return (syllables || []).map((s, i) => (i === 0 || isErhua(s, i) ? '' : ' ') + s.t).join('');
}

function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}

/* ================= 발음 (TTS) ================= */
let zhVoice = null;
function pickVoice() {
  if (!('speechSynthesis' in window)) return;
  const voices = speechSynthesis.getVoices();
  zhVoice =
    voices.find((v) => /zh[-_]CN/i.test(v.lang) && /natural|online/i.test(v.name)) ||
    voices.find((v) => /zh[-_]CN/i.test(v.lang)) ||
    voices.find((v) => /^zh/i.test(v.lang) && !/HK|TW/i.test(v.lang)) ||
    null;
}
if ('speechSynthesis' in window) {
  pickVoice();
  speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
}

let ttsAudio = null;
function speak(text) {
  if (!text) return;
  if (zhVoice) {
    const u = new SpeechSynthesisUtterance(text);
    u.voice = zhVoice;
    u.lang = zhVoice.lang;
    u.rate = 0.8;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    return;
  }
  // 브라우저에 중국어 음성이 없으면 Google TTS 음성 파일로 재생
  try {
    ttsAudio?.pause();
  } catch {
    /* noop */
  }
  ttsAudio = new Audio(svc.ttsUrl(text));
  ttsAudio.play().catch(() => toast('발음을 재생할 수 없어요 (중국어 음성 없음)'));
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('복사했어요: ' + text);
  } catch {
    toast('복사 실패');
  }
}

/* ================= 검색 기록 ================= */
const HISTORY_KEY = 'pinyin-search:history';
function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}
function saveHistory(q) {
  try {
    const list = [q, ...loadHistory().filter((x) => x !== q)].slice(0, 12);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {
    /* 저장소 사용 불가 */
  }
  renderHistory();
}
function clearHistory() {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    /* noop */
  }
  renderHistory();
}
function renderHistory() {
  const el = $('#history');
  const list = loadHistory();
  if (!list.length) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  el.innerHTML =
    `<span class="row-label">최근</span>` +
    list.map((q) => `<button type="button" class="chip history" data-q="${esc(q)}">${esc(q)}</button>`).join('') +
    `<button type="button" class="chip" data-clear-history title="기록 지우기">✕ 지우기</button>`;
}

/* ================= 검색 ================= */
async function search(q, { push = true, offset = 0 } = {}) {
  q = String(q || '').trim();
  if (!q) return;
  const token = ++state.token; // 늦게 도착한 이전 검색 결과는 버림
  const results = $('#results');
  const more = $('#more');

  if (offset === 0) {
    state.query = q;
    state.offset = 0;
    $('#q').value = q;
    $('#status').innerHTML = '';
    results.innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
    more.hidden = true;
    if (push) {
      const url = `?q=${encodeURIComponent(q)}`;
      if (location.search !== url) history.pushState({ q }, '', url);
    }
    document.title = `${q} · 병음 사전`;
  } else {
    more.disabled = true;
    more.textContent = '불러오는 중…';
  }

  try {
    const data = await svc.search(q, { offset, limit: PAGE });
    if (token !== state.token) return;
    if (offset === 0) {
      results.innerHTML = '';
      renderStatus(data);
      saveHistory(q);
    }
    if (offset === 0 && data.sentence) {
      results.appendChild(sentenceCard(data.sentence));
      if (!data.sentence.korean) queueMeanings([data.sentence.hanzi]);
    }
    for (const g of data.groups) results.appendChild(groupCard(g));
    state.offset = offset + data.groups.length;
    state.total = data.total;
    more.hidden = state.offset >= data.total;
    more.disabled = false;
    more.textContent = `결과 더 보기 (${state.offset}/${data.total})`;
    if (offset === 0 && !data.groups.length) {
      results.innerHTML = `<div class="empty">검색 결과가 없어요.<br>병음 철자를 확인하거나 성조를 빼고 다시 검색해 보세요.</div>`;
    }
    queueMeanings(data.groups.filter((g) => !g.korean).map((g) => g.word));
  } catch (err) {
    if (token !== state.token) return;
    if (offset === 0) results.innerHTML = '';
    $('#status').innerHTML = `<span class="err">검색 실패: ${esc(err.message)}</span>`;
    more.disabled = false;
  }
}

function renderStatus(data) {
  const parts = [];
  if (data.mode === 'pinyin') {
    if (data.interpretations?.length) {
      parts.push(
        `<span class="interp">해석: ${data.interpretations
          .slice(0, 6)
          .map((s) => `<span class="pill">${esc(s)}</span>`)
          .join('')}</span>`,
      );
    }
    parts.push(`<span>결과 ${data.total}개</span>`);
    if (data.toneRelaxed) parts.push(`<span class="warn">입력한 성조와 정확히 맞는 단어가 없어 성조를 무시한 결과예요</span>`);
  } else if (data.mode === 'sentence') {
    parts.push(`<span>문장으로 풀이 · 단어 ${data.total}개</span>`);
  } else if (data.mode === 'hanzi') {
    parts.push(`<span>한자 검색 · 결과 ${data.total}개</span>`);
  } else if (data.mode === 'korean') {
    parts.push(
      `<span>한국어 → 중국어: ${(data.translations || []).map((t) => `<span class="pill" lang="zh-Hans">${esc(t)}</span>`).join(' ') || '번역 없음'} · 결과 ${data.total}개</span>`,
    );
  }
  if (data.invalid?.length) parts.push(`<span class="warn">병음이 아닌 부분: ${esc(data.invalid.join(', '))}</span>`);
  for (const w of data.warnings || []) parts.push(`<span class="warn">${esc(w)}</span>`);
  $('#status').innerHTML = parts.join(' · ');
}

function hskBadge(hsk) {
  if (!hsk) return '';
  const lv = (n) => (n >= 7 ? '7-9' : String(n));
  const tip = [];
  if (hsk.t) tip.push(`HSK 3.0 (2026 개정) ${lv(hsk.t)}급`);
  if (hsk.n) tip.push(`HSK 3.0 (2021) ${lv(hsk.n)}급`);
  if (hsk.o) tip.push(`구HSK ${hsk.o}급`);
  const main = hsk.t || hsk.n;
  if (main) return `<span class="badge" title="${esc(tip.join(' · '))}">HSK ${lv(main)}</span>`;
  return `<span class="badge muted" title="${esc(tip.join(' · '))}">구HSK ${hsk.o}</span>`;
}

function meaningAltsHTML(alts) {
  return (alts || [])
    .filter((a) => a.terms && a.terms.length)
    .slice(0, 4)
    .map((a) => `${a.pos ? `<span class="pos">${esc(a.pos)}</span>` : ''}${esc(a.terms.slice(0, 5).join(', '))}`)
    .join(' <span class="sep">·</span> ');
}

function charChip(ch) {
  const hun = (ch.hun && ch.hun[0]) || '';
  const rad = ch.radical ? `${ch.radical.form} ${ch.radical.label}` : '';
  const tradNote = ch.trad && ch.trad !== ch.c ? ` <span lang="zh-Hant">(${esc(ch.trad)})</span>` : '';
  return `<button type="button" class="char-chip" data-char="${esc(ch.c)}" data-trad="${esc(ch.trad || '')}" title="${esc(ch.c)} 한자 정보 보기" aria-label="${esc(ch.c)} ${esc(ch.pinyin || '')} ${esc(hun)} — 한자 정보 보기">
    <span class="big" lang="zh-Hans">${esc(ch.c)}</span>
    <span class="meta">
      <span class="l1"><span class="t${ch.tone || 5}">${esc(ch.pinyin || '')}</span> · ${esc(hun || '훈음 없음')}${tradNote}</span>
      <span class="l2">${rad ? `부수 ${esc(rad)}` : '부수 정보 없음'}${ch.strokes ? ` · ${ch.strokes}획` : ''}</span>
    </span>
  </button>`;
}

function groupCard(g) {
  const r0 = g.readings[0];
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.word = g.word;
  card.dataset.py = pinyinText(r0.syllables);
  card.dataset.en = (r0.defs || []).slice(0, 2).join('; ');

  const tradHTML =
    g.trad && g.trad !== g.word ? `<span class="trad" lang="zh-Hant" title="번체자">繁 ${esc(g.trad)}</span> ` : '';
  const readingsHTML =
    g.readings.length === 1
      ? `<ul class="readings"><li><span class="r-def">${tradHTML}${esc((r0.defs || []).join('; ') || '영어 뜻 없음')}</span></li></ul>`
      : `<ul class="readings">${g.readings
          .map(
            (r) =>
              `<li><span class="r-py">${pinyinHTML(r.syllables)}</span><span class="r-def">${
                r.trad && r.trad !== g.word ? `<span class="trad" lang="zh-Hant">繁 ${esc(r.trad)}</span> ` : ''
              }${esc((r.defs || []).join('; ') || '—')}</span></li>`,
          )
          .join('')}</ul>`;

  const ko = g.korean;
  card.innerHTML = `
    <div class="card-head">
      <div class="actions">
        ${hskBadge(g.hsk)}
        <button type="button" class="icon-btn" data-act="speak" aria-label="발음 듣기" title="발음 듣기">🔊</button>
        <button type="button" class="icon-btn" data-act="copy" aria-label="복사" title="'한자 (병음): 뜻' 형식으로 복사">⧉</button>
      </div>
      <p class="headline"><span class="word" lang="zh-Hans">${esc(g.word)}</span> <span class="py"><span class="paren">(</span>${pinyinHTML(
        r0.syllables,
      )}<span class="paren">)</span></span><span class="paren">:</span> <span class="ko ${ko ? '' : 'pending'}" data-ko>${
        ko ? esc(ko.text) : '한국어 뜻 불러오는 중…'
      }</span></p>
    </div>
    <p class="ko-alts" data-alts hidden></p>
    ${readingsHTML}
    <div class="chars">${(g.chars || []).map(charChip).join('')}</div>`;
  if (ko) fillMeaning(card, ko);
  return card;
}

/** 문장 카드: 한자 문장 + 병음 + 번역 + 단어 나눔 (단어 칩을 누르면 그 단어 카드로 이동) */
function sentenceCard(s) {
  const card = document.createElement('article');
  card.className = 'card sentence';
  card.dataset.word = s.hanzi;
  card.dataset.py = s.words.map((w) => pinyinText(w.syllables).replace(/ /g, '')).join(' ');
  card.dataset.en = '';
  card.innerHTML = `
    <div class="card-head">
      <div class="actions">
        <button type="button" class="icon-btn" data-act="speak" aria-label="문장 발음 듣기" title="문장 발음 듣기">🔊</button>
        <button type="button" class="icon-btn" data-act="copy" aria-label="복사" title="'문장 (병음): 뜻' 형식으로 복사">⧉</button>
      </div>
      <p class="headline"><span class="word" lang="zh-Hans">${esc(s.hanzi)}</span></p>
    </div>
    <p class="sent-py">${s.words
      .map((w) => `<span class="sent-w">${pinyinHTML(w.syllables).replace(/> </g, '><')}</span>`)
      .join(' ')}</p>
    <p class="headline"><span class="ko ${s.korean ? '' : 'pending'}" data-ko>${s.korean ? esc(s.korean.text) : '번역 불러오는 중…'}</span></p>
    <p class="ko-alts" data-alts hidden></p>
    <div class="seg">${s.words
      .map(
        (w) => `<button type="button" class="seg-chip" data-jump="${esc(w.word)}" title="${esc(w.word)} 풀이로 이동">
          <span class="w" lang="zh-Hans">${esc(w.word)}</span><span class="p">${pinyinHTML(w.syllables)}</span></button>`,
      )
      .join('<span class="seg-sep">/</span>')}</div>`;
  if (s.korean) fillMeaning(card, s.korean);
  return card;
}

/* ================= 한국어 뜻 (비동기) ================= */
function queueMeanings(words) {
  for (const w of words) state.meaningQueue.add(w);
  clearTimeout(state.meaningTimer);
  state.meaningTimer = setTimeout(flushMeanings, 30);
}

async function flushMeanings() {
  const words = [...state.meaningQueue].slice(0, 25);
  words.forEach((w) => state.meaningQueue.delete(w));
  if (!words.length) return;
  try {
    const data = await svc.meanings(words);
    for (const w of words) {
      document.querySelectorAll(`.card[data-word="${CSS.escape(w)}"]`).forEach((card) => fillMeaning(card, data.items[w]));
    }
  } catch {
    for (const w of words) {
      document.querySelectorAll(`.card[data-word="${CSS.escape(w)}"]`).forEach((card) => fillMeaning(card, null));
    }
  }
  if (state.meaningQueue.size) flushMeanings();
}

function fillMeaning(card, m) {
  const ko = card.querySelector('[data-ko]');
  const alts = card.querySelector('[data-alts]');
  if (!m || !m.text) {
    ko.className = 'ko failed';
    ko.textContent = card.dataset.en || '한국어 뜻을 가져오지 못했어요';
    ko.title = '한국어 번역을 가져오지 못해 영어 뜻을 표시합니다';
    return;
  }
  ko.className = 'ko';
  ko.innerHTML =
    (m.pos ? `<span class="pos-tag">${esc(m.pos)}</span>` : '') +
    esc(m.text) +
    (m.kind === 'mt' ? ` <span class="mt-tag" title="사전에 없는 단어라 무료 번역 API 결과를 보여 줍니다">자동 번역</span>` : '');
  ko.title = [m.full && m.full !== m.text ? m.full : '', m.provider ? `출처: ${m.provider}` : ''].filter(Boolean).join('\n');
  card.dataset.ko = m.text;
  const altText = meaningAltsHTML(m.alts);
  if (altText) {
    alts.innerHTML = altText;
    alts.hidden = false;
  }
}

/* ================= 한자 상세 ================= */
function openDrawer() {
  $('#drawer').hidden = false;
  $('#scrim').hidden = false;
  document.body.style.overflow = 'hidden';
  $('#drawer-close').focus();
}

function closeDrawer() {
  $('#drawer').hidden = true;
  $('#scrim').hidden = true;
  document.body.style.overflow = '';
  try {
    state.writer?.cancelQuiz?.();
  } catch {
    /* noop */
  }
  state.writer = null;
  state.lastChip?.focus?.();
}

async function openChar(c, trad) {
  const body = $('#drawer-body');
  body.innerHTML = `<div class="skeleton" style="height:180px"></div>`;
  $('#drawer-title').textContent = `한자 정보 · ${c}`;
  openDrawer();
  let info;
  try {
    info = await svc.charInfo(c, trad);
  } catch (err) {
    body.innerHTML = `<p class="err">정보를 불러오지 못했어요: ${esc(err.message)}</p>`;
    return;
  }
  renderChar(info);
}

function renderChar(info) {
  const body = $('#drawer-body');
  const r = info.radical;
  const pys = (info.readings || []).map((p) => `<span class="t${p.tone || 5}">${esc(p.t)}</span>`).join(' · ');
  const variants = [];
  if (info.traditional?.length) variants.push(`번체 <span lang="zh-Hant">${esc(info.traditional.join(' '))}</span>`);
  if (info.simplified?.length) variants.push(`간체 <span lang="zh-Hans">${esc(info.simplified.join(' '))}</span>`);

  const hunRows = (info.hunSources || [])
    .map(
      (h) =>
        `<div><span lang="zh-Hant">${esc(h.char)}</span> ${esc(h.hun.join(' / '))}${
          h.char !== info.c ? ' <span class="legend">(번체자 기준)</span>' : ''
        }</div>`,
    )
    .join('');

  let radHTML = '부수 정보 없음';
  if (r) {
    const bits = [];
    bits.push(`<b lang="zh-Hans">${esc(r.form)}</b>`);
    if (r.form !== r.char) bits.push(`(<span lang="zh-Hant">${esc(r.char)}</span>)`);
    bits.push(esc(r.name));
    let line = bits.join(' ');
    const extra = [];
    if (r.formName && r.formName !== r.name) extra.push(esc(r.formName));
    if (r.positionLabel) extra.push(esc(r.positionLabel));
    if (r.num) extra.push(`제${r.num}부수`);
    if (r.strokes) extra.push(`${r.strokes}획`);
    if (extra.length) line += ` <span class="legend">— ${extra.join(' · ')}</span>`;
    radHTML = line;
  }

  const strokeText = info.strokes
    ? `총 ${info.strokes}획${info.extraStrokes != null ? ` <span class="legend">(부수 외 ${info.extraStrokes}획)</span>` : ''}`
    : '—';

  const comps = info.decomposition?.components || [];
  const decomp = comps.length
    ? `${comps
        .map((x) => `<button type="button" class="comp" data-char="${esc(x)}" lang="zh-Hans" title="${esc(x)} 정보 보기">${esc(x)}</button>`)
        .join(' + ')}${
        IDS_KO[[...(info.decomposition.ids || '')][0]]
          ? ` <span class="legend">${IDS_KO[[...info.decomposition.ids][0]]}</span>`
          : ''
      }`
    : '—';

  let etym = '—';
  if (info.etymology) {
    const e = info.etymology;
    const bits = [`<b>${esc(ETYM_KO[e.type] || e.type || '')}</b>`];
    if (e.semantic) bits.push(`뜻 부분 <span lang="zh-Hans">${esc(e.semantic)}</span>`);
    if (e.phonetic) bits.push(`소리 부분 <span lang="zh-Hans">${esc(e.phonetic)}</span>`);
    etym = bits.join(' · ') + (e.hint ? `<div class="legend">${esc(e.hint)}</div>` : '');
  }

  body.innerHTML = `
    <div class="hero">
      <div class="hero-char" lang="zh-Hans">${esc(info.c)}</div>
      <div class="hero-info">
        <div class="hero-py">${pys || '—'}</div>
        <div class="hero-hun">${esc((info.hun || [])[0] || '훈음 정보 없음')}</div>
        <div class="hero-trad">${variants.join(' · ')}</div>
      </div>
      <button type="button" class="icon-btn" data-speak="${esc(info.c)}" aria-label="발음 듣기" style="margin-left:auto">🔊</button>
    </div>
    <dl class="kv">
      <dt>훈음</dt><dd>${hunRows || '—'}${
        info.hangul?.length ? `<div class="legend">한국 한자음: ${esc(info.hangul.join(', '))}</div>` : ''
      }</dd>
      <dt>부수</dt><dd>${radHTML}</dd>
      <dt>획수</dt><dd>${strokeText}</dd>
      <dt>구성</dt><dd>${decomp}</dd>
      <dt>자원</dt><dd>${etym}</dd>
      <dt>뜻(영어)</dt><dd>${esc(info.definition || '—')}</dd>
      <dt>뜻(한국어)</dt><dd id="char-ko" class="legend">불러오는 중…</dd>
    </dl>

    <h3 class="section-title">획순 <span class="legend"><span class="sw"></span>부수 획</span></h3>
    <div class="stroke-wrap">
      <div id="stroke-box" class="stroke-box">획순 불러오는 중…</div>
      <div class="stroke-btns">
        <button type="button" class="btn" data-stroke="animate">▶ 다시 보기</button>
        <button type="button" class="btn" data-stroke="loop">↻ 반복 재생</button>
        <button type="button" class="btn" data-stroke="quiz">✎ 따라 쓰기</button>
      </div>
    </div>

    <h3 class="section-title">이 글자가 들어간 단어</h3>
    <div class="word-list">${
      (info.words || [])
        .map(
          (w) => `<button type="button" class="word-chip" data-q="${esc(w.word)}">
            <span class="w" lang="zh-Hans">${esc(w.word)}</span>
            <span class="p">${pinyinHTML(w.syllables)}</span>
            <span class="d">${esc(w.def || '')}</span>
          </button>`,
        )
        .join('') || '<span class="legend">—</span>'
    }</div>`;

  showStrokes(info.c);
  svc
    .meanings([info.c])
    .then((d) => {
      const m = d.items[info.c];
      const el = $('#char-ko');
      if (!el) return;
      if (!m || !m.text) {
        el.textContent = '뜻 정보 없음';
        return;
      }
      const alts = meaningAltsHTML(m.alts);
      el.className = '';
      el.innerHTML =
        (m.pos ? `<span class="pos-tag">${esc(m.pos)}</span>` : '') +
        esc(m.full || m.text) +
        (m.kind === 'mt' ? ' <span class="mt-tag">자동 번역</span>' : '') +
        (alts ? `<div class="legend">${alts}</div>` : '') +
        `<div class="legend">출처: ${esc(m.provider || '')}</div>`;
    })
    .catch(() => {
      const el = $('#char-ko');
      if (el) el.textContent = '번역을 가져오지 못했어요';
    });
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function showStrokes(c) {
  const box = $('#stroke-box');
  if (!box) return;
  if (!window.HanziWriter) {
    box.textContent = '획순 라이브러리를 불러오지 못했어요 (인터넷 연결 확인)';
    state.writer = null;
    return;
  }
  box.innerHTML = '';
  try {
    state.writer = HanziWriter.create(box, c, {
      width: 200,
      height: 200,
      padding: 14,
      showOutline: true,
      strokeColor: cssVar('--ink'),
      radicalColor: cssVar('--accent'),
      outlineColor: cssVar('--line'),
      drawingColor: cssVar('--t4'),
      highlightColor: cssVar('--t3'),
      strokeAnimationSpeed: 1.1,
      delayBetweenStrokes: 180,
      // 획순 데이터는 CDN 에서 받고, 서비스 워커가 보관해 두 번째부터 오프라인에서도 보임
      charDataLoader: (ch, onComplete, onError) => {
        fetch(`${HW_DATA}/${encodeURIComponent(ch)}.json`)
          .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          })
          .then(onComplete, onError);
      },
      onLoadCharDataError: () => {
        box.textContent = '이 글자는 획순 데이터가 없어요';
        state.writer = null;
      },
    });
    state.writer.animateCharacter();
  } catch {
    box.textContent = '획순을 표시할 수 없어요';
    state.writer = null;
  }
}

function strokeAction(kind) {
  const w = state.writer;
  if (!w) return;
  try {
    w.cancelQuiz?.();
  } catch {
    /* noop */
  }
  if (kind === 'animate') {
    w.showCharacter();
    w.animateCharacter();
  } else if (kind === 'loop') {
    w.showCharacter();
    w.loopCharacterAnimation();
  } else if (kind === 'quiz') {
    w.quiz({
      onComplete: (s) => toast(`완성! 틀린 획 ${s.totalMistakes}개`),
    });
    toast('칸 안에 획순대로 그어 보세요');
  }
}

/* ================= 상태 표시 ================= */
function loadEngineInfo() {
  const s = svc.status();
  const bits = [];
  if (s.counts) {
    bits.push(`사전 ${Number(s.counts.cedict || 0).toLocaleString()}단어`);
    bits.push(`한자 ${Number(s.counts.chars || 0).toLocaleString()}자`);
    if (s.counts.hun) bits.push(`훈음 ${Number(s.counts.hun).toLocaleString()}자`);
  }
  if (s.providers) {
    bits.push(`후보 순위: ${s.providers.candidates}`);
    bits.push(`한국어 뜻: ${s.providers.korean}`);
  }
  if (s.data) bits.push(`데이터 ${s.data.version} (${s.data.fromCache ? '기기에 저장됨' : '새로 받음'}, ${s.data.ms}ms)`);
  $('#engine').textContent = bits.join(' · ');
}

/* ================= 사전 준비 ================= */
const DATA_LABEL = {
  radicals: '부수표', cedict: '단어 사전', mmah: '한자 구성', unihan: '부수·획수', hun: '훈음',
  kowikt: '한국어 뜻', hsk: 'HSK', freq: '빈도',
};

async function prepare() {
  const status = $('#status');
  const showLoading = (done, total, name, fromCache) => {
    status.innerHTML = `<span class="loading">${
      fromCache ? '사전을 여는 중' : '사전 데이터를 받는 중 (처음 한 번, 약 5.5MB)'
    } · ${done}/${total}${name ? ` <span class="legend">${esc(DATA_LABEL[name] || name)}</span>` : ''}</span>`;
  };
  showLoading(0, 8, '', true);
  try {
    await svc.init(showLoading);
    status.innerHTML = '';
    loadEngineInfo();
    return true;
  } catch (err) {
    status.innerHTML = `<span class="err">${esc(err.message)}</span> <button type="button" class="chip" data-retry>다시 시도</button>`;
    return false;
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('서비스 워커 등록 실패:', err));
}

/* ================= 이벤트 ================= */
function init() {
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    search($('#q').value);
  });

  document.addEventListener('click', (e) => {
    const t = e.target.closest('button, [data-q]');
    if (!t) return;
    if (t.matches('[data-clear-history]')) return clearHistory();
    if (t.matches('[data-retry]')) return start();
    if (t.dataset.q && !t.closest('.drawer')) return search(t.dataset.q);
    if (t.dataset.q && t.closest('.drawer')) {
      closeDrawer();
      return search(t.dataset.q);
    }
    if (t.matches('.char-chip')) {
      state.lastChip = t;
      return openChar(t.dataset.char, t.dataset.trad);
    }
    if (t.matches('.comp')) return openChar(t.dataset.char);
    if (t.dataset.jump) {
      const target = document.querySelector(`.card:not(.sentence)[data-word="${CSS.escape(t.dataset.jump)}"]`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.classList.remove('flash');
        void target.offsetWidth;
        target.classList.add('flash');
      }
      return;
    }
    if (t.dataset.speak) return speak(t.dataset.speak);
    if (t.dataset.stroke) return strokeAction(t.dataset.stroke);
    const card = t.closest('.card');
    if (card && t.dataset.act === 'speak') return speak(card.dataset.word);
    if (card && t.dataset.act === 'copy') {
      const meaning = card.dataset.ko || card.dataset.en || '';
      return copyText(`${card.dataset.word} (${card.dataset.py}): ${meaning}`);
    }
  });

  $('#more').addEventListener('click', () => search(state.query, { push: false, offset: state.offset }));
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer();
    if (e.key === '/' && document.activeElement !== $('#q')) {
      e.preventDefault();
      $('#q').focus();
      $('#q').select();
    }
  });

  window.addEventListener('popstate', () => {
    const q = new URLSearchParams(location.search).get('q');
    if (q) search(q, { push: false });
    else {
      $('#results').innerHTML = '';
      $('#status').innerHTML = '';
      $('#more').hidden = true;
      $('#q').value = '';
    }
  });

  window.addEventListener('online', loadEngineInfo);
  window.addEventListener('offline', loadEngineInfo);

  renderHistory();
  registerServiceWorker();
  start();
}

async function start() {
  const q0 = new URLSearchParams(location.search).get('q');
  if (!q0) $('#q').focus();
  if (!(await prepare())) return;
  if (q0) search(q0, { push: false });
}

init();
