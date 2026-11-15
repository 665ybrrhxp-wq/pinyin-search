'use strict';
/**
 * 사전 데이터 내려받기 + 브라우저용으로 가공 → docs/data/
 *   node scripts/build-data.js                    (없는 파일만 생성)
 *   node scripts/build-data.js --force            (전부 새로 생성)
 *   node scripts/build-data.js --only=hsk.json    (지정한 파일만)
 *
 * 생성물 (docs/data/):
 *   cedict.json   CC-CEDICT [간체, 번체(같으면 ''), 숫자 병음, 뜻('/'구분)] 배열
 *   mmah.json     Make Me a Hanzi: 뜻/병음/분해/자원/부수 글리프
 *   unihan.json   Unihan: 부수-획수, 총획, 한글 독음, 번체/간체 이체자
 *   hun.json      libhangul 훈음 (대표 훈음을 맨 앞에)
 *   hsk.json      HSK 등급·품사·표준 병음
 *   freq.json     jieba 단어 빈도 (정렬용)
 *   kowikt.json   한국어 위키낱말사전의 중국어 표제어 뜻
 *   meta.json     데이터 버전(내용 해시) — 브라우저 캐시 갱신 기준
 *   licenses/     원본 라이선스 전문
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { openZip } = require('./zip');

const DATA_DIR = path.join(__dirname, '..', 'docs', 'data');

const SOURCES = {
  cedict: ['https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz'],
  mmah: [
    'https://raw.githubusercontent.com/skishore/makemeahanzi/master/dictionary.txt',
    'https://cdn.jsdelivr.net/gh/skishore/makemeahanzi@master/dictionary.txt',
  ],
  unihan: ['https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip'],
  hanja: [
    'https://raw.githubusercontent.com/libhangul/libhangul/main/data/hanja/hanja.txt',
    'https://cdn.jsdelivr.net/gh/libhangul/libhangul@main/data/hanja/hanja.txt',
  ],
  // 한문 교육용 기초 한자 1800 (위키낱말사전 부록, CC BY-SA) — 대표 훈음(예: 便 편할 편)을 맨 앞에 두는 데 사용
  hanja1800: [
    'https://raw.githubusercontent.com/aliencube/Hanja-for-Everyday-Use/master/Documents/korean-hanja.html',
    'https://ko.wiktionary.org/w/index.php?title=%EB%B6%80%EB%A1%9D:%ED%95%9C%EB%AC%B8_%EA%B5%90%EC%9C%A1%EC%9A%A9_%EA%B8%B0%EC%B4%88_%ED%95%9C%EC%9E%90_1800&action=raw',
  ],
  // HSK 등급(구HSK o1~6, 신HSK 2021 n1~7, 2026 개정 t1~7) + 품사
  hsk: ['https://raw.githubusercontent.com/drkameleon/complete-hsk-vocabulary/main/complete.min.json'],
  // jieba 단어 빈도 (MIT)
  freq: ['https://raw.githubusercontent.com/fxsjy/jieba/master/jieba/dict.txt'],
  // 한국어 위키낱말사전 추출본 (wiktextract, CC BY-SA 4.0)
  kowikt: ['https://kaikki.org/kowiktionary/raw-wiktextract-data.jsonl.gz'],
  licenses: {
    'makemeahanzi-COPYING.txt': 'https://raw.githubusercontent.com/skishore/makemeahanzi/master/COPYING',
    'unicode-license.txt': 'https://www.unicode.org/license.txt',
    'complete-hsk-vocabulary-LICENSE.txt':
      'https://raw.githubusercontent.com/drkameleon/complete-hsk-vocabulary/main/LICENSE',
    'jieba-LICENSE.txt': 'https://raw.githubusercontent.com/fxsjy/jieba/master/LICENSE',
  },
};

// 없으면 앱이 동작하지 않는 파일 (나머지는 있으면 품질이 좋아지는 선택 데이터)
const REQUIRED_FILES = ['cedict.json', 'mmah.json', 'unihan.json', 'hun.json'];
const DATA_FILES = ['cedict.json', 'mmah.json', 'unihan.json', 'hun.json', 'kowikt.json', 'hsk.json', 'freq.json'];

const HAN_RE = /[\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{3134f}]/u;
const UA = 'pinyin-search-dictionary-builder/1.0 (+https://github.com/)';

async function download(urls, log) {
  let lastErr;
  for (const url of urls) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        log(`내려받는 중: ${url}`);
        const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        log(`  ↳ ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
        return buf;
      } catch (err) {
        lastErr = err;
        log(`  ↳ 실패 (${err.message})${attempt < 2 ? ', 다시 시도' : ''}`);
      }
    }
  }
  throw new Error(`내려받기 실패: ${urls.join(' , ')} — ${lastErr && lastErr.message}`);
}

function writeJSON(dataDir, file, obj) {
  fs.writeFileSync(path.join(dataDir, file), JSON.stringify(obj));
}

function readJSON(dataDir, file) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
}

/* ---------- CC-CEDICT ---------- */
async function buildCedict(dataDir, log) {
  const buf = await download(SOURCES.cedict, log);
  const text = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  if (!/CC-CEDICT/i.test(text.slice(0, 2000))) throw new Error('CC-CEDICT 형식이 아닙니다');
  const re = /^(\S+) (\S+) \[([^\]]*)\] \/(.*)\/\s*$/;
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const m = re.exec(line.trimEnd());
    if (!m) continue;
    const [, trad, simp, py, defs] = m;
    out.push([simp, trad === simp ? '' : trad, py, defs]);
  }
  writeJSON(dataDir, 'cedict.json', out);
  log(`CC-CEDICT 저장 (${out.length.toLocaleString()} 항목)`);
}

/** CC-CEDICT 표제어 집합 (빈도 데이터 거르기용) */
function cedictWords(dataDir) {
  const words = new Set();
  for (const [simp, trad] of readJSON(dataDir, 'cedict.json')) {
    words.add(simp);
    if (trad) words.add(trad);
  }
  return words;
}

/* ---------- Make Me a Hanzi ---------- */
async function buildMmah(dataDir, log) {
  const text = (await download(SOURCES.mmah, log)).toString('utf8');
  const out = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o.character) continue;
    const e = o.etymology
      ? Object.fromEntries(
          Object.entries({
            type: o.etymology.type,
            hint: o.etymology.hint,
            semantic: o.etymology.semantic,
            phonetic: o.etymology.phonetic,
          }).filter(([, v]) => v),
        )
      : undefined;
    out[o.character] = { d: o.definition || undefined, p: o.pinyin || [], dc: o.decomposition || undefined, r: o.radical || undefined, e };
  }
  writeJSON(dataDir, 'mmah.json', out);
  log(`Make Me a Hanzi 저장 (${Object.keys(out).length.toLocaleString()} 자)`);
}

/* ---------- libhangul 훈음 ---------- */
async function buildHun(dataDir, log) {
  const text = (await download(SOURCES.hanja, log)).toString('utf8');
  // BSD-3 저작권 고지는 원문 그대로 보관해야 하므로 파일 머리 주석을 따로 저장
  const header = [];
  for (const raw of text.split('\n')) {
    if (!raw.startsWith('#')) break;
    header.push(raw.replace(/^# ?/, ''));
  }
  if (header.length) {
    fs.mkdirSync(path.join(dataDir, 'licenses'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'licenses', 'libhangul-hanja-LICENSE.txt'), header.join('\n').trim() + '\n');
  }
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const parts = line.split(':');
    if (parts.length < 3) continue;
    const [, hanja, ...rest] = parts;
    if ([...hanja].length !== 1 || !HAN_RE.test(hanja)) continue;
    const meaning = rest.join(':').trim();
    if (!meaning) continue;
    for (const m of meaning.split(/\s*[,;]\s*/)) {
      if (!m) continue;
      (out[hanja] ||= []);
      if (!out[hanja].includes(m)) out[hanja].push(m);
    }
  }

  // 대표 훈음을 맨 앞으로 (교육용 기초 한자 1800). 실패해도 libhangul 순서로 계속 진행.
  let rep = 0;
  try {
    const html = (await download(SOURCES.hanja1800, log)).toString('utf8');
    const re = /([\u3400-\u9fff\uf900-\ufaff])(?:<\/a>|\]\])\s*\(([^()<>]{2,30})\)/gu;
    let m;
    while ((m = re.exec(html))) {
      const [, ch, hunRaw] = m;
      const hun = hunRaw.split(/\s*[,/]\s*/)[0].trim();
      if (!/^[\uac00-\ud7a3 ()~·]+ [\uac00-\ud7a3]$/.test(hun)) continue;
      const list = (out[ch] ||= []);
      const i = list.indexOf(hun);
      if (i > 0) list.splice(i, 1);
      if (i !== 0) list.unshift(hun);
      rep++;
    }
  } catch (err) {
    log(`⚠ 대표 훈음 목록을 못 받아 libhangul 순서를 그대로 씁니다: ${err.message}`);
  }
  writeJSON(dataDir, 'hun.json', out);
  log(`훈음 저장 (${Object.keys(out).length.toLocaleString()} 자, 대표 훈음 ${rep.toLocaleString()} 자)`);
}

/* ---------- Unihan ---------- */
function cpToChar(s) {
  const m = /^U\+([0-9A-F]{4,6})/i.exec(s);
  return m ? String.fromCodePoint(parseInt(m[1], 16)) : null;
}

async function buildUnihan(dataDir, log) {
  const buf = await download(SOURCES.unihan, log);
  const zip = openZip(buf);
  const wanted = new Set(['kRSUnicode', 'kTotalStrokes', 'kHangul', 'kMandarin', 'kDefinition', 'kSimplifiedVariant', 'kTraditionalVariant']);

  // 필요한 글자만 남기기: CC-CEDICT · Make Me a Hanzi · 훈음에 등장하는 글자
  const keep = new Set();
  const addChars = (s) => {
    for (const c of s) if (HAN_RE.test(c)) keep.add(c);
  };
  try {
    for (const [simp, trad] of readJSON(dataDir, 'cedict.json')) {
      addChars(simp);
      addChars(trad);
    }
  } catch {
    /* 없으면 생략 */
  }
  for (const f of ['mmah.json', 'hun.json']) {
    try {
      Object.keys(readJSON(dataDir, f)).forEach(addChars);
    } catch {
      /* 없으면 생략 */
    }
  }

  const raw = {};
  for (const name of zip.names.filter((n) => /\.txt$/i.test(n))) {
    const text = zip.read(name).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line || line[0] === '#') continue;
      const [cp, field, value] = line.split('\t');
      if (!wanted.has(field)) continue;
      const c = cpToChar(cp);
      if (!c) continue;
      (raw[c] ||= {})[field] = (value || '').trim();
    }
  }

  // 이체자도 포함
  for (const c of [...keep]) {
    const r = raw[c];
    if (!r) continue;
    for (const f of ['kSimplifiedVariant', 'kTraditionalVariant']) {
      for (const v of (r[f] || '').split(/\s+/)) {
        const vc = cpToChar(v);
        if (vc) keep.add(vc);
      }
    }
  }

  const out = {};
  for (const c of keep) {
    const r = raw[c];
    if (!r) continue;
    const o = {};
    if (r.kRSUnicode) o.rs = r.kRSUnicode;
    if (r.kTotalStrokes) o.ts = Number(r.kTotalStrokes.split(/\s+/)[0]) || undefined;
    if (r.kHangul) o.kh = [...new Set(r.kHangul.match(/[\uac00-\ud7a3]/g) || [])];
    if (r.kMandarin) o.mand = r.kMandarin.split(/\s+/)[0];
    if (r.kDefinition) o.def = r.kDefinition;
    const vars = (f) =>
      (r[f] || '')
        .split(/\s+/)
        .map(cpToChar)
        .filter((x) => x && x !== c);
    const tv = vars('kTraditionalVariant');
    const sv = vars('kSimplifiedVariant');
    if (tv.length) o.tv = [...new Set(tv)];
    if (sv.length) o.sv = [...new Set(sv)];
    out[c] = o;
  }
  writeJSON(dataDir, 'unihan.json', out);
  log(`Unihan 저장 (${Object.keys(out).length.toLocaleString()} 자)`);
}

/* ---------- HSK ---------- */
// ICTCLAS 품사 기호 → 한국어 품사명 (위키낱말사전 뜻 순서를 정하는 데 사용)
const HSK_POS_KO = {
  n: '명사', f: '명사', s: '명사', t: '명사', tg: '명사', nr: '고유명사', ns: '고유명사', nt: '고유명사', nz: '고유명사',
  v: '동사', vn: '동사', a: '형용사', an: '형용사', b: '형용사', z: '형용사', d: '부사', ad: '부사', r: '대명사',
  m: '수사', mq: '수사', q: '양사', qv: '양사', qt: '양사', c: '접속사', cc: '접속사', p: '개사', u: '조사', y: '조사',
  e: '감탄사', o: '감탄사', k: '접미사', h: '접두사', l: '구', g: '한자',
};

async function buildHsk(dataDir, log) {
  const list = JSON.parse((await download(SOURCES.hsk, log)).toString('utf8'));
  const out = {};
  for (const r of Array.isArray(list) ? list : Object.values(list)) {
    if (!r || !r.s) continue;
    const o = {};
    for (const tag of r.l || []) {
      const m = /^([ont])(\d+)$/.exec(tag);
      if (!m) continue;
      const lv = Number(m[2]);
      if (!o[m[1]] || lv < o[m[1]]) o[m[1]] = lv;
    }
    if (r.q && r.q < 1000000) o.q = r.q;
    const py = (r.f || [])
      .map((f) => f.i && f.i.n)
      .filter(Boolean)
      .map((n) => n.toLowerCase().replace(/u:/g, 'v').replace(/ü/g, 'v').replace(/\s+/g, ''));
    if (py.length) o.py = [...new Set(py)];
    const pos = [...new Set((r.p || []).map((p) => HSK_POS_KO[p]).filter(Boolean))];
    if (pos.length) o.p = pos;
    out[r.s] = o;
  }
  writeJSON(dataDir, 'hsk.json', out);
  log(`HSK 저장 (${Object.keys(out).length.toLocaleString()} 단어)`);
}

/* ---------- jieba 빈도 ---------- */
async function buildFreq(dataDir, log) {
  const text = (await download(SOURCES.freq, log)).toString('utf8');
  const words = cedictWords(dataDir);
  const out = {};
  for (const line of text.split('\n')) {
    const [w, f] = line.trim().split(/\s+/);
    const n = Number(f);
    if (!w || !n || !words.has(w)) continue;
    if (!out[w] || n > out[w]) out[w] = n;
  }
  writeJSON(dataDir, 'freq.json', out);
  log(`빈도 저장 (${Object.keys(out).length.toLocaleString()} 단어)`);
}

/* ---------- 한국어 위키낱말사전 (중국어 표제어) ---------- */
const POS_KO = {
  noun: '명사', verb: '동사', adj: '형용사', adv: '부사', pron: '대명사', num: '수사', classifier: '양사',
  particle: '조사', conj: '접속사', intj: '감탄사', prefix: '접두사', suffix: '접미사', phrase: '구',
  proverb: '속담', det: '한정사', postp: '후치사', name: '고유명사', character: '한자', prep: '개사',
};

async function buildKoWikt(dataDir, log) {
  const { Readable } = require('stream');
  const readline = require('readline');
  const url = SOURCES.kowikt[0];
  log(`내려받는 중(스트리밍, 약 28MB): ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rl = readline.createInterface({
    input: Readable.fromWeb(res.body).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  const out = {};
  for await (const line of rl) {
    if (!line.includes('"lang_code": "zh"') && !line.includes('"lang_code":"zh"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.lang_code !== 'zh' || !o.word || !HAN_RE.test(o.word)) continue;
    const glosses = (o.senses || [])
      .flatMap((s) => s.glosses || [])
      .map((g) => String(g).trim().replace(/[.。]+$/u, '').trim())
      .filter(Boolean);
    if (!glosses.length) continue;
    const pos = POS_KO[o.pos] || '';
    const list = (out[o.word] ||= []);
    let grp = list.find((x) => x.pos === pos);
    if (!grp) list.push((grp = { pos, g: [] }));
    for (const g of glosses) if (!grp.g.includes(g) && grp.g.length < 8) grp.g.push(g);
  }
  writeJSON(dataDir, 'kowikt.json', out);
  log(`위키낱말사전 중국어 뜻 저장 (${Object.keys(out).length.toLocaleString()} 단어)`);
}

/* ---------- 라이선스 전문 ---------- */
async function buildLicenses(dataDir, log) {
  const dir = path.join(dataDir, 'licenses');
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, url] of Object.entries(SOURCES.licenses)) {
    try {
      fs.writeFileSync(path.join(dir, file), await download([url], log));
    } catch (err) {
      log(`⚠ 라이선스 ${file} 내려받기 실패: ${err.message}`);
    }
  }
}

/* ---------- 데이터 버전 ---------- */
function writeMeta(dataDir, log) {
  const hash = crypto.createHash('sha1');
  const files = {};
  for (const f of DATA_FILES) {
    const p = path.join(dataDir, f);
    if (!fs.existsSync(p)) continue;
    const buf = fs.readFileSync(p);
    hash.update(f).update(buf);
    files[f.replace(/\.json$/, '')] = buf.length;
  }
  const meta = { version: hash.digest('hex').slice(0, 12), built: new Date().toISOString(), files };
  fs.writeFileSync(path.join(dataDir, 'meta.json'), JSON.stringify(meta, null, 1));
  log(`meta.json 버전 ${meta.version}`);
  return meta;
}

/* ---------- 실행 ---------- */
// [파일, 함수, 필수 여부] — 순서 중요 (unihan·freq 는 cedict 결과를 사용)
const STEPS = [
  ['cedict.json', buildCedict, true],
  ['mmah.json', buildMmah, true],
  ['hun.json', buildHun, true],
  ['unihan.json', buildUnihan, true],
  ['hsk.json', buildHsk, false],
  ['freq.json', buildFreq, false],
  ['kowikt.json', buildKoWikt, false],
  ['licenses/unicode-license.txt', buildLicenses, false],
];

async function build({ dataDir = DATA_DIR, force = false, log = console.log, only = null } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  for (const [file, fn, required] of STEPS) {
    if (only && !only.includes(file)) continue;
    if (!force && fs.existsSync(path.join(dataDir, file))) {
      log(`${file} 있음 → 건너뜀`);
      continue;
    }
    try {
      await fn(dataDir, log);
    } catch (err) {
      if (required) throw err;
      log(`⚠ 선택 데이터 ${file} 생성 실패 (앱은 계속 동작): ${err.message}`);
    }
  }
  return writeMeta(dataDir, log);
}

module.exports = { build, REQUIRED_FILES, DATA_FILES, SOURCES, DATA_DIR };

if (require.main === module) {
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice(7).split(',') : null;
  build({ force: process.argv.includes('--force') || !!only, only })
    .then(() => console.log('완료'))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
