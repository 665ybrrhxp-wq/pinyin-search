/**
 * 사전 엔진: CC-CEDICT 색인 + 한자 정보(Make Me a Hanzi, Unihan, libhangul 훈음, 부수표)
 * 브라우저(전역 DictLib)와 Node(require) 양쪽에서 동작. 파일을 직접 읽지 않고 loadData()로 데이터를 받음.
 *
 * CC-CEDICT 는 [간체, 번체(같으면 ''), 숫자 병음, 뜻('/'로 구분)] 배열로 받고,
 * 항목은 실제로 필요할 때만 풀어서(entry) 휴대폰에서도 메모리·시작 시간을 아낌.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./pinyin'));
  else root.DictLib = factory(root.PinyinLib);
})(typeof self !== 'undefined' ? self : this, function (PinyinLib) {
'use strict';

const { parseCedictPinyin, parseQuery } = PinyinLib;

const HAN_RE = /[\u3400-\u9fff\uf900-\ufaff\u{20000}-\u{3134f}]/u;
const HANGUL_RE = /[\uac00-\ud7a3\u3131-\u318e]/;

const IDS_ARITY = {
  '⿰': 2, '⿱': 2, '⿲': 3, '⿳': 3, '⿴': 2, '⿵': 2, '⿶': 2, '⿷': 2, '⿸': 2, '⿹': 2, '⿺': 2, '⿻': 2,
};

const POSITION_LABEL = {
  변: '왼쪽(변)',
  방: '오른쪽(방)',
  머리: '위(머리)',
  발: '아래(발)',
  엄: '위·왼쪽을 덮음(엄)',
  받침: '왼쪽·아래를 받침(받침)',
  몸: '둘러쌈(몸)',
  제부수: '글자 자체가 부수(제부수)',
};

// 부수 이름 끝의 위치 표현 (예: 볼견방(간체), 수레거변)
const POS_SUFFIX_RE = /(변|방|머리|발|엄|받침|몸)(\([^)]*\))?$/;

// Make Me a Hanzi 에 없는 글자를 위해: Unihan 의 간체 부수 표시(149' 등) → 간체 부수 모양
const SIMPLIFIED_RADICAL_FORM = {
  120: '纟', 147: '见', 149: '讠', 154: '贝', 159: '车', 167: '钅', 168: '长', 169: '门', 178: '韦',
  181: '页', 182: '风', 183: '飞', 184: '饣', 187: '马', 195: '鱼', 196: '鸟', 197: '卤', 199: '麦',
  201: '黄', 205: '黾', 210: '齐', 211: '齿', 212: '龙', 213: '龟',
};

const TONE_OF_MARK = (() => {
  const map = new Map();
  const table = { 1: 'āēīōūǖ', 2: 'áéíóúǘḿń', 3: 'ǎěǐǒǔǚň', 4: 'àèìòùǜǹ' };
  for (const [t, chars] of Object.entries(table)) for (const ch of chars) map.set(ch, Number(t));
  return map;
})();

function toneOfMarked(s) {
  for (const ch of String(s).normalize('NFC')) {
    const t = TONE_OF_MARK.get(ch.toLowerCase());
    if (t) return t;
  }
  return 5;
}

function pushMap(map, key, val) {
  const arr = map.get(key);
  if (arr) arr.push(val);
  else map.set(key, [val]);
}

function isBoundOrVariantDef(d) {
  return /^(old |archaic |ancient |obscure |Japanese |Taiwan |)variant of /i.test(d) || /^see [^ ]+\[/i.test(d);
}

/** "Xi1 an1" → "xi an", "lu:4 se4" → "lv se" (성조 숫자·비음절 토큰 제거) — 색인 키 */
function pinyinKey(py) {
  const k = py.toLowerCase().replace(/u:/g, 'v').replace(/ü/g, 'v').replace(/[1-5]/g, '');
  if (/^[a-z]+(?: [a-z]+)*$/.test(k)) return k;
  return k
    .split(/\s+/)
    .filter((t) => /^[a-z]+$/.test(t))
    .join(' ');
}

class Dictionary {
  constructor() {
    this.raw = []; // [simp, trad|'', pinyin, defs]
    this.cache = [];
    this.byKey = new Map();
    this.bySimp = new Map();
    this.byTrad = new Map();
    this.chars = {}; // Make Me a Hanzi
    this.unihan = {};
    this.hun = {};
    this.freq = {};
    this.hsk = {};
    this.kowikt = {};
    this.radicals = new Map();
    this.loaded = false;
  }

  /** 데이터 객체를 받아 색인을 만듦 */
  loadData({ cedict, mmah, unihan, hun, freq, hsk, kowikt, radicals } = {}) {
    this.raw = cedict || [];
    this.cache = new Array(this.raw.length);
    this.byKey = new Map();
    this.bySimp = new Map();
    this.byTrad = new Map();
    for (let id = 0; id < this.raw.length; id++) {
      const r = this.raw[id];
      pushMap(this.byKey, pinyinKey(r[2]), id);
      pushMap(this.bySimp, r[0], id);
      if (r[1]) pushMap(this.byTrad, r[1], id);
    }
    this.chars = mmah || {};
    this.unihan = unihan || {};
    this.hun = hun || {};
    this.freq = freq || {};
    this.hsk = hsk || {};
    this.kowikt = kowikt || {};
    this.radicals = new Map();
    for (const r of (radicals && radicals.radicals) || []) this.radicals.set(r.num, r);
    this.loaded = true;
    return this;
  }

  get size() {
    return this.raw.length;
  }

  stats() {
    return {
      cedict: this.raw.length,
      chars: Object.keys(this.chars).length,
      unihan: Object.keys(this.unihan).length,
      hun: Object.keys(this.hun).length,
      radicals: this.radicals.size,
      hsk: Object.keys(this.hsk).length,
      freq: Object.keys(this.freq).length,
      kowikt: Object.keys(this.kowikt).length,
    };
  }

  /** id → 풀어 둔 항목 { id, simp, trad, syl, defs, proper, variantOnly } */
  entry(id) {
    let e = this.cache[id];
    if (e) return e;
    const [simp, trad0, py, defStr] = this.raw[id];
    const syl = parseCedictPinyin(py);
    const defs = defStr ? defStr.split('/').filter(Boolean) : [];
    e = {
      id,
      simp,
      trad: trad0 || simp,
      syl,
      numbered: syl
        .filter((s) => s.isSyl)
        .map((s) => s.base + (s.tone || 5))
        .join(''),
      defs,
      proper: syl.some((s) => s.proper),
      variantOnly: defs.length > 0 && defs.every(isBoundOrVariantDef),
    };
    this.cache[id] = e;
    return e;
  }

  /* ---------------- 점수 ---------------- */
  wordFreq(word) {
    return this.freq[word] || 0;
  }

  hskLevel(word) {
    const h = this.hsk[word];
    return h ? h.t || h.n || h.o || null : null;
  }

  /** 이 항목의 발음이 그 단어의 주된 발음이 아닌지 (예: 见 xiàn — 주로 jiàn) */
  isSecondaryReading(e) {
    // 한 글자: Make Me a Hanzi 발음 목록의 첫 번째가 주된 발음 (见 → jiàn, 吗 → ma)
    if ([...e.simp].length === 1 && e.syl[0]) {
      const p = this.chars[e.simp] && this.chars[e.simp].p;
      if (p && p.length) return p[0].normalize('NFC').toLowerCase() !== e.syl[0].marked.normalize('NFC').toLowerCase();
    }
    // 여러 글자: HSK 에 발음이 하나만 있을 때만 판단 (HSK 자료는 CC-CEDICT 의 발음을 모두 나열하기도 함)
    const h = this.hsk[e.simp];
    if (h && h.py && h.py.length === 1) return h.py[0] !== e.numbered;
    return false;
  }

  entryScore(e) {
    // 빈도는 단어(글자) 단위라 드문 발음에도 그대로 붙으므로, 주된 발음이 아니면 깎음
    let s = Math.log10(1 + this.wordFreq(e.simp)) * 10; // 0 ~ 70 정도
    if (this.isSecondaryReading(e)) s -= 15;
    const lv = this.hskLevel(e.simp);
    if (lv) s += 18 - Math.min(9, lv);
    if (e.proper) s -= 12;
    if (e.variantOnly) s -= 25;
    if (e.defs.some((d) => /^surname /i.test(d)) && e.defs.length === 1) s -= 6;
    if (e.defs.some((d) => /^(used in|see also)/i.test(d)) && e.defs.length <= 2) s -= 3;
    s += Math.min(e.defs.length, 6) * 0.4;
    return s;
  }

  /* ---------------- 결과 묶기 ---------------- */
  buildGroups(ids, { imeRank } = {}) {
    const groups = new Map();
    for (const id of ids) {
      const e = this.entry(id);
      let g = groups.get(e.simp);
      if (!g) {
        g = { word: e.simp, ids: [], score: -Infinity };
        groups.set(e.simp, g);
      }
      if (!g.ids.includes(id)) g.ids.push(id);
      g.score = Math.max(g.score, this.entryScore(e));
    }
    for (const g of groups.values()) {
      if (imeRank && imeRank.has(g.word)) g.score += 200 - imeRank.get(g.word) * 4;
    }
    return [...groups.values()].sort((a, b) => b.score - a.score || a.word.length - b.word.length);
  }

  /** 단어 묶음 → 화면에 넘길 형태 */
  serializeGroup(g) {
    const hsk = this.hsk[g.word] || null;
    const hskPy = new Set((hsk && hsk.py) || []);
    const readings = g.ids
      .map((id) => this.entry(id))
      .sort((a, b) => {
        const am = hskPy.has(a.numbered) ? 1 : 0;
        const bm = hskPy.has(b.numbered) ? 1 : 0;
        const ap = a.proper ? 1 : 0;
        const bp = b.proper ? 1 : 0;
        return bm - am || ap - bp || this.entryScore(b) - this.entryScore(a) || a.id - b.id;
      });
    const first = readings[0];
    return {
      word: g.word,
      trad: first.trad,
      hsk: hsk && (hsk.t || hsk.n || hsk.o) ? { t: hsk.t || null, n: hsk.n || null, o: hsk.o || null } : null,
      readings: readings.map((e) => ({
        trad: e.trad,
        syllables: e.syl.map((s) => ({ t: s.marked, tone: s.isSyl ? s.tone || 5 : 5 })),
        defs: e.defs,
        proper: e.proper,
      })),
      chars: this.charSummaries(first),
    };
  }

  charSummaries(e) {
    const simp = [...e.simp];
    const trad = [...e.trad];
    const out = [];
    simp.forEach((c, i) => {
      if (!HAN_RE.test(c)) return;
      const s = e.syl[i];
      const t = trad[i] && trad[i] !== c ? trad[i] : null;
      out.push({
        c,
        trad: t,
        pinyin: s ? s.marked : '',
        tone: s && s.isSyl ? s.tone || 5 : 5,
        hun: this.hunFor(c, t),
        radical: this.radicalInfo(c, { brief: true }),
        strokes: this.totalStrokes(c),
      });
    });
    return out;
  }

  /* ---------------- 검색 ---------------- */
  /** 병음 검색 → { parsed, groups, interpretations, toneRelaxed, invalid } */
  searchPinyin(q, { imeWords } = {}) {
    const parsed = parseQuery(q);
    const interpretations = [];
    const strict = new Set();
    const loose = new Set();
    for (const seg of parsed.segmentations) {
      const key = seg.map((s) => s.base).join(' ');
      const ids = this.byKey.get(key);
      if (!ids) continue;
      let any = false;
      for (const id of ids) {
        loose.add(id);
        const syls = this.entry(id).syl.filter((s) => s.isSyl);
        const ok = seg.every((s, i) => !s.tone || (syls[i] && (syls[i].tone || 5) === s.tone));
        if (ok) {
          strict.add(id);
          any = true;
        }
      }
      if (any || !parsed.hasTone) {
        interpretations.push(seg.map((s) => s.base + (s.tone ? s.tone : '')).join(' '));
      }
    }
    let ids = strict;
    let toneRelaxed = false;
    if (!strict.size && loose.size && parsed.hasTone) {
      ids = loose;
      toneRelaxed = true;
    }
    const imeRank = new Map();
    (imeWords || []).forEach((w, i) => {
      if (!imeRank.has(w)) imeRank.set(w, i);
    });
    // 입력기 후보가 번체로만 사전에 있으면 간체 묶음으로 연결
    for (const [w, r] of [...imeRank]) {
      if (this.bySimp.has(w)) continue;
      for (const id of this.byTrad.get(w) || []) {
        const simp = this.raw[id][0];
        if (!imeRank.has(simp) || imeRank.get(simp) > r) imeRank.set(simp, r);
      }
    }
    const groups = this.buildGroups([...ids], { imeRank });
    return { parsed, groups, interpretations, toneRelaxed, invalid: parsed.invalid };
  }

  /** 한자 검색: 정확히 일치 → 포함 단어 */
  searchHanzi(q) {
    const text = [...q].filter((c) => HAN_RE.test(c)).join('');
    if (!text) return { groups: [] };
    const exact = this.exactIds(text);
    const exactGroups = this.buildGroups(exact).map((g) => ({ ...g, score: g.score + 1000 }));
    const containing = [];
    for (let id = 0; id < this.raw.length; id++) {
      const r = this.raw[id];
      if (r[0] === text || r[1] === text) continue;
      if (r[0].includes(text) || (r[1] && r[1].includes(text))) containing.push(id);
    }
    // 앞부분이 일치하는 단어를 조금 우대
    const containGroups = this.buildGroups(containing)
      .map((g) => ({ ...g, score: g.score + (g.word.startsWith(text) ? 4 : 0) - g.word.length }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 200);
    return { groups: [...exactGroups, ...containGroups] };
  }

  /** 단어 정확히 찾기 (간체·번체) */
  exactIds(word) {
    return [...(this.bySimp.get(word) || []), ...(this.byTrad.get(word) || [])];
  }

  /**
   * 한국어 위키낱말사전 뜻 (번체 표제어 우선, 간체는 대부분 번체로 넘겨주기만 함)
   * 반환: { text, full, pos, alts:[{pos, terms}], provider, kind:'dict' } | null
   */
  koreanDict(word) {
    const forms = [];
    for (const id of this.bySimp.get(word) || []) {
      const t = this.raw[id][1] || word;
      if (!forms.includes(t)) forms.push(t);
    }
    if (!forms.includes(word)) forms.push(word);
    if ([...word].length === 1) for (const t of this.unihan[word]?.tv || []) if (!forms.includes(t)) forms.push(t);
    let groups = null;
    for (const f of forms) {
      if (this.kowikt[f]) {
        groups = this.kowikt[f];
        break;
      }
    }
    if (!groups || !groups.length) return null;
    const order = this.hsk[word]?.p || [];
    const rank = (pos) => {
      const i = order.indexOf(pos);
      return i >= 0 ? i : pos ? 50 : 99;
    };
    const sorted = [...groups].sort((a, b) => rank(a.pos) - rank(b.pos));
    const [main, ...rest] = sorted;
    const alts = [];
    if (main.g.length > 3) alts.push({ pos: main.pos, terms: main.g.slice(3) });
    for (const r of rest) alts.push({ pos: r.pos, terms: r.g });
    // 제목줄에는 짧게 (긴 풀이는 말줄임 + 전체는 full 로 전달 → 툴팁)
    const full = main.g.slice(0, 3).join(', ');
    const text = full.length > 48 ? full.slice(0, 46).replace(/[\s,;(]+$/u, '') + '…' : full;
    return {
      text,
      full,
      pos: main.pos || null,
      alts,
      provider: '한국어 위키낱말사전',
      kind: 'dict',
    };
  }

  /* ---------------- 한자 정보 ---------------- */
  hunFor(c, trad) {
    if (trad && this.hun[trad]) return this.hun[trad];
    if (this.hun[c]) return this.hun[c];
    for (const t of this.unihan[c]?.tv || []) if (this.hun[t]) return this.hun[t];
    return [];
  }

  totalStrokes(c) {
    return this.unihan[c]?.ts || null;
  }

  parseRS(c) {
    const rs = this.unihan[c]?.rs;
    if (!rs) return null;
    const m = /^(\d+)('*)\.(-?\d+)/.exec(String(rs).split(' ')[0]);
    if (!m) return null;
    return { num: Number(m[1]), simplifiedRadical: m[2].length > 0, extra: Number(m[3]) };
  }

  radicalInfo(c, { brief = false } = {}) {
    const rs = this.parseRS(c);
    const mm = this.chars[c];
    let num = rs?.num || null;
    let form = mm?.r || null;
    if (!num && form) {
      // Unihan 이 없을 때: 부수 모양으로 번호 찾기
      for (const r of this.radicals.values()) {
        if (r.char === form || (r.forms || []).some((f) => f.form === form)) {
          num = r.num;
          break;
        }
      }
    }
    if (!num) return null;
    const r = this.radicals.get(num);
    if (r && form && form !== r.char && !(r.forms || []).some((f) => f.form === form)) {
      // Make Me a Hanzi 의 부수(예: 军→车)가 Unihan 부수(冖)와 다르면 Unihan 기준으로 통일하고,
      // 분해식에 실제로 나오는 그 부수의 모양(视 → 礻, 军 → 冖)을 찾아 씀 — 획수도 Unihan 기준이라 서로 맞음
      const glyphs = [r.char, ...(r.forms || []).map((f) => f.form)];
      const ids = (mm && mm.dc) || '';
      form = glyphs.find((g) => ids.includes(g)) || (rs?.simplifiedRadical && SIMPLIFIED_RADICAL_FORM[num]) || r.char;
    }
    if (!form) form = rs?.simplifiedRadical ? SIMPLIFIED_RADICAL_FORM[num] || r?.char : r?.char;
    if (!r) return { num, char: form, form, name: '', label: form };

    const position = c === form || c === r.char ? '제부수' : idsPosition(mm?.dc, form);
    const forms = r.forms || [];
    // 변형 글리프(亻 氵 讠 …)는 위치와 무관하게 고유 이름을 쓰고,
    // 부수 글자 그대로인 경우(口 女 木 …)는 실제 위치가 맞을 때만 그 이름을 씀 (喜의 口는 '입구변'이 아님)
    const isVariantGlyph = form !== r.char;
    let fe = forms.find((f) => f.form === form && f.position === position);
    if (!fe && isVariantGlyph) {
      const cand = forms.find((f) => f.form === form);
      // 이름에 위치가 박혀 있으면(볼견방, 수레거변 …) 실제 위치가 다를 때는 쓰지 않음 (觉의 见은 아래쪽)
      const conflicts = cand && position && cand.position && cand.position !== position && POS_SUFFIX_RE.test(cand.name);
      if (cand && !conflicts) fe = cand;
    }
    let formName = fe ? fe.name : null;
    if (!formName && position === '변' && r.name) formName = r.name.replace(/\s+/g, '') + '변';
    const label = formName || r.name || form;
    if (brief) return { form, char: r.char, label };
    return {
      num,
      char: r.char,
      form,
      name: r.name,
      formName,
      position,
      positionLabel: position ? POSITION_LABEL[position] : null,
      strokes: r.strokes || null,
      label,
    };
  }

  charInfo(c, { trad } = {}) {
    c = [...String(c)][0];
    if (!c) return null;
    const mm = this.chars[c] || null;
    const uh = this.unihan[c] || null;
    const rs = this.parseRS(c);

    let readings = [];
    if (mm && mm.p && mm.p.length) readings = mm.p.map((p) => ({ t: p, tone: toneOfMarked(p) }));
    else if (uh && uh.mand) readings = [{ t: uh.mand, tone: toneOfMarked(uh.mand) }];
    else {
      const seen = new Set();
      for (const id of this.bySimp.get(c) || []) {
        const s = this.entry(id).syl[0];
        if (s && !seen.has(s.marked)) {
          seen.add(s.marked);
          readings.push({ t: s.marked, tone: s.tone || 5 });
        }
      }
    }

    const traditional = (uh?.tv || []).filter((x) => x !== c);
    const simplified = (uh?.sv || []).filter((x) => x !== c);
    const hunChars = [];
    if (trad && trad !== c) hunChars.push(trad);
    if (this.hun[c]) hunChars.push(c);
    for (const t of traditional) if (!hunChars.includes(t)) hunChars.push(t);
    const hunSources = hunChars.filter((x) => this.hun[x]).map((x) => ({ char: x, hun: this.hun[x] }));

    let decomposition = null;
    if (mm && mm.dc && mm.dc !== '？') {
      const components = [...new Set([...mm.dc].filter((x) => !IDS_ARITY[x] && x !== '？' && x !== c))];
      decomposition = { ids: mm.dc, components };
    }

    let etymology = null;
    if (mm && mm.e) {
      etymology = { type: mm.e.type, hint: mm.e.hint || null, semantic: mm.e.semantic || null, phonetic: mm.e.phonetic || null };
    }

    return {
      c,
      readings,
      traditional,
      simplified,
      hun: hunSources[0]?.hun || [],
      hunSources,
      hangul: uh?.kh || [],
      radical: this.radicalInfo(c),
      strokes: this.totalStrokes(c),
      extraStrokes: rs ? rs.extra : null,
      decomposition,
      etymology,
      definition: mm?.d || uh?.def || null,
      words: this.wordsWithChar(c, 14),
    };
  }

  /** 이 글자가 들어간 단어 (색인 없이 훑어봄: 12만 항목도 수십 ms) */
  wordsWithChar(c, limit) {
    const ids = [];
    for (let id = 0; id < this.raw.length; id++) {
      const r = this.raw[id];
      if ((r[0].includes(c) || (r[1] && r[1].includes(c))) && [...r[0]].length >= 2) ids.push(id);
    }
    const usable = ids.filter((id) => {
      const e = this.entry(id);
      return !e.variantOnly && !e.proper;
    });
    return this.buildGroups(usable)
      .slice(0, limit)
      .map((g) => {
        const e = this.entry(g.ids[0]);
        return {
          word: g.word,
          syllables: e.syl.map((s) => ({ t: s.marked, tone: s.isSyl ? s.tone || 5 : 5 })),
          def: e.defs.slice(0, 2).join('; '),
        };
      });
  }
}

/** IDS 분해식에서 부수 위치(변/방/머리/발/엄/받침/몸) 추정 */
function idsPosition(ids, form) {
  if (!ids || !form || ids === '？') return null;
  const chars = [...ids];
  let i = 0;
  function parse() {
    const ch = chars[i++];
    if (ch === undefined) return null;
    const arity = IDS_ARITY[ch];
    if (!arity) return { leaf: ch };
    const kids = [];
    for (let k = 0; k < arity; k++) kids.push(parse());
    return { op: ch, kids };
  }
  const contains = (node) => node && (node.leaf === form || (node.kids || []).some(contains));
  const tree = parse();
  if (!tree || !tree.op) return null;
  const idx = tree.kids.findIndex(contains);
  if (idx < 0) return null;
  const last = tree.kids.length - 1;
  switch (tree.op) {
    case '⿰':
    case '⿲':
      return idx === 0 ? '변' : idx === last ? '방' : null;
    case '⿱':
    case '⿳':
      return idx === 0 ? '머리' : idx === last ? '발' : null;
    case '⿸':
      return idx === 0 ? '엄' : null;
    case '⿺':
      return idx === 0 ? '받침' : null;
    case '⿴':
    case '⿵':
    case '⿶':
    case '⿷':
    case '⿹':
      return idx === 0 ? '몸' : null;
    default:
      return null;
  }
}

return { Dictionary, HAN_RE, HANGUL_RE, idsPosition, toneOfMarked, pinyinKey };
});
