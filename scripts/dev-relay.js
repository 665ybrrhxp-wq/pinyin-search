'use strict';
/**
 * 로컬 점검용: relay/ 의 Worker 를 Node 에서 그대로 띄움 → http://localhost:8787
 *  - Gemini 는 가짜 응답(FAKE_TEXT), 사용량은 메모리에 저장 — 진짜 키·계정 없이 화면 흐름을 확인할 때 사용
 *  - 비밀번호: RELAY_PASSWORDS 환경변수 (기본 "tester:local-test-pass", 로컬 시험용 값)
 *  - 앱에서 쓰려면 브라우저 콘솔에서 window.PINYIN_AI_RELAY = 'http://localhost:8787' 후 📷
 */
const http = require('http');

(async () => {
  const worker = (await import('../relay/src/index.js')).default;
  const kv = new Map();
  const env = {
    GEMINI_API_KEY: 'local-fake-key',
    ACCESS_PASSWORDS: process.env.RELAY_PASSWORDS || 'tester:local-test-pass',
    OCR_USAGE: { get: async (k) => (kv.has(k) ? kv.get(k) : null), put: async (k, v) => void kv.set(k, v) },
    ALLOWED_ORIGINS: 'http://localhost:3939',
    DAILY_LIMIT_TOTAL: process.env.DAILY_LIMIT_TOTAL || '5',
    DAILY_LIMIT_PER_USER: process.env.DAILY_LIMIT_PER_USER || '3',
    GEMINI_MODEL: 'fake-gemini-flash',
    GEMINI_BASE: 'https://gemini.fake',
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('https://gemini.fake')) {
      // FAKE_DELAY_MS: 느린 응답 흉내 (기다리는 시간 표시·시간 제한 확인용)
      if (process.env.FAKE_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_DELAY_MS)));
      const text = process.env.FAKE_TEXT || '我每天早上七点起床，\n然后去公司上班。';
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(url, opts);
  };

  http
    .createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
      const request = new Request(`http://localhost:8787${req.url}`, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      const r = await worker.fetch(request, env);
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    })
    .listen(8787, () => console.log('dev relay → http://localhost:8787 (가짜 Gemini)'));
})();
