'use strict';

const { after, afterEach, before, beforeEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');

const GEMINI_BASE = 'https://gemini.test';
const CLAUDE_BASE = 'https://claude.test';
const CLAUDE_MODEL = 'claude-opus-5-5';
const MODEL = 'gemini-9.0-flash'; // 고정 설정(GEMINI_MODEL)으로 쓰는 시험용 모델
const PLAN = ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-3.1-flash-lite'];
const ORIGIN = 'https://665ybrrhxp-wq.github.io';
const TRANSCRIPTION = '我每天早上七点起床';

function fakeKV() {
  const map = new Map();
  const puts = [];
  return {
    map,
    puts,
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async put(key, value, opts) {
      puts.push({ key, value, opts });
      map.set(key, String(value));
    },
  };
}

function env(overrides = {}) {
  return {
    GEMINI_API_KEY: 'k-test',
    ACCESS_PASSWORDS: 'me:pw-one,friend:pw-two',
    OCR_USAGE: fakeKV(),
    ALLOWED_ORIGINS: `${ORIGIN},http://localhost:3939`,
    DAILY_LIMIT_TOTAL: '3',
    DAILY_LIMIT_PER_USER: '2',
    GEMINI_MODEL: '',
    MAX_IMAGE_BASE64: '1000',
    GEMINI_BASE,
    ...overrides,
  };
}

function req(path, { method = 'GET', origin, password, body } = {}) {
  const headers = new Headers();
  if (origin !== undefined) headers.set('Origin', origin);
  if (password !== undefined) headers.set('X-Access-Password', password);
  if (body !== undefined) headers.set('Content-Type', 'text/plain');
  return new Request(`https://relay.test${path}`, { method, headers, body });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function successResponse() {
  return jsonResponse({
    candidates: [{ content: { parts: [{ text: TRANSCRIPTION }] }, finishReason: 'STOP' }],
  });
}

function claudeSuccessResponse(overrides = {}) {
  return jsonResponse({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: CLAUDE_MODEL,
    content: [{ type: 'text', text: TRANSCRIPTION }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 40 },
    ...overrides,
  });
}

function claudeErrorResponse(status, type, message) {
  return jsonResponse({ type: 'error', error: { type, message } }, status);
}

// Keep this suite sequential: fetch and the worker's model cache are shared.
describe('Cloudflare OCR relay (offline)', { concurrency: false }, () => {
  let worker;
  let originalFetch;
  let requests;
  let unexpectedRequests;
  let generate;
  let claude;

  before(async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const request = {
        url: url.href,
        method: (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase(),
        headers: new Headers(init.headers || (input instanceof Request ? input.headers : undefined)),
        body: init.body !== undefined ? init.body : input instanceof Request ? await input.text() : null,
        signal: init.signal || (input instanceof Request ? input.signal : undefined),
      };
      requests.push(request);
      if (url.origin === CLAUDE_BASE) return claude(request);
      // Never delegate to the original fetch, including on an unexpected URL.
      if (url.origin !== GEMINI_BASE) {
        unexpectedRequests.push(request);
        throw new Error(`Network access forbidden: ${url.href}`);
      }
      if (request.method === 'GET' && url.pathname === '/v1beta/models' && url.search) {
        if (request.headers.get('x-goog-api-key') === 'bad-key') {
          return jsonResponse({ error: { message: 'API key not valid. Please pass a valid API key.' } }, 400);
        }
        return jsonResponse({
          models: [
            { name: 'models/gemini-9.0-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-9.0-flash-lite', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemini-9.0-pro', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/text-embedding-9', supportedGenerationMethods: ['embedContent'] },
          ],
        });
      }
      const match = /^\/v1beta\/models\/([^/]+):generateContent$/.exec(url.pathname);
      if (request.method === 'POST' && match) {
        return generate(decodeURIComponent(match[1]), request);
      }
      unexpectedRequests.push(request);
      throw new Error(`Unexpected Gemini request: ${request.method} ${url.href}`);
    };
    worker = (await import('../relay/src/index.js')).default;
  });

  beforeEach(() => {
    requests = [];
    unexpectedRequests = [];
    generate = () => successResponse();
    claude = (request) => {
      const url = new URL(request.url);
      // SDK 1.9.0 sends /v1/messages without a beta query; the beta is a header.
      if (request.method === 'POST' && url.pathname === '/v1/messages') {
        return claudeSuccessResponse();
      }
      if (request.method === 'GET' && url.pathname === `/v1/models/${CLAUDE_MODEL}`) {
        return jsonResponse({
          type: 'model', id: CLAUDE_MODEL, display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z',
        });
      }
      unexpectedRequests.push(request);
      throw new Error(`Unexpected Claude request: ${request.method} ${url.href}`);
    };
  });

  afterEach(() => {
    // The worker catches upstream exceptions, so also assert outside its catch.
    assert.deepEqual(unexpectedRequests, [], 'No unexpected or real-network URLs may be requested');
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  const ocr = (settings, password = 'pw-one', body = 'QUJD') =>
    worker.fetch(req('/ocr', { method: 'POST', origin: ORIGIN, password, body }), settings);
  const generatedModels = () => requests
    .filter((request) => request.method === 'POST' && new URL(request.url).origin === GEMINI_BASE)
    .map((request) => decodeURIComponent(new URL(request.url).pathname.match(/\/models\/(.*):generateContent$/)[1]));
  const claudeRequests = () => requests.filter((request) => new URL(request.url).origin === CLAUDE_BASE);
  const claudeEnv = (overrides = {}) => env({
    ANTHROPIC_API_KEY: 'a-test', ANTHROPIC_BASE_URL: CLAUDE_BASE, ...overrides,
  });

  async function assertError(response, status, code) {
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    assert.equal(data.code, code);
    return data;
  }

  for (const origin of [ORIGIN, 'http://localhost:3939']) {
    test(`OPTIONS accepts allowed origin ${origin}`, async () => {
      const response = await worker.fetch(req('/ocr', { method: 'OPTIONS', origin }), env());
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
      assert.match(response.headers.get('Access-Control-Allow-Headers'), /\bX-Access-Password\b/i);
      assert.equal(requests.length, 0);
    });
  }

  test('OPTIONS rejects an unlisted origin without an ACAO header', async () => {
    const response = await worker.fetch(req('/ocr', { method: 'OPTIONS', origin: 'https://evil.example' }), env());
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(requests.length, 0);
  });

  test('POST /ocr rejects an unlisted origin even with a valid password', async () => {
    const settings = env();
    const response = await worker.fetch(req('/ocr', {
      method: 'POST', origin: 'https://evil.example', password: 'pw-one', body: 'QUJD',
    }), settings);
    await assertError(response, 403, 'origin');
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    assert.equal(settings.OCR_USAGE.puts.length, 0);
    assert.equal(requests.length, 0);
  });

  // Run auto-selection before any successful OCR call can populate cachedModel.
  // All subsequent OCR tests pin GEMINI_MODEL to avoid order-dependent selection.
  test('GET /health reports safe configuration and the first planned model', async () => {
    const settings = env({ GEMINI_MODEL: '' });
    const response = await worker.fetch(req('/health'), settings);
    const text = await response.text();
    assert.equal(response.status, 200);
    const data = JSON.parse(text);
    assert.deepEqual(data.configured, { geminiKey: true, passwords: 2, usageStore: true });
    assert.equal(data.model, PLAN[0]);
    for (const secret of [settings.GEMINI_API_KEY, settings.ACCESS_PASSWORDS, 'pw-one', 'pw-two']) {
      assert.ok(!text.includes(secret), `Health response must not contain secret ${secret}`);
    }
    // 키 점검(모델 목록 조회) 1번
    assert.deepEqual(data.keyCheck, { ok: true, models: 4 });
    assert.equal(requests.length, 1);
    for (const r of requests) {
      assert.equal(r.method, 'GET');
      assert.equal(new URL(r.url).pathname, '/v1beta/models');
      assert.equal(r.headers.get('x-goog-api-key'), 'k-test');
      assert.ok(!r.url.includes('k-test'), 'API key belongs in the header, not the URL');
    }
  });

  test('GET /health reports an invalid Gemini key without leaking it', async () => {
    const response = await worker.fetch(req('/health'), env({ GEMINI_API_KEY: 'bad-key', GEMINI_MODEL: MODEL }));
    const text = await response.text();
    assert.equal(response.status, 200);
    const data = JSON.parse(text);
    assert.equal(data.keyCheck.ok, false);
    assert.equal(data.keyCheck.status, 400);
    assert.match(data.keyCheck.error, /API key not valid/);
    assert.ok(!text.includes('bad-key'), 'Health response must not contain the key');
  });

  for (const [label, overrides] of [
    ['key', { GEMINI_API_KEY: '' }],
    ['KV', { OCR_USAGE: undefined }],
    ['passwords', { ACCESS_PASSWORDS: '' }],
  ]) {
    for (const [path, method] of [['/usage', 'GET'], ['/ocr', 'POST']]) {
      test(`${method} ${path} returns not_configured when missing ${label}`, async () => {
        const response = await worker.fetch(req(path, {
          method, password: 'pw-one', ...(method === 'POST' ? { body: 'QUJD' } : {}),
        }), env({ GEMINI_MODEL: MODEL, ...overrides }));
        await assertError(response, 503, 'not_configured');
        assert.equal(requests.length, 0);
      });
    }
    test(`GET /health remains available when missing ${label}`, async () => {
      const response = await worker.fetch(req('/health'), env({ GEMINI_MODEL: MODEL, ...overrides }));
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.deepEqual(data.configured, {
        geminiKey: label !== 'key', passwords: label === 'passwords' ? 0 : 2, usageStore: label !== 'KV',
      });
      assert.equal(data.model, label === 'key' ? null : MODEL);
      // 키가 있으면 키 점검용 모델 목록 조회 1번 (모델은 고정이라 자동 선택 조회는 없음)
      assert.equal(requests.length, label === 'key' ? 0 : 1);
      assert.equal(data.keyCheck === null, label === 'key');
    });
  }

  test('GET /usage rejects a wrong password', async () => {
    await assertError(await worker.fetch(req('/usage', { password: 'wrong-password' }), env()), 401, 'auth');
    assert.equal(requests.length, 0);
  });

  test('GET /usage identifies friend and reports fresh daily limits', async () => {
    const settings = env();
    const response = await worker.fetch(req('/usage', { password: 'pw-two' }), settings);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      user: 'friend', usage: { user: { used: 0, limit: 2 }, total: { used: 0, limit: 3 } },
    });
    assert.equal(settings.OCR_USAGE.puts.length, 0);
    assert.equal(requests.length, 0);
  });

  test('POST /ocr transcribes JPEG, sends the API header, and persists both counts for three days', async () => {
    const settings = env({ GEMINI_MODEL: MODEL });
    const response = await ocr(settings);
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.text, TRANSCRIPTION);
    assert.equal(data.model, MODEL);
    assert.equal(data.usage.user.used, 1);
    assert.equal(data.usage.total.used, 1);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
    assert.equal(requests.length, 1);
    const upstream = requests[0];
    assert.equal(upstream.method, 'POST');
    assert.equal(upstream.headers.get('x-goog-api-key'), 'k-test');
    assert.equal(upstream.headers.get('Content-Type'), 'application/json');
    assert.ok(!upstream.url.includes('k-test'));
    assert.match(upstream.body, /QUJD/);
    assert.match(upstream.body, /image\/jpeg/);
    const image = JSON.parse(upstream.body).contents[0].parts.find((part) => part.inline_data).inline_data;
    assert.deepEqual(image, { mime_type: 'image/jpeg', data: 'QUJD' });
    assert.equal(settings.OCR_USAGE.puts.length, 2);
    for (const { key, value, opts } of settings.OCR_USAGE.puts) {
      assert.match(key, /^\d{4}-\d{2}-\d{2}:(?:all|u:me)$/);
      assert.equal(value, '1');
      assert.equal(await settings.OCR_USAGE.get(key), '1');
      assert.deepEqual(opts, { expirationTtl: 259200 });
    }
    const usage = await worker.fetch(req('/usage', { password: 'pw-one' }), settings);
    assert.deepEqual((await usage.json()).usage, data.usage);
  });

  test('the third OCR call from the same user hits the per-user cap', async () => {
    const settings = env({ GEMINI_MODEL: MODEL });
    assert.equal((await ocr(settings)).status, 200);
    assert.equal((await ocr(settings)).status, 200);
    const data = await assertError(await ocr(settings), 429, 'limit_user');
    assert.equal(data.usage.user.used, 2);
    assert.equal(data.usage.total.used, 2);
    assert.equal(requests.length, 2, 'A capped request must not reach Gemini');
    assert.equal(settings.OCR_USAGE.puts.length, 4, 'A capped request must not increment KV');
  });

  test('the third OCR call across users hits the total cap', async () => {
    const settings = env({ GEMINI_MODEL: MODEL, DAILY_LIMIT_PER_USER: '10', DAILY_LIMIT_TOTAL: '2' });
    assert.equal((await ocr(settings, 'pw-one')).status, 200);
    assert.equal((await ocr(settings, 'pw-two')).status, 200);
    const data = await assertError(await ocr(settings, 'pw-two'), 429, 'limit_total');
    assert.equal(data.usage.user.used, 1);
    assert.equal(data.usage.total.used, 2);
    assert.equal(requests.length, 2);
    assert.equal(settings.OCR_USAGE.puts.length, 4);
  });

  for (const [label, body, status, code] of [
    ['empty image', '', 400, 'bad_image'],
    ['oversized image', 'A'.repeat(1004), 413, 'too_large'],
    ['invalid base64', 'not base64!!', 400, 'bad_image'],
  ]) {
    test(`POST /ocr rejects ${label} before counting or calling Gemini`, async () => {
      const settings = env({ GEMINI_MODEL: MODEL });
      await assertError(await ocr(settings, 'pw-one', body), status, code);
      assert.equal(settings.OCR_USAGE.puts.length, 0);
      assert.equal(requests.length, 0);
    });
  }

  test('a missing configured model falls back to the first planned model', async () => {
    generate = (model) => model === 'gone-model'
      ? jsonResponse({ error: { message: 'Model not found' } }, 404)
      : successResponse();
    const response = await ocr(env({ GEMINI_MODEL: 'gone-model' }));
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    // 404 다음에는 최근 성공 모델(이전 시험에서 기억됨) 또는 계획의 첫 모델로 넘어감
    assert.equal(generatedModels()[0], 'gone-model');
    assert.equal(generatedModels().length, 2);
    assert.equal(data.model, generatedModels()[1]);
    assert.ok([MODEL, PLAN[0]].includes(data.model));
    assert.equal(data.text, TRANSCRIPTION);
  });

  for (const [upstreamStatus, status, code] of [[429, 429, 'ai_quota'], [500, 503, 'ai_busy'], [400, 502, 'upstream']]) {
    test(`Gemini HTTP ${upstreamStatus} maps to ${status} ${code}`, async () => {
      generate = () => jsonResponse({ error: { message: `Canned HTTP ${upstreamStatus}` } }, upstreamStatus);
      const data = await assertError(await ocr(env({ GEMINI_MODEL: MODEL })), status, code);
      if (upstreamStatus === 400) assert.equal(data.upstreamStatus, 400);
      // 한도·서버 오류도 다음 모델로 넘어가 보고, 모두 실패하면 그 오류를 알림 (최대 4개)
      assert.deepEqual(generatedModels(), [MODEL, PLAN[0], PLAN[1], PLAN[2]]);
      // Gemini 쪽 실패는 횟수에서 빼 줌
      assert.equal(data.usage.user.used, 0);
      assert.equal(data.usage.total.used, 0);
    });
  }

  // 신호가 오면 끊기는, 응답 없는 요청
  const hang = (request) =>
    new Promise((_, reject) => {
      request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });

  test('a model that does not answer in time is skipped for the next one', async () => {
    generate = (model, request) => (model === MODEL ? hang(request) : successResponse());
    const started = Date.now();
    const response = await ocr(env({ GEMINI_MODEL: MODEL, ATTEMPT_TIMEOUT_MS: '60', TOTAL_BUDGET_MS: '2000' }));
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.model, PLAN[0]);
    assert.deepEqual(generatedModels(), [MODEL, PLAN[0]]);
    assert.ok(Date.now() - started < 1500, 'gave up on the hanging model quickly');
  });

  test('when every model hangs, it stops at the total time budget and reports busy with a refund', async () => {
    generate = (model, request) => hang(request);
    const started = Date.now();
    const data = await assertError(
      await ocr(env({ GEMINI_MODEL: MODEL, ATTEMPT_TIMEOUT_MS: '80', TOTAL_BUDGET_MS: '150' })),
      503,
      'ai_busy',
    );
    assert.ok(Date.now() - started < 1000, 'respects the total budget');
    assert.ok(generatedModels().length < 3, 'does not try every model after the budget is spent');
    assert.equal(data.usage.user.used, 0);
  });

  test('a model outside the free tier (429) falls back to the next model that works', async () => {
    generate = (model) =>
      model === MODEL ? jsonResponse({ error: { message: 'Quota exceeded, limit: 0' } }, 429) : successResponse();
    const response = await ocr(env({ GEMINI_MODEL: MODEL }));
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.model, PLAN[0]);
    assert.equal(data.text, TRANSCRIPTION);
    assert.deepEqual(generatedModels(), [MODEL, PLAN[0]]);
  });

  test('a Gemini prompt safety block returns 502 and includes SAFETY', async () => {
    generate = () => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } });
    const data = await assertError(await ocr(env({ GEMINI_MODEL: MODEL })), 502, 'upstream');
    assert.match(data.error, /SAFETY/);
    assert.deepEqual(generatedModels(), [MODEL]);
  });

  test('an unlabeled password authenticates as user1', async () => {
    const response = await worker.fetch(req('/usage', { password: 'solo-pass' }), env({ ACCESS_PASSWORDS: 'solo-pass' }));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.user, 'user1');
    assert.equal(data.usage.user.used, 0);
    assert.equal(requests.length, 0);
  });

  test('each planned model gets its documented thinking level and no temperature', async () => {
    generate = (model) => (model === PLAN[3] ? successResponse() : jsonResponse({ error: { message: 'busy' } }, 503));
    const response = await ocr(env({ GEMINI_MODEL: '', DAILY_LIMIT_PER_USER: '10', DAILY_LIMIT_TOTAL: '10' }));
    assert.equal(response.status, 200);
    const sent = requests.filter((r) => r.method === 'POST');
    const levelOf = (r) => (JSON.parse(r.body).generationConfig.thinkingConfig || {}).thinkingLevel;
    assert.deepEqual(sent.map((r) => decodeURIComponent(new URL(r.url).pathname.split('/').pop().replace(':generateContent', ''))), PLAN);
    assert.deepEqual(sent.map(levelOf), ['minimal', 'minimal', 'low', 'minimal']);
    for (const r of sent) assert.ok(!/temperature/.test(r.body), 'temperature must not be sent to 3.x models');
  });

  test('an unknown pinned model is sent without a thinking setting', async () => {
    const response = await ocr(env({ GEMINI_MODEL: 'gemini-9.0-flash' }));
    assert.equal(response.status, 200);
    const body = JSON.parse(requests.find((r) => r.method === 'POST').body);
    assert.equal(body.generationConfig.thinkingConfig, undefined);
  });

  test('Claude primary transcribes JPEG with fallback beta, low effort, and an API-key header', async () => {
    const response = await ocr(claudeEnv());
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.text, TRANSCRIPTION);
    assert.equal(data.model, CLAUDE_MODEL);
    assert.equal(data.finishReason, 'end_turn');
    assert.deepEqual(generatedModels(), [], 'Gemini must not run after Claude succeeds');
    assert.equal(claudeRequests().length, 1);
    const upstream = claudeRequests()[0];
    assert.equal(upstream.method, 'POST');
    assert.equal(upstream.url, `${CLAUDE_BASE}/v1/messages`);
    assert.match(upstream.headers.get('anthropic-beta') || '', /server-side-fallback-2026-07-01/);
    const body = JSON.parse(upstream.body);
    assert.equal(body.model, CLAUDE_MODEL);
    assert.equal(body.max_tokens, 16000);
    assert.equal(body.fallbacks, 'default');
    assert.equal(body.output_config.effort, 'low');
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, 'user');
    const image = body.messages[0].content.find((block) => block.type === 'image');
    assert.deepEqual(image.source, { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' });
    assert.ok(body.messages[0].content.some((block) => block.type === 'text' && block.text.length > 0));
    assert.ok(!/temperature/.test(upstream.body), 'temperature must not be sent to Claude');
    // 공식 SDK(1.9.0, API 버전 2026-10-21)는 API 키를 Authorization: Bearer 로 보냄 (client.mjs apiKeyAuth)
    assert.equal(upstream.headers.get('authorization'), 'Bearer a-test');
    assert.equal(upstream.headers.get('x-api-key'), null);
  });

  test('Claude sends configured model and effort overrides', async () => {
    const model = 'claude-sonnet-5-5';
    claude = () => claudeSuccessResponse({ model });
    const response = await ocr(claudeEnv({ CLAUDE_MODEL: model, CLAUDE_EFFORT: 'medium' }));
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.model, model);
    assert.equal(claudeRequests().length, 1);
    const body = JSON.parse(claudeRequests()[0].body);
    assert.equal(body.model, model);
    assert.equal(body.output_config.effort, 'medium');
    assert.deepEqual(generatedModels(), []);
  });

  for (const [status, type, message] of [
    [529, 'overloaded_error', 'Overloaded'],
    [401, 'authentication_error', 'Invalid API key'],
  ]) {
    test(`Claude HTTP ${status} falls back to Gemini without an SDK retry`, async () => {
      claude = () => claudeErrorResponse(status, type, message);
      const response = await ocr(claudeEnv());
      const data = await response.json();
      assert.equal(response.status, 200, JSON.stringify(data));
      assert.equal(data.text, TRANSCRIPTION);
      assert.match(data.model, /^gemini-/);
      assert.equal(claudeRequests().length, 1, 'maxRetries: 0 must disable SDK retries');
      assert.deepEqual(generatedModels(), [data.model]);
      assert.equal(new URL(requests[0].url).origin, CLAUDE_BASE, 'Claude must be tried first');
      assert.equal(data.usage.user.used, 1);
    });
  }

  test('Claude refusal stops provider fallback and refunds usage', async () => {
    claude = () => claudeSuccessResponse({ stop_reason: 'refusal' });
    const settings = claudeEnv();
    const data = await assertError(await ocr(settings), 422, 'refused');
    assert.deepEqual(generatedModels(), [], 'A refused image must not be sent to Gemini');
    assert.equal(claudeRequests().length, 1);
    assert.equal(data.usage.user.used, 0);
    assert.equal(data.usage.total.used, 0);
    const usage = await worker.fetch(req('/usage', { password: 'pw-one' }), settings);
    assert.deepEqual((await usage.json()).usage, data.usage, 'Refund must be persisted');
  });

  for (const [upstreamStatus, type, message, status, code] of [
    [529, 'overloaded_error', 'Overloaded', 503, 'ai_busy'],
    [429, 'rate_limit_error', 'Rate limited', 429, 'ai_quota'],
  ]) {
    test(`Claude-only HTTP ${upstreamStatus} returns ${status} ${code} with a refund`, async () => {
      claude = () => claudeErrorResponse(upstreamStatus, type, message);
      const data = await assertError(await ocr(claudeEnv({ AI_PROVIDERS: 'claude' })), status, code);
      assert.equal(claudeRequests().length, 1);
      assert.deepEqual(generatedModels(), []);
      assert.equal(data.usage.user.used, 0);
      assert.equal(data.usage.total.used, 0);
    });
  }

  test('provider order gemini,claude tries Gemini first and stops on success', async () => {
    const response = await ocr(claudeEnv({ AI_PROVIDERS: 'gemini,claude' }));
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.match(data.model, /^gemini-/);
    assert.deepEqual(generatedModels(), [data.model]);
    assert.deepEqual(claudeRequests(), []);
  });

  test('GET /usage works with only an Anthropic key configured', async () => {
    const response = await worker.fetch(req('/usage', { password: 'pw-one' }), claudeEnv({ GEMINI_API_KEY: '' }));
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.user, 'me');
    assert.equal(data.usage.user.used, 0);
    assert.equal(requests.length, 0);
  });

  test('GET /usage returns not_configured when neither provider has a key', async () => {
    await assertError(await worker.fetch(req('/usage', { password: 'pw-one' }), env({
      ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '',
    })), 503, 'not_configured');
    assert.equal(requests.length, 0);
  });

  test('GET /health checks the Claude model and reports providers without secrets', async () => {
    const settings = claudeEnv();
    const response = await worker.fetch(req('/health'), settings);
    const text = await response.text();
    assert.equal(response.status, 200);
    const data = JSON.parse(text);
    assert.deepEqual(data.providers, ['claude', 'gemini']);
    assert.equal(data.claude.model, CLAUDE_MODEL);
    assert.equal(data.claude.keyCheck.ok, true);
    assert.equal(data.claude.keyCheck.displayName, 'Claude Opus 5.5');
    for (const secret of [settings.ANTHROPIC_API_KEY, settings.GEMINI_API_KEY, settings.ACCESS_PASSWORDS, 'pw-one', 'pw-two']) {
      assert.ok(!text.includes(secret), `Health response must not contain secret ${secret}`);
    }
    assert.equal(claudeRequests().length, 1);
    assert.equal(claudeRequests()[0].method, 'GET');
    assert.equal(claudeRequests()[0].url, `${CLAUDE_BASE}/v1/models/${CLAUDE_MODEL}`);
    assert.equal(requests.length, 2, 'Health must check both providers');
  });

  test('GET /health reports Claude model authentication failure', async () => {
    claude = () => claudeErrorResponse(401, 'authentication_error', 'Invalid API key');
    const response = await worker.fetch(req('/health'), claudeEnv());
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const data = JSON.parse(text);
    assert.deepEqual(data.providers, ['claude', 'gemini']);
    assert.equal(data.claude.model, CLAUDE_MODEL);
    assert.equal(data.claude.keyCheck.ok, false);
    assert.equal(data.claude.keyCheck.status, 401);
    assert.equal(claudeRequests().length, 1);
    assert.equal(claudeRequests()[0].method, 'GET');
    assert.equal(claudeRequests()[0].url, `${CLAUDE_BASE}/v1/models/${CLAUDE_MODEL}`);
    for (const secret of ['a-test', 'k-test', 'pw-one', 'pw-two']) assert.ok(!text.includes(secret));
  });

  test('Claude-only timeout aborts fetch quickly and refunds usage', { timeout: 1500 }, async () => {
    let aborted = false;
    claude = (request) => {
      assert.ok(request.signal instanceof AbortSignal, 'SDK must forward its timeout AbortSignal');
      return new Promise((_, reject) => {
        const abort = () => {
          aborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        };
        if (request.signal.aborted) abort();
        else request.signal.addEventListener('abort', abort, { once: true });
      });
    };
    const started = Date.now();
    const data = await assertError(await ocr(claudeEnv({
      CLAUDE_TIMEOUT_MS: '80', AI_PROVIDERS: 'claude',
    })), 503, 'ai_busy');
    assert.ok(Date.now() - started < 1000, 'Claude timeout must finish within about one second');
    assert.ok(aborted, 'The hanging fetch must reject only after the SDK aborts it');
    assert.equal(claudeRequests().length, 1);
    assert.deepEqual(generatedModels(), []);
    assert.equal(data.usage.user.used, 0);
    assert.equal(data.usage.total.used, 0);
  });
});
