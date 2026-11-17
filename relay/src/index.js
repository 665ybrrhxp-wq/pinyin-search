/**
 * 병음 사전 — 사진 속 한자 AI 인식 중계 서버 (Cloudflare Worker)
 *
 *   브라우저(병음 사전) ──비밀번호──▶ 이 Worker ──Gemini 키──▶ Google Gemini API
 *
 * Gemini API 키는 이 Worker 의 비밀값으로만 존재하고, 공개 사이트 코드에는 들어가지 않는다.
 * 아는 사람만 쓰도록 비밀번호를 확인하고, 하루 사용량(전체·사람별)에 상한을 둔다.
 * 사진은 저장하지 않는다 (Gemini 로 전달만 함).
 *
 * 비밀값 (npx wrangler secret put …)
 *   GEMINI_API_KEY    Google AI Studio 에서 받은 키
 *   ACCESS_PASSWORDS  "이름:비밀번호,이름:비밀번호" (이름 없이 "비밀번호" 하나만 써도 됨)
 * 설정값 (wrangler.toml [vars])
 *   ALLOWED_ORIGINS, DAILY_LIMIT_TOTAL, DAILY_LIMIT_PER_USER, GEMINI_MODEL(비우면 자동 선택), MAX_IMAGE_BASE64
 * 저장소 (wrangler.toml [[kv_namespaces]])
 *   OCR_USAGE         하루 사용량 카운터 (3일 뒤 자동 삭제)
 *
 * 주소
 *   GET  /health   설정 상태·사용 모델 확인 (비밀번호 불필요, 비밀값은 내보내지 않음)
 *   GET  /usage    비밀번호 확인 + 오늘 남은 횟수
 *   POST /ocr      본문 = JPEG 의 base64 문자열(text/plain), 헤더 X-Access-Password
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const FALLBACK_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
const PROMPT =
  'Transcribe every Chinese character (simplified or traditional) visible in this image exactly as written, ' +
  'keeping the original line breaks and Chinese punctuation. Include handwriting. ' +
  'Skip any Korean or English text. Do not translate, explain, add pinyin, or use markdown. ' +
  'If there is no Chinese text, output nothing.';

let cachedModel = null; // 같은 인스턴스 안에서 고른 모델을 기억

/* ---------------- 공통 ---------------- */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function allowedOrigin(origin, env) {
  if (!origin) return null;
  const list = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(origin) ? origin : null;
}

function corsHeaders(origin) {
  const h = { Vary: 'Origin' };
  if (origin) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type, X-Access-Password';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 비밀번호 ---------------- */
function parsePasswords(env) {
  return String(env.ACCESS_PASSWORDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry, i) => {
      const at = entry.indexOf(':');
      if (at > 0 && at < entry.length - 1) return { label: entry.slice(0, at).trim(), password: entry.slice(at + 1) };
      return { label: `user${i + 1}`, password: entry };
    });
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** 시간 차로 비밀번호를 짐작하지 못하게, 해시끼리 끝까지 비교 */
async function sameSecret(a, b) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** 맞는 비밀번호면 그 사람 이름(사용량 구분용), 아니면 null */
async function authenticate(request, env) {
  const given = request.headers.get('X-Access-Password') || '';
  if (!given) return null;
  let found = null;
  for (const p of parsePasswords(env)) {
    if ((await sameSecret(given, p.password)) && !found) found = p.label;
  }
  return found;
}

/* ---------------- 하루 사용량 ---------------- */
/** 한국 날짜 (KST) */
function today() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

async function readUsage(env, user) {
  const d = today();
  const [total, mine] = await Promise.all([env.OCR_USAGE.get(`${d}:all`), env.OCR_USAGE.get(`${d}:u:${user}`)]);
  return {
    total: { used: Number(total) || 0, limit: num(env.DAILY_LIMIT_TOTAL, 100) },
    user: { used: Number(mine) || 0, limit: num(env.DAILY_LIMIT_PER_USER, 20) },
  };
}

async function countUse(env, user, usage) {
  const d = today();
  const opts = { expirationTtl: 3 * 24 * 3600 };
  await Promise.all([
    env.OCR_USAGE.put(`${d}:all`, String(usage.total.used + 1), opts),
    env.OCR_USAGE.put(`${d}:u:${user}`, String(usage.user.used + 1), opts),
  ]);
  return {
    total: { ...usage.total, used: usage.total.used + 1 },
    user: { ...usage.user, used: usage.user.used + 1 },
  };
}

async function refundUse(env, user, usage) {
  const d = today();
  const opts = { expirationTtl: 3 * 24 * 3600 };
  const total = Math.max(0, usage.total.used - 1);
  const mine = Math.max(0, usage.user.used - 1);
  await Promise.all([
    env.OCR_USAGE.put(`${d}:all`, String(total), opts),
    env.OCR_USAGE.put(`${d}:u:${user}`, String(mine), opts),
  ]);
  return { total: { ...usage.total, used: total }, user: { ...usage.user, used: mine } };
}

/* ---------------- Gemini ---------------- */
class UpstreamError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let rankedModels = []; // 키로 쓸 수 있는 모델을 선호 순서대로 (최신 Flash 먼저)

/** 사용할 모델: 설정값 → 이전에 성공한 것 → 목록에서 가장 새 Flash 계열 자동 선택 */
async function resolveModel(env) {
  if (env.GEMINI_MODEL) return env.GEMINI_MODEL;
  if (cachedModel) return cachedModel;
  try {
    const res = await fetch(`${env.GEMINI_BASE || GEMINI_BASE}/v1beta/models?pageSize=1000`, {
      headers: { 'x-goog-api-key': env.GEMINI_API_KEY },
    });
    const data = await res.json();
    const names = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((n) => /gemini/i.test(n) && !/(tts|image|embedding|aqa|live|audio|computer|robotics|thinking|exp)/i.test(n));
    const version = (n) => Number((/gemini-(\d+(?:\.\d+)?)/i.exec(n) || [])[1]) || 0;
    const rank = (n) =>
      (/flash/i.test(n) ? 1000 : 0) + (/lite/i.test(n) ? -300 : 0) + (/preview/i.test(n) ? -100 : 0) + version(n) * 10;
    names.sort((a, b) => rank(b) - rank(a));
    rankedModels = names;
    if (names[0]) return names[0];
  } catch {
    /* 목록을 못 받으면 기본 별칭 사용 */
  }
  return FALLBACK_MODELS[0];
}

/**
 * 시도할 모델 순서 (최대 4개): 최근 성공 → 가장 새 Flash → 가장 새 Flash-Lite(보통 덜 붐빔) → 그다음 Flash → 기본 별칭
 * 같은 세대만 연달아 시도하면 한꺼번에 붐빌 때 다 실패하므로 Lite 를 섞음
 */
async function candidateModels(env) {
  const first = await resolveModel(env);
  if (env.GEMINI_MODEL) return [...new Set([first, ...FALLBACK_MODELS])].slice(0, 4);
  const flash = rankedModels.filter((n) => /flash/i.test(n) && !/lite/i.test(n));
  const lite = rankedModels.filter((n) => /flash/i.test(n) && /lite/i.test(n));
  return [...new Set([cachedModel, first, lite[0], flash[1], ...FALLBACK_MODELS].filter(Boolean))].slice(0, 4);
}

/** 응답이 늦거나 붐빔(과부하·일시 오류)으로 볼 상태 */
const BUSY = new Set([500, 502, 503, 504, 524]);

async function callGemini(env, base64) {
  const models = await candidateModels(env);
  const started = Date.now();
  const attemptMs = num(env.ATTEMPT_TIMEOUT_MS, 25000); // 모델 하나를 기다리는 최대 시간
  const budgetMs = num(env.TOTAL_BUDGET_MS, 55000); // 전체 최대 대기 (사용자가 1분 넘게 기다리지 않게)
  const minLeft = Math.min(8000, attemptMs / 3);
  // 큰 base64 문자열을 다시 JSON 으로 만들지 않고 이어 붙임 (무료 플랜 CPU 시간 절약)
  const body =
    '{"contents":[{"parts":[{"text":' +
    JSON.stringify(PROMPT) +
    '},{"inline_data":{"mime_type":"image/jpeg","data":"' +
    base64 +
    '"}}]}],"generationConfig":{"temperature":0,"maxOutputTokens":2048}}';
  let lastErr = null;
  let quotaErr = null;
  let allBusy = true;
  for (const model of models) {
    const left = budgetMs - (Date.now() - started);
    if (left < minLeft) break; // 남은 시간이 부족하면 더 시도하지 않음
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(attemptMs, left));
    let res;
    let data;
    try {
      res = await fetch(`${env.GEMINI_BASE || GEMINI_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body,
        signal: ctrl.signal,
      });
      data = await res.json().catch(() => ({}));
    } catch (err) {
      // 시간 초과(또는 연결 실패) → 다음 모델로
      const timedOut = ctrl.signal.aborted;
      console.log(JSON.stringify({ event: 'gemini', model, status: timedOut ? 'timeout' : 'network', ms: Date.now() - t0 }));
      lastErr = new UpstreamError(504, timedOut ? `${model} 응답 시간 초과` : `${model} 연결 실패`);
      if (cachedModel === model) cachedModel = null;
      continue;
    } finally {
      clearTimeout(timer);
    }
    // 진단용 로그 (npx wrangler tail 로 보임) — 사진·키·비밀번호는 남기지 않음
    console.log(JSON.stringify({ event: 'gemini', model, status: res.status, ms: Date.now() - t0 }));
    if (!res.ok) {
      // 모델이 없어졌거나(404) 무료 범위가 아니거나(403·429) 붐비면(503 등) 다음 모델로
      const msg = res.status === 404 ? `모델 ${model} 을(를) 찾을 수 없어요` : (data.error && data.error.message) || `HTTP ${res.status}`;
      lastErr = new UpstreamError(res.status, msg);
      if (res.status === 429) quotaErr = lastErr;
      if (!BUSY.has(res.status)) allBusy = false;
      if (cachedModel === model) cachedModel = null;
      continue;
    }
    const cand = (data.candidates || [])[0];
    if (!cand) {
      const reason = data.promptFeedback && data.promptFeedback.blockReason;
      throw new UpstreamError(502, reason ? `Gemini 가 사진을 거부했어요 (${reason})` : 'Gemini 응답이 비어 있어요');
    }
    const text = ((cand.content && cand.content.parts) || [])
      .map((p) => p.text || '')
      .join('')
      .trim();
    cachedModel = model; // 다음부터는 성공한 모델을 먼저 씀
    return { text, model, finishReason: cand.finishReason || null };
  }
  // 한도 초과가 한 번이라도 있었으면 그것을, 모두 느리거나 붐볐으면 '바쁨'을 알림
  if (quotaErr) throw quotaErr;
  if (lastErr && allBusy) throw new UpstreamError(503, lastErr.message);
  throw lastErr || new UpstreamError(503, 'Gemini 가 제시간에 응답하지 않았어요');
}

/* ---------------- 요청 처리 ---------------- */
async function handle(request, env, cors) {
  const url = new URL(request.url);

  if (url.pathname === '/health' && request.method === 'GET') {
    // 키가 실제로 통하는지 모델 목록 조회로 확인 (키 값은 절대 내보내지 않음)
    let keyCheck = null;
    if (env.GEMINI_API_KEY) {
      try {
        const res = await fetch(`${env.GEMINI_BASE || GEMINI_BASE}/v1beta/models?pageSize=1000`, {
          headers: { 'x-goog-api-key': env.GEMINI_API_KEY },
        });
        const data = await res.json().catch(() => ({}));
        keyCheck = res.ok
          ? { ok: true, models: (data.models || []).length }
          : { ok: false, status: res.status, error: (data.error && data.error.message) || `HTTP ${res.status}` };
      } catch (err) {
        keyCheck = { ok: false, error: err.message };
      }
    }
    return json(
      {
        ok: true,
        configured: {
          geminiKey: !!env.GEMINI_API_KEY,
          passwords: parsePasswords(env).length,
          usageStore: !!env.OCR_USAGE,
        },
        keyCheck,
        model: env.GEMINI_API_KEY ? await resolveModel(env) : null,
      },
      200,
      cors,
    );
  }

  if (!env.GEMINI_API_KEY || !env.OCR_USAGE || !parsePasswords(env).length) {
    return json({ error: '중계 서버 설정이 끝나지 않았어요 (키·비밀번호·KV 확인)', code: 'not_configured' }, 503, cors);
  }

  if (url.pathname === '/usage' && request.method === 'GET') {
    const user = await authenticate(request, env);
    if (!user) {
      await sleep(600); // 비밀번호 마구 넣어 보기 늦추기
      return json({ error: '비밀번호가 맞지 않아요', code: 'auth' }, 401, cors);
    }
    return json({ user, usage: await readUsage(env, user) }, 200, cors);
  }

  if (url.pathname === '/ocr' && request.method === 'POST') {
    const user = await authenticate(request, env);
    if (!user) {
      await sleep(600);
      return json({ error: '비밀번호가 맞지 않아요', code: 'auth' }, 401, cors);
    }
    const base64 = (await request.text()).trim();
    if (!base64) return json({ error: '사진이 비어 있어요', code: 'bad_image' }, 400, cors);
    if (base64.length > num(env.MAX_IMAGE_BASE64, 4000000)) {
      return json({ error: '사진이 너무 커요', code: 'too_large' }, 413, cors);
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return json({ error: '사진 형식이 올바르지 않아요', code: 'bad_image' }, 400, cors);

    let usage = await readUsage(env, user);
    if (usage.total.used >= usage.total.limit) {
      return json({ error: '오늘 전체 AI 사용 한도를 다 썼어요. 내일 다시 써 주세요.', code: 'limit_total', usage }, 429, cors);
    }
    if (usage.user.used >= usage.user.limit) {
      return json({ error: `오늘 쓸 수 있는 AI 횟수(${usage.user.limit}회)를 다 썼어요.`, code: 'limit_user', usage }, 429, cors);
    }
    usage = await countUse(env, user, usage); // 호출 전에 셈 (실패해도 되돌리지 않음 — 남용 방지)

    try {
      const r = await callGemini(env, base64);
      return json({ text: r.text, model: r.model, finishReason: r.finishReason, usage }, 200, cors);
    } catch (err) {
      // Gemini 쪽 실패는 횟수에서 빼 줌 (사용자 잘못이 아니므로)
      usage = await refundUse(env, user, usage).catch(() => usage);
      const status = err instanceof UpstreamError ? err.status : 0;
      if (status === 429) {
        return json({ error: 'Gemini 무료 한도를 다 썼어요. 잠시 뒤나 내일 다시 써 주세요.', code: 'gemini_quota', usage }, 429, cors);
      }
      if (status === 503 || status === 504) {
        return json(
          {
            error: "Gemini 서버가 지금 바빠요(응답 지연·과부하). 잠시 뒤 다시 해 보거나 기본 '인식하기'를 써 주세요.",
            code: 'gemini_busy',
            usage,
          },
          503,
          cors,
        );
      }
      return json({ error: `Gemini 오류: ${err.message}`, code: 'upstream', upstreamStatus: status, usage }, 502, cors);
    }
  }

  return json({ error: '없는 주소예요', code: 'not_found' }, 404, cors);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = allowedOrigin(origin, env);
    const cors = corsHeaders(allowed);
    if (request.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    // 브라우저에서 온 요청은 병음 사전 사이트에서만 허용 (curl 등은 비밀번호로 막음)
    if (origin && !allowed) return json({ error: '허용되지 않은 사이트예요', code: 'origin' }, 403, cors);
    try {
      return await handle(request, env, cors);
    } catch (err) {
      return json({ error: `중계 서버 오류: ${err.message}`, code: 'internal' }, 500, cors);
    }
  },
};
