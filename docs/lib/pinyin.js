/**
 * 병음(Pinyin) 유틸리티 — 브라우저(전역 PinyinLib)와 Node(require) 양쪽에서 동작
 *  - parseQuery(input)      사용자 입력 → 가능한 음절 분절 목록(성조 포함)
 *  - parseCedictPinyin(str) "xi3 huan5" → [{ base:'xi', tone:3, raw:'xi3' }, ...]
 *  - markSyllable(base, t)  'xi', 3 → 'xǐ'
 *
 * 내부 표기: ü 는 'v' 로 통일 (lv, nve ...)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PinyinLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const TONE_TABLE = {
  a: ['ā', 'á', 'ǎ', 'à'],
  e: ['ē', 'é', 'ě', 'è'],
  i: ['ī', 'í', 'ǐ', 'ì'],
  o: ['ō', 'ó', 'ǒ', 'ò'],
  u: ['ū', 'ú', 'ǔ', 'ù'],
  v: ['ǖ', 'ǘ', 'ǚ', 'ǜ'],
};

// 성조 부호가 붙은 모음 → [기본 모음, 성조]
const MARKED = new Map();
for (const [base, marks] of Object.entries(TONE_TABLE)) {
  marks.forEach((m, i) => MARKED.set(m, [base, i + 1]));
}
// 성모 없는 m/n 성조 표기 (드묾)
MARKED.set('ḿ', ['m', 2]);
MARKED.set('ń', ['n', 2]);
MARKED.set('ň', ['n', 3]);
MARKED.set('ǹ', ['n', 4]);

// 표준 한어병음 음절 (성조 제외). 분절(띄어쓰기 없는 입력)에 사용.
const SYLLABLE_TEXT = `
a ai an ang ao
ba bai ban bang bao bei ben beng bi bian biao bie bin bing bo bu
pa pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu
ma mai man mang mao me mei men meng mi mian miao mie min ming miu mo mou mu
fa fan fang fei fen feng fo fou fu
da dai dan dang dao de dei den deng di dia dian diao die ding diu dong dou du duan dui dun duo
ta tai tan tang tao te tei teng ti tian tiao tie ting tong tou tu tuan tui tun tuo
na nai nan nang nao ne nei nen neng ni nian niang niao nie nin ning niu nong nou nu nuan nun nuo nv nve
la lai lan lang lao le lei leng li lia lian liang liao lie lin ling liu lo long lou lu luan lun luo lv lve
ga gai gan gang gao ge gei gen geng gong gou gu gua guai guan guang gui gun guo
ka kai kan kang kao ke kei ken keng kong kou ku kua kuai kuan kuang kui kun kuo
ha hai han hang hao he hei hen heng hong hou hu hua huai huan huang hui hun huo
ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue jun
qi qia qian qiang qiao qie qin qing qiong qiu qu quan que qun
xi xia xian xiang xiao xie xin xing xiong xiu xu xuan xue xun
zha zhai zhan zhang zhao zhe zhei zhen zheng zhi zhong zhou zhu zhua zhuai zhuan zhuang zhui zhun zhuo
cha chai chan chang chao che chen cheng chi chong chou chu chua chuai chuan chuang chui chun chuo
sha shai shan shang shao she shei shen sheng shi shou shu shua shuai shuan shuang shui shun shuo
ran rang rao re ren reng ri rong rou ru rua ruan rui run ruo
za zai zan zang zao ze zei zen zeng zi zong zou zu zuan zui zun zuo
ca cai can cang cao ce cen ceng ci cong cou cu cuan cui cun cuo
sa sai san sang sao se sen seng si song sou su suan sui sun suo
ya yan yang yao ye yi yin ying yo yong you yu yuan yue yun
wa wai wan wang wei wen weng wo wu
e ei en eng er o ou
`;

const SYLLABLES = new Set(SYLLABLE_TEXT.trim().split(/\s+/));
// 흔한 대체 입력: lue → lve(略), nue → nve(虐)
const ALIASES = new Map([['lue', 'lve'], ['nue', 'nve']]);
const MAX_SYL_LEN = 6; // zhuang, shuang, chuang

const MAX_SEGMENTATIONS = 48;

function isSyllable(s) {
  return SYLLABLES.has(s) || ALIASES.has(s);
}

/** 성조 부호를 숫자로 분리: 'xǐ' → { letters:'xi', marks:[0,3] } */
function splitMarks(chunk) {
  let letters = '';
  const marks = [];
  for (const ch of chunk) {
    const m = MARKED.get(ch);
    if (m) {
      letters += m[0];
      marks.push(m[1]);
    } else {
      letters += ch;
      marks.push(0);
    }
  }
  return { letters, marks };
}

/** 글자열(a-z, v)을 음절로 분절. 반환: [[ [start,end], ... ], ...] */
function segmentLetters(letters) {
  const n = letters.length;
  const memo = new Map();
  function go(i) {
    if (i === n) return [[]];
    if (memo.has(i)) return memo.get(i);
    const out = [];
    for (let len = Math.min(MAX_SYL_LEN, n - i); len >= 1; len--) {
      const piece = letters.slice(i, i + len);
      // 儿화(r) 는 덩어리 맨 끝에서만 허용: yidianr → yi dian r
      const ok = isSyllable(piece) || (piece === 'r' && i + 1 === n && i > 0);
      if (!ok) continue;
      for (const rest of go(i + len)) {
        out.push([[i, i + len], ...rest]);
        if (out.length >= MAX_SEGMENTATIONS) break;
      }
      if (out.length >= MAX_SEGMENTATIONS) break;
    }
    memo.set(i, out);
    return out;
  }
  return go(0);
}

/**
 * 사용자 입력 파싱.
 * "ben zi" / "benzi" / "xi3 huan" / "xǐhuan" / "lv se" / "nü'er"
 * 반환:
 *  {
 *    chunks: [{ text, letters, tailTone }],
 *    segmentations: [ [{ base, tone }], ... ],   // tone: 1~5 또는 null(미지정)
 *    imeText: 'xi\'huan',                           // 입력기(IME) 질의용
 *    invalid: ['xyz'],                              // 분절 불가능한 덩어리
 *    hasTone: boolean
 *  }
 */
const MAX_INPUT = 80; // 분절은 재귀라 입력 길이를 제한 (서버도 80자로 자름)

function parseQuery(input) {
  let s = String(input || '')
    .slice(0, MAX_INPUT)
    .normalize('NFC')
    .toLowerCase();
  // ü → v (성조 붙은 ǖǘǚǜ 는 MARKED 표에서 v 로 처리됨)
  s = s.replace(/u:/g, 'v').replace(/ü/g, 'v');

  // 덩어리 나누기: 공백/구두점은 경계, 숫자는 앞 덩어리의 성조 + 경계
  const rawChunks = [];
  let cur = '';
  for (const ch of s) {
    if (/[a-z]/.test(ch) || MARKED.has(ch)) {
      cur += ch;
    } else if (/[0-5]/.test(ch)) {
      if (cur) rawChunks.push({ text: cur, tailTone: ch === '0' ? 5 : Number(ch) });
      cur = '';
    } else {
      if (cur) rawChunks.push({ text: cur, tailTone: null });
      cur = '';
    }
  }
  if (cur) rawChunks.push({ text: cur, tailTone: null });

  const chunks = [];
  const invalid = [];
  const perChunkSegs = [];
  let hasTone = false;

  for (const rc of rawChunks) {
    const { letters: rawLetters, marks } = splitMarks(rc.text);
    // j/q/x/y 뒤의 v 는 u 로 (jv → ju)
    const letters = rawLetters.replace(/([jqxy])v/g, '$1u');
    if (rc.tailTone || marks.some(Boolean)) hasTone = true;
    chunks.push({ text: rc.text, letters, tailTone: rc.tailTone });

    const segs = segmentLetters(letters);
    if (!segs.length) {
      invalid.push(rc.text);
      continue;
    }
    perChunkSegs.push(
      segs.map((ranges) =>
        ranges.map(([a, b], idx) => {
          let base = letters.slice(a, b);
          base = ALIASES.get(base) || base;
          let tone = null;
          for (let k = a; k < b; k++) if (marks[k]) tone = marks[k];
          if (idx === ranges.length - 1 && rc.tailTone) tone = rc.tailTone;
          return { base, tone };
        }),
      ),
    );
  }

  // 덩어리별 분절의 곱집합
  let segmentations = [[]];
  for (const options of perChunkSegs) {
    const next = [];
    for (const prefix of segmentations) {
      for (const opt of options) {
        next.push(prefix.concat(opt));
        if (next.length >= MAX_SEGMENTATIONS) break;
      }
      if (next.length >= MAX_SEGMENTATIONS) break;
    }
    segmentations = next;
  }
  if (!perChunkSegs.length) segmentations = [];

  // 음절 수가 적은(=더 자연스러운) 분절을 앞으로
  segmentations.sort((x, y) => x.length - y.length);

  const imeText = chunks
    .filter((c) => !invalid.includes(c.text))
    .map((c) => c.letters)
    .join("'");

  return { chunks, segmentations, imeText, invalid, hasTone };
}

/** 성조 부호 붙이기: ('xi',3) → 'xǐ', ('lv',4) → 'lǜ', ('Xi',1) → 'Xī' */
function markSyllable(base, tone) {
  let s = String(base).replace(/u:/g, 'ü').replace(/U:/g, 'Ü').replace(/v/g, 'ü').replace(/V/g, 'Ü');
  if (!tone || tone === 5) return s;
  const lower = s.toLowerCase();
  if (/^(m|n|ng)$/.test(lower)) {
    const combining = ['\u0304', '\u0301', '\u030C', '\u0300'][tone - 1];
    return (s[0] + combining + s.slice(1)).normalize('NFC');
  }
  let idx = -1;
  if (lower.includes('a')) idx = lower.indexOf('a');
  else if (lower.includes('e')) idx = lower.indexOf('e');
  else if (lower.includes('ou')) idx = lower.indexOf('o');
  else {
    for (let i = lower.length - 1; i >= 0; i--) {
      if ('iouü'.includes(lower[i])) {
        idx = i;
        break;
      }
    }
  }
  if (idx < 0) return s;
  const ch = s[idx];
  const key = ch.toLowerCase() === 'ü' ? 'v' : ch.toLowerCase();
  let marked = TONE_TABLE[key][tone - 1];
  if (ch !== ch.toLowerCase()) marked = marked.toUpperCase();
  return s.slice(0, idx) + marked + s.slice(idx + 1);
}

/**
 * CC-CEDICT 병음 문자열 파싱. "Xi1 an1" / "lu:4 se4" / "yi1 dian3 r5" / "A A zhi4"
 * 반환: [{ raw, base(소문자, ü→v), tone(1~5 | null), marked, proper(대문자 여부), isSyl }]
 */
function parseCedictPinyin(str) {
  const out = [];
  for (const raw of String(str).trim().split(/\s+/)) {
    const m = /^([A-Za-züÜ:]+)([1-5])?$/.exec(raw);
    if (!m) {
      out.push({ raw, base: null, tone: null, marked: raw, proper: false, isSyl: false });
      continue;
    }
    const letters = m[1];
    const tone = m[2] ? Number(m[2]) : null;
    const base = letters.toLowerCase().replace(/u:/g, 'v').replace(/ü/g, 'v');
    const proper = letters[0] !== letters[0].toLowerCase();
    out.push({
      raw,
      base,
      tone,
      marked: markSyllable(letters, tone),
      proper,
      isSyl: true,
    });
  }
  return out;
}

const TONE_NAMES_KO = { 1: '1성', 2: '2성', 3: '3성', 4: '4성', 5: '경성' };

return {
  SYLLABLES,
  parseQuery,
  markSyllable,
  parseCedictPinyin,
  segmentLetters,
  TONE_NAMES_KO,
};
});
