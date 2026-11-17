#!/usr/bin/env node
/**
 * AI 사진 인식 모델 비교 평가 — 같은 사진을 Claude 모델 여러 개에 보내 정확도·속도·비용을 잰다.
 *
 *   node scripts/eval-ocr.js --cases <cases.json> --img <사진 폴더> [--rounds 2] [--out <결과 폴더>]
 *                            [--models claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5]
 *
 * cases.json: [{ id, desc, lines: [{ t: "문장", zh: false(중국어가 아니면) }], partial, equiv }]  →  사진은 <img>/<id>.jpg
 *   partial: true  실제 사진처럼 가려지거나 안 읽히는 글자가 있을 때. 정답(확실히 읽히는 글자) 중 몇 개를
 *                  순서대로 찾았는지(인식률)로 채점하고, 정답 밖에서 더 읽은 글자는 따로 셈 (틀렸다고 보지 않음)
 *   equiv: { "级": "級" }  같은 글자로 인정할 이체자·간번체
 * 비밀번호는 OCR_PASSWORD 환경 변수 또는 실행 중 입력(화면에 안 보임). 파일·결과에는 남기지 않는다.
 * 중계 서버의 POST /eval 을 쓰므로 wrangler.toml 의 EVAL_DAILY_LIMIT 이 켜져 있어야 한다.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const RELAY = process.env.OCR_RELAY || 'https://pinyin-ocr-relay.pinyin-ocr-relay.workers.dev';
// 달러 / 100만 토큰 (claude-api 스킬의 가격표, 2026-11-03 기준). 출력 토큰에는 생각(thinking) 토큰도 포함되어 과금됨
const PRICE = {
  'claude-opus-5-5': { in: 4, out: 20 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5 },
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/* ---------- 채점 ---------- */
const HAN = /\p{Script=Han}/u;
const PUNCT_MAP = { ',': '，', '?': '？', '!': '！', ':': '：', ';': '；', '(': '（', ')': '）' };
const ZH_PUNCT = /[，。？！：；、“”‘’（）《》…—]/;

/** 한자만 남김 (주 지표) */
const hanOnly = (s) => [...s].filter((ch) => HAN.test(ch)).join('');
/** 한자 + 중국어 문장부호 (반각 부호는 전각으로 맞춤) */
const hanPunct = (s) =>
  [...s]
    .map((ch) => PUNCT_MAP[ch] || ch)
    .filter((ch) => HAN.test(ch) || ZH_PUNCT.test(ch))
    .join('');
/** 중국어가 아닌 글자(한글·라틴 문자) 수 — 지시(한국어·병음 빼기)를 지켰는지 */
const foreign = (s) => [...s].filter((ch) => /[\p{Script=Hangul}\p{Script=Latin}]/u.test(ch)).length;

/** 가장 긴 공통 부분열 길이 (순서를 지켜 맞힌 글자 수) */
function lcs(a, b) {
  a = [...a];
  b = [...b];
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[b.length];
}

function lev(a, b) {
  a = [...a];
  b = [...b];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 틀린 글자 짝 (정답→인식) 을 대략 뽑기: 같은 길이 줄일 때만 1:1 비교 */
function confusions(truth, pred) {
  const t = [...truth];
  const p = [...pred];
  if (t.length !== p.length) return [];
  const out = [];
  for (let i = 0; i < t.length; i++) if (t[i] !== p[i]) out.push(`${t[i]}→${p[i]}`);
  return out;
}

/** 정답 중 못 찾은 글자 (순서 맞춤 기준) */
function missedChars(truth, pred) {
  const t = [...truth];
  const p = [...pred];
  const dp = Array.from({ length: t.length + 1 }, () => new Array(p.length + 1).fill(0));
  for (let i = t.length - 1; i >= 0; i--)
    for (let j = p.length - 1; j >= 0; j--) dp[i][j] = t[i] === p[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const miss = [];
  let i = 0;
  let j = 0;
  while (i < t.length) {
    if (j < p.length && t[i] === p[j]) { i++; j++; }
    else if (j < p.length && dp[i][j + 1] >= dp[i + 1][j]) j++;
    else miss.push(t[i++]);
  }
  return miss;
}

/* ---------- 비밀번호 입력 (화면에 표시 안 함) ---------- */
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Error('OCR_PASSWORD 환경 변수를 주거나 터미널에서 실행해 주세요'));
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (c === '\u0003') process.exit(130); // Ctrl+C
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

/* ---------- 요청 ---------- */
async function callEval(model, base64, password) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    let data;
    let status;
    try {
      const res = await fetch(`${RELAY}/eval?model=${encodeURIComponent(model)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'X-Access-Password': password },
        body: base64,
      });
      status = res.status;
      data = await res.json().catch(() => ({}));
    } catch (err) {
      status = 0;
      data = { error: err.message };
    }
    const wall = Date.now() - t0;
    if (status === 200) return { ok: true, wall, ...data, attempt };
    if (status === 401 || status === 404 || status === 429 || status === 400) {
      return { ok: false, fatal: true, status, error: data.error || `HTTP ${status}`, code: data.code, attempt };
    }
    if (attempt === 2) return { ok: false, status, error: data.error || `HTTP ${status}`, attempt, wall };
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/* ---------- 통계 ---------- */
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

async function main() {
  const casesPath = arg('cases');
  const imgDir = arg('img');
  if (!casesPath || !imgDir) {
    console.error('사용법: node scripts/eval-ocr.js --cases <cases.json> --img <사진 폴더> [--rounds 2] [--out <폴더>]');
    process.exit(2);
  }
  const rounds = Number(arg('rounds', '2')) || 1;
  const models = arg('models', Object.keys(PRICE).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  const outDir = arg('out', path.dirname(path.resolve(casesPath)));
  const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8')).map((c) => ({
    ...c,
    truth: c.lines.filter((l) => l.zh !== false).map((l) => l.t).join('\n'),
    base64: fs.readFileSync(path.join(imgDir, `${c.id}.jpg`)).toString('base64'),
  }));

  const password = process.env.OCR_PASSWORD || (await askHidden('AI 비밀번호: '));
  if (!password) throw new Error('비밀번호가 비어 있어요');

  console.log(`\n${cases.length}장 × ${models.length}모델 × ${rounds}회 = ${cases.length * models.length * rounds}번 요청\n`);
  const results = [];
  for (let round = 1; round <= rounds; round++) {
    for (const c of cases) {
      // 같은 사진을 세 모델에 동시에 보냄 (시간은 서버가 각 호출마다 따로 잼)
      const runs = await Promise.all(models.map((m) => callEval(m, c.base64, password)));
      for (let i = 0; i < models.length; i++) {
        const r = runs[i];
        const model = models[i];
        if (r.fatal) {
          console.error(`\n중단: ${model} — ${r.error} (${r.code || r.status})`);
          process.exit(1);
        }
        const row = { round, id: c.id, desc: c.desc, model, ok: r.ok, attempt: r.attempt };
        if (r.ok) {
          const eq = (str) => [...str].map((ch) => (c.equiv && c.equiv[ch]) || ch).join('');
          const tH = hanOnly(c.truth);
          const pH = eq(hanOnly(r.text || ''));
          const hit = lcs(tH, pH);
          const tP = hanPunct(c.truth);
          const pP = hanPunct(r.text || '');
          Object.assign(row, {
            served: r.model,
            fallback: !!r.fallback,
            ms: r.ms,
            wall: r.wall,
            tokensIn: r.tokens.input,
            tokensOut: r.tokens.output,
            cost: (r.tokens.input * PRICE[model].in + r.tokens.output * PRICE[model].out) / 1e6,
            truthChars: [...tH].length,
            hanErrors: c.partial ? [...tH].length - hit : lev(tH, pH),
            partial: !!c.partial,
            found: hit,
            extra: [...pH].length - hit,
            punctErrors: lev(tP, pP) - lev(tH, pH),
            exact: c.partial ? hit === [...tH].length : tH === pH,
            exactWithPunct: tP === pP,
            foreignChars: foreign(r.text || ''),
            confusions: c.partial ? [] : confusions(tH, pH),
            missed: c.partial ? missedChars(tH, pH) : [],
            text: r.text,
          });
        } else {
          Object.assign(row, { status: r.status, error: r.error });
        }
        results.push(row);
        const mark = !r.ok ? `실패 ${r.error}` : `${(row.ms / 1000).toFixed(1)}s 오류 ${row.hanErrors}/${row.truthChars}${row.foreignChars ? ` 외국글자 ${row.foreignChars}` : ''}`;
        console.log(`[${round}] ${c.id.padEnd(15)} ${model.padEnd(18)} ${mark}`);
      }
    }
  }

  /* ---------- 요약 ---------- */
  const summary = models.map((model) => {
    const all = results.filter((r) => r.model === model);
    const ok = all.filter((r) => r.ok);
    const chars = sum(ok.map((r) => r.truthChars));
    return {
      model,
      requests: all.length,
      failures: all.length - ok.length,
      cer: chars ? sum(ok.map((r) => r.hanErrors)) / chars : null,
      extra: sum(ok.map((r) => r.extra || 0)),
      exactPages: ok.filter((r) => r.exact).length,
      exactWithPunct: ok.filter((r) => r.exactWithPunct).length,
      punctErrors: sum(ok.map((r) => Math.max(0, r.punctErrors))),
      foreignChars: sum(ok.map((r) => r.foreignChars)),
      medianSec: median(ok.map((r) => r.ms)) / 1000,
      maxSec: Math.max(...ok.map((r) => r.ms)) / 1000,
      avgTokensIn: Math.round(sum(ok.map((r) => r.tokensIn)) / (ok.length || 1)),
      avgTokensOut: Math.round(sum(ok.map((r) => r.tokensOut)) / (ok.length || 1)),
      costPerPhoto: sum(ok.map((r) => r.cost)) / (ok.length || 1),
      fallbacks: ok.filter((r) => r.fallback).length,
    };
  });

  const lines = [];
  lines.push(`# AI 사진 인식 3모델 비교 (${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC)`);
  lines.push('');
  lines.push(`사진 ${cases.length}장 × ${rounds}회, effort low, 같은 프롬프트. 정확도는 한자만 비교(CER = 틀린·빠진·더한 한자 수 / 정답 한자 수).`);
  lines.push('');
  lines.push('| 모델 | 한자 오류율(놓침 포함) | 정답 밖 글자 | 완전 일치 쪽 | 부호까지 일치 | 한글·라틴 섞임 | 시간 중앙값 | 최대 | 평균 토큰 입력/출력 | 사진 1장 비용 | 1,000장 | 실패 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of summary) {
    lines.push(
      `| ${s.model} | ${s.cer == null ? '-' : pct(s.cer)} | ${s.extra}자 | ${s.exactPages}/${s.requests - s.failures} | ${s.exactWithPunct}/${s.requests - s.failures} | ${s.foreignChars}자 | ${s.medianSec.toFixed(1)}초 | ${s.maxSec.toFixed(1)}초 | ${s.avgTokensIn}/${s.avgTokensOut} | $${s.costPerPhoto.toFixed(5)} | $${(s.costPerPhoto * 1000).toFixed(2)} | ${s.failures} |`,
    );
  }
  lines.push('');
  lines.push('## 사진별 결과 (회차별)');
  lines.push('');
  lines.push('일반 사진: 틀린 한자 수. 실제(partial) 사진: 찾은 글자/확실한 정답 글자, 놓친 글자, +정답 밖에서 더 읽은 글자 수(가려진 부분을 읽었거나 지어낸 것 — 원문으로 확인).');
  lines.push('');
  lines.push(`| 사진 | ${models.join(' | ')} |`);
  lines.push(`|---|${models.map(() => '---').join('|')}|`);
  for (const c of cases) {
    const cells = models.map((m) =>
      results
        .filter((r) => r.id === c.id && r.model === m)
        .map((r) => {
          if (!r.ok) return '실패';
          if (r.partial) return `${r.found}/${r.truthChars}${r.missed.length ? ` 놓침 ${r.missed.join('')}` : ''}${r.extra ? ` +${r.extra}` : ''}`;
          return `${r.hanErrors}${r.confusions.length ? ` (${r.confusions.join(' ')})` : ''}`;
        })
        .join(' / '),
    );
    lines.push(`| ${c.id} ${c.desc} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  lines.push('## 정답 (확실히 읽히는 글자)');
  lines.push('');
  for (const c of cases) lines.push(`- ${c.id}: \`${c.truth.replace(/\n/g, ' ⏎ ')}\``);
  lines.push('');
  lines.push('## 원문 (틀렸거나 정답 밖 글자가 있는 결과)');
  lines.push('');
  for (const r of results.filter((x) => x.ok && (!x.exact || x.foreignChars || x.extra))) {
    lines.push(`- [${r.round}] ${r.id} · ${r.model}: \`${(r.text || '').replace(/\n/g, ' ⏎ ')}\``);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const mdPath = path.join(outDir, `eval-${stamp}.md`);
  const jsonPath = path.join(outDir, `eval-${stamp}.json`);
  fs.writeFileSync(mdPath, lines.join('\n') + '\n');
  fs.writeFileSync(jsonPath, JSON.stringify({ relay: RELAY, rounds, models, summary, results }, null, 2));
  console.log('\n' + lines.slice(0, 4 + summary.length + 2).join('\n'));
  console.log(`\n결과: ${mdPath}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
