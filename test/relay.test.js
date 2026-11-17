'use strict';

const { after, afterEach, before, beforeEach, describe, test } = require('node:test');
const assert = require('node:assert/strict');

const GEMINI_BASE = 'https://gemini.test';
const MODEL = 'gemini-9.0-flash';
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

// Keep this suite sequential: fetch and the worker's model cache are shared.
describe('Cloudflare OCR relay (offline)', { concurrency: false }, () => {
  let worker;
  let originalFetch;
  let requests;
  let unexpectedRequests;
  let generate;

  before(async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const request = {
        url: url.href,
        method: (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase(),
        headers: new Headers(init.headers || (input instanceof Request ? input.headers : undefined)),
        body: init.body !== undefined ? init.body : input instanceof Request ? await input.text() : null,
      };
      requests.push(request);
      // Never delegate to the original fetch, including on an unexpected URL.
      if (url.origin !== GEMINI_BASE) {
        unexpectedRequests.push(request);
        throw new Error(`Network access forbidden: ${url.href}`);
      }
      if (request.method === 'GET' && url.pathname === '/v1beta/models' && url.search) {
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
    .filter((request) => request.method === 'POST')
    .map((request) => decodeURIComponent(new URL(request.url).pathname.match(/\/models\/(.*):generateContent$/)[1]));

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
  test('GET /health reports safe configuration and automatically selects non-lite Flash', async () => {
    const settings = env({ GEMINI_MODEL: '' });
    const response = await worker.fetch(req('/health'), settings);
    const text = await response.text();
    assert.equal(response.status, 200);
    const data = JSON.parse(text);
    assert.deepEqual(data.configured, { geminiKey: true, passwords: 2, usageStore: true });
    assert.equal(data.model, MODEL);
    for (const secret of [settings.GEMINI_API_KEY, settings.ACCESS_PASSWORDS, 'pw-one', 'pw-two']) {
      assert.ok(!text.includes(secret), `Health response must not contain secret ${secret}`);
    }
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'GET');
    assert.equal(new URL(requests[0].url).pathname, '/v1beta/models');
    assert.equal(requests[0].headers.get('x-goog-api-key'), 'k-test');
    assert.ok(!requests[0].url.includes('k-test'), 'API key belongs in the header, not the URL');
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
      assert.equal(requests.length, 0);
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

  test('a missing configured model falls back to gemini-flash-latest', async () => {
    generate = (model) => model === 'gone-model'
      ? jsonResponse({ error: { message: 'Model not found' } }, 404)
      : successResponse();
    const response = await ocr(env({ GEMINI_MODEL: 'gone-model' }));
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.model, 'gemini-flash-latest');
    assert.equal(data.text, TRANSCRIPTION);
    assert.deepEqual(generatedModels(), ['gone-model', 'gemini-flash-latest']);
  });

  for (const [upstreamStatus, status, code] of [[429, 429, 'gemini_quota'], [500, 502, 'upstream']]) {
    test(`Gemini HTTP ${upstreamStatus} maps to ${status} ${code}`, async () => {
      generate = () => jsonResponse({ error: { message: `Canned HTTP ${upstreamStatus}` } }, upstreamStatus);
      const data = await assertError(await ocr(env({ GEMINI_MODEL: MODEL })), status, code);
      if (upstreamStatus === 500) assert.equal(data.upstreamStatus, 500);
      assert.deepEqual(generatedModels(), [MODEL], 'Do not retry quota or server errors as model fallback');
    });
  }

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
});
