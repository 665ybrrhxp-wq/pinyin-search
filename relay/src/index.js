/**
 * 병음 사전 — 사진 속 한자 AI 인식 중계 서버 (Cloudflare Worker)
 *
 *   브라우저(병음 사전) ──비밀번호──▶ 이 Worker ──API 키──▶ Claude (주) / Google Gemini (예비)
 *
 * API 키는 이 Worker 의 비밀값으로만 존재하고, 공개 사이트 코드에는 들어가지 않는다.
 * 아는 사람만 쓰도록 비밀번호를 확인하고, 하루 사용량(전체·사람별)에 상한을 둔다.
 * 사진은 저장하지 않는다 (AI 로 전달만 함).
 *
 * 비밀값 (npx wrangler secret put …)
 *   ANTHROPIC_API_KEY Claude Console 에서 받은 키 (있으면 Claude 가 먼저 읽음)
 *   GEMINI_API_KEY    Google AI Studio 에서 받은 키 (Claude 가 바쁘거나 실패할 때 예비)
 *   ACCESS_PASSWORDS  "이름:비밀번호,이름:비밀번호" (이름 없이 "비밀번호" 하나만 써도 됨)
 * 설정값 (wrangler.toml [vars])
 *   AI_PROVIDERS(시도 순서, 기본 "claude,gemini"), CLAUDE_MODEL(기본 claude-sonnet-5-5), CLAUDE_EFFORT(기본 low),
 *   CLAUDE_TIMEOUT_MS(기본 45초), ALLOWED_ORIGINS, DAILY_LIMIT_TOTAL, DAILY_LIMIT_PER_USER,
 *   GEMINI_MODEL(비우면 MODEL_PLAN 순서), MAX_IMAGE_BASE64, ATTEMPT_TIMEOUT_MS(Gemini 모델당 25초), TOTAL_BUDGET_MS(전체 55초)
 * 저장소 (wrangler.toml [[kv_namespaces]])
 *   OCR_USAGE         하루 사용량 카운터 (3일 뒤 자동 삭제)
 *
 * 주소
 *   GET  /health   설정 상태·사용 모델 확인 (비밀번호 불필요, 비밀값은 내보내지 않음)
 *   GET  /usage    비밀번호 확인 + 오늘 남은 횟수
 *   POST /ocr      본문 = JPEG 의 base64 문자열(text/plain), 헤더 X-Access-Password
 *   POST /eval?model=…  모델 비교 평가용 (EVAL_DAILY_LIMIT 를 켰을 때만). 허용된 Claude 모델 하나로만 읽고
 *                  걸린 시간·토큰 수를 돌려줌. 예비 공급자로 넘기지 않으며, 일반 사용 횟수와 따로 셈
 */
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
} from '@anthropic-ai/sdk';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-5-5';
/** /eval 에서 비교할 수 있는 모델 (이 밖의 이름은 거절) */
const EVAL_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
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

/**
 * 시도할 모델과 사고(thinking) 수준 — Google AI Studio 문서(2026-11) 기준, 무료·안정(Stable) 모델만.
 *  - 3.x Flash 는 thinkingLevel 을 안 주면 'medium' 으로 오래 생각해서 느림 → 가장 낮게 지정
 *  - 3.8-flash 는 'minimal' 을 지원하지 않아 'low'
 *  - 3.7-flash·3.5-flash 는 폐기되어 3.8·3.6 으로 연결되므로 넣지 않음 (같은 모델을 두 번 부르게 됨)
 *  - 정확도를 위해 일반 Flash 를 먼저, 붐빌 때를 대비해 다른 계열(Lite)을 사이에 섞음
 */
const MODEL_PLAN = [
  { model: 'gemini-3.6-flash', thinkingLevel: 'minimal' },
  { model: 'gemini-3.5-flash-lite', thinkingLevel: 'minimal' },
  { model: 'gemini-3.8-flash', thinkingLevel: 'low' },
  { model: 'gemini-3.1-flash-lite', thinkingLevel: 'minimal' },
];

function thinkingLevelFor(model) {
  const plan = MODEL_PLAN.find((p) => p.model === model);
  if (plan) return plan.thinkingLevel;
  if (/lite/i.test(model)) return 'minimal';
  if (/gemini-3\.8/i.test(model)) return 'low';
  return null; // 모르는 모델은 기본값 그대로 (잘못된 값으로 400 이 나지 않게)
}

/** 첫 번째로 쓸 모델 (/health 표시용) */
async function resolveModel(env) {
  return env.GEMINI_MODEL || cachedModel || MODEL_PLAN[0].model;
}

/** 시도할 모델 순서 (최대 4개): 고정 설정 → 최근 성공 → 계획 순서 */
async function candidateModels(env) {
  return [...new Set([env.GEMINI_MODEL, cachedModel, ...MODEL_PLAN.map((p) => p.model)].filter(Boolean))].slice(0, 4);
}

/** 응답이 늦거나 붐빔(과부하·일시 오류)으로 볼 상태 */
const BUSY = new Set([500, 502, 503, 504, 524]);

async function callGemini(env, base64, budgetLimitMs = Infinity) {
  const models = await candidateModels(env);
  const started = Date.now();
  const attemptMs = num(env.ATTEMPT_TIMEOUT_MS, 25000); // 모델 하나를 기다리는 최대 시간
  // 전체 최대 대기 (사용자가 1분 넘게 기다리지 않게) — Claude 를 먼저 시도했으면 남은 시간만
  const budgetMs = Math.min(num(env.TOTAL_BUDGET_MS, 55000), budgetLimitMs);
  const minLeft = Math.min(8000, attemptMs / 3);
  // 큰 base64 문자열을 다시 JSON 으로 만들지 않고 이어 붙임 (무료 플랜 CPU 시간 절약)
  // temperature 는 3.x 에서 샘플링 설정이 제거되어 400 이 날 수 있어 보내지 않음
  const head = '{"contents":[{"role":"user","parts":[{"text":' + JSON.stringify(PROMPT) + '},{"inline_data":{"mime_type":"image/jpeg","data":"';
  const bodyFor = (model) => {
    const level = thinkingLevelFor(model);
    const gen = level
      ? `{"thinkingConfig":{"thinkingLevel":"${level}"},"maxOutputTokens":4096}`
      : '{"maxOutputTokens":4096}';
    return head + base64 + '"}}]}],"generationConfig":' + gen + '}';
  };
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
        body: bodyFor(model),
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

/* ---------------- Claude (Anthropic) ---------------- */
function claudeClient(env, timeoutMs) {
  // 재시도는 이 서버가 공급자를 바꿔 가며 직접 하므로 SDK 자동 재시도는 끔 (대기 시간이 길어지지 않게)
  return new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: env.ANTHROPIC_BASE_URL || undefined,
    maxRetries: 0,
    timeout: timeoutMs,
  });
}

async function callClaude(env, base64, timeoutMs, modelOverride) {
  const model = modelOverride || env.CLAUDE_MODEL || CLAUDE_DEFAULT_MODEL;
  const t0 = Date.now();
  try {
    // 안전 분류기가 거절하면 같은 요청을 서버에서 다른 모델로 이어서 처리 (Anthropic 권장 기본값)
    // Haiku 는 서버 측 fallback 을 지원하지 않아 뺌
    const fallback = /haiku/i.test(model) ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
    const response = await claudeClient(env, timeoutMs).beta.messages.create({
      model,
      max_tokens: 16000,
      ...fallback,
      // 글자 옮겨 적기는 단순한 일이라 낮은 effort 로 빠르고 저렴하게
      output_config: { effort: env.CLAUDE_EFFORT || 'low' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    });
    const u = response.usage || {};
    // 진단용 로그 — 사진·키·비밀번호는 남기지 않음 (토큰 수는 비용 확인용)
    console.log(
      JSON.stringify({ event: 'claude', model: response.model, status: 200, ms: Date.now() - t0, in: u.input_tokens, out: u.output_tokens, stop: response.stop_reason }),
    );
    if (response.stop_reason === 'refusal') throw new UpstreamError(422, 'AI 가 이 사진은 읽을 수 없다고 했어요');
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    const servedByFallback = (u.iterations || []).some((it) => it && it.type === 'fallback_message');
    return {
      text,
      model: response.model,
      finishReason: response.stop_reason,
      ms: Date.now() - t0,
      tokens: { input: u.input_tokens || 0, output: u.output_tokens || 0 },
      fallback: servedByFallback,
    };
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    const timedOut = err instanceof APIConnectionTimeoutError;
    console.log(JSON.stringify({ event: 'claude', model, status: err.status || (timedOut ? 'timeout' : 'network'), ms: Date.now() - t0 }));
    // 가장 구체적인 오류부터 (OverloadedError·5xx 는 InternalServerError 계열)
    if (timedOut) throw new UpstreamError(504, 'Claude 응답 시간 초과');
    if (err instanceof RateLimitError) throw new UpstreamError(429, 'Claude 사용 한도에 걸렸어요');
    if (err instanceof InternalServerError) throw new UpstreamError(503, 'Claude 서버가 바빠요');
    if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
      throw new UpstreamError(401, 'Claude API 키를 확인해 주세요');
    }
    if (err instanceof BadRequestError) throw new UpstreamError(400, `Claude 요청 오류: ${err.message}`);
    if (err instanceof APIConnectionError) throw new UpstreamError(502, 'Claude 에 연결하지 못했어요');
    throw new UpstreamError(502, `Claude 오류: ${err.message}`);
  }
}

/* ---------------- 공급자 순서 ---------------- */
function providerOrder(env) {
  const has = { claude: !!env.ANTHROPIC_API_KEY, gemini: !!env.GEMINI_API_KEY };
  return [
    ...new Set(
      String(env.AI_PROVIDERS || 'claude,gemini')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter((p) => has[p]),
    ),
  ];
}

/**
 * 공급자를 차례로 시도: 바쁨·시간 초과·한도·키 문제면 다음 공급자로.
 * 단 AI 가 내용을 이유로 거절(422)했으면 같은 사진을 다른 곳에 다시 보내지 않음.
 */
async function callAI(env, base64) {
  const started = Date.now();
  const budget = num(env.TOTAL_BUDGET_MS, 55000);
  let lastErr = null;
  for (const p of providerOrder(env)) {
    const left = budget - (Date.now() - started);
    if (lastErr && left < 5000) break;
    try {
      if (p === 'claude') return await callClaude(env, base64, Math.min(num(env.CLAUDE_TIMEOUT_MS, 45000), left));
      if (p === 'gemini') return await callGemini(env, base64, left);
    } catch (err) {
      if (err instanceof UpstreamError && err.status === 422) throw err;
      lastErr = err;
    }
  }
  throw lastErr || new UpstreamError(503, 'AI 가 제시간에 응답하지 않았어요');
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
    // Claude 키 점검: 모델 정보 조회 (토큰을 쓰지 않음)
    let claude = null;
    if (env.ANTHROPIC_API_KEY) {
      const model = env.CLAUDE_MODEL || CLAUDE_DEFAULT_MODEL;
      try {
        const info = await claudeClient(env, 10000).models.retrieve(model);
        claude = { model, keyCheck: { ok: true, displayName: info.display_name || null } };
      } catch (err) {
        claude = { model, keyCheck: { ok: false, status: err.status || null, error: err.message } };
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
        providers: providerOrder(env),
        claude,
        keyCheck,
        model: env.GEMINI_API_KEY ? await resolveModel(env) : null,
      },
      200,
      cors,
    );
  }

  if (!providerOrder(env).length || !env.OCR_USAGE || !parsePasswords(env).length) {
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
      const r = await callAI(env, base64);
      return json({ text: r.text, model: r.model, finishReason: r.finishReason, usage }, 200, cors);
    } catch (err) {
      // AI 쪽 실패는 횟수에서 빼 줌 (사용자 잘못이 아니므로)
      usage = await refundUse(env, user, usage).catch(() => usage);
      const status = err instanceof UpstreamError ? err.status : 0;
      if (status === 422) return json({ error: err.message, code: 'refused', usage }, 422, cors);
      if (status === 429) {
        return json({ error: 'AI 사용 한도에 걸렸어요. 잠시 뒤나 내일 다시 써 주세요.', code: 'ai_quota', usage }, 429, cors);
      }
      if (status === 503 || status === 504) {
        return json(
          {
            error: "AI 서버가 지금 바빠요(응답 지연·과부하). 잠시 뒤 다시 해 보거나 기본 '인식하기'를 써 주세요.",
            code: 'ai_busy',
            usage,
          },
          503,
          cors,
        );
      }
      return json({ error: `AI 오류: ${err.message}`, code: 'upstream', upstreamStatus: status, usage }, 502, cors);
    }
  }

  if (url.pathname === '/eval' && request.method === 'POST') {
    const limit = Number(env.EVAL_DAILY_LIMIT) || 0;
    if (!limit || !env.ANTHROPIC_API_KEY) return json({ error: '평가 기능이 꺼져 있어요', code: 'eval_off' }, 404, cors);
    const user = await authenticate(request, env);
    if (!user) {
      await sleep(600);
      return json({ error: '비밀번호가 맞지 않아요', code: 'auth' }, 401, cors);
    }
    const model = url.searchParams.get('model') || '';
    if (!EVAL_MODELS.includes(model)) return json({ error: '평가할 수 없는 모델이에요', code: 'bad_model', models: EVAL_MODELS }, 400, cors);
    const base64 = (await request.text()).trim();
    if (!base64 || base64.length > num(env.MAX_IMAGE_BASE64, 4000000) || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      return json({ error: '사진 형식이 올바르지 않아요', code: 'bad_image' }, 400, cors);
    }
    const key = `${today()}:eval:${user}`;
    const used = Number(await env.OCR_USAGE.get(key)) || 0;
    if (used >= limit) return json({ error: `오늘 평가 횟수(${limit}회)를 다 썼어요`, code: 'limit_eval', used, limit }, 429, cors);
    await env.OCR_USAGE.put(key, String(used + 1), { expirationTtl: 3 * 24 * 3600 });
    try {
      const r = await callClaude(env, base64, num(env.EVAL_TIMEOUT_MS, 90000), model);
      return json({ requested: model, ...r, eval: { used: used + 1, limit } }, 200, cors);
    } catch (err) {
      const status = err instanceof UpstreamError ? err.status : 0;
      return json({ requested: model, error: err.message, code: 'upstream', upstreamStatus: status, eval: { used: used + 1, limit } }, 502, cors);
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
