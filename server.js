'use strict';
/**
 * 로컬 실행용 정적 서버 — GitHub Pages 와 똑같이 docs/ 폴더의 파일만 보여 줌 (의존성 없음, Node 18+)
 *   node server.js          → http://localhost:3939
 *   node server.js --open   → 서버 시작 후 브라우저 열기
 * 환경변수: PORT(기본 3939), HOST(기본 127.0.0.1 — 같은 와이파이의 휴대폰에서 쓰려면 0.0.0.0)
 * 사전 데이터(docs/data)가 없으면 먼저 내려받아 만듦.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { build, REQUIRED_FILES, DATA_DIR } = require('./scripts/build-data');

const ROOT = path.join(__dirname, 'docs');
const PORT = Number(process.env.PORT) || 3939;
const HOST = process.env.HOST || '127.0.0.1';
const OPEN = process.argv.includes('--open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg', '.txt']);

function send(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'GET 만 지원합니다');
  let p;
  try {
    p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, '잘못된 경로');
  }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + path.sep)) return send(res, 403, '접근 불가');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, '찾을 수 없음');
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    // GitHub Pages 처럼 텍스트는 gzip 으로 보냄 (사전 데이터 15MB → 약 5.5MB)
    if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      buf = zlib.gzipSync(buf, { level: 6 });
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : buf);
  });
});

function openBrowser(url) {
  const cmd =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* 브라우저 열기 실패는 무시 */
  }
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`포트 ${PORT} 이(가) 이미 사용 중이에요. 서버가 이미 켜져 있을 수 있습니다 → http://localhost:${PORT}`);
    if (OPEN) openBrowser(`http://localhost:${PORT}`);
    process.exit(0);
  }
  throw err;
});

async function main() {
  const missing = REQUIRED_FILES.filter((f) => !fs.existsSync(path.join(DATA_DIR, f)));
  if (missing.length) {
    console.log(`[준비] 사전 데이터가 없어 내려받습니다(약 1분): ${missing.join(', ')}`);
    await build({ log: (m) => console.log('[build]', m) });
  }
  server.listen(PORT, HOST, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`병음 사전 실행 중 → ${url}  (종료: Ctrl+C)`);
    if (OPEN) openBrowser(url);
  });
}

main().catch((err) => {
  console.error('[준비 실패]', err);
  process.exit(1);
});
