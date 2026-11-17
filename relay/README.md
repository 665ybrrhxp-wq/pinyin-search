# AI 사진 인식 중계 서버 (Cloudflare Worker)

병음 사전의 **✨ AI로 읽기** 버튼이 쓰는 작은 서버입니다.
AI API 키를 공개 사이트에 넣지 않고 여기(Cloudflare 비밀값)에만 두고, 아는 사람만 비밀번호로 쓰게 합니다.
**Claude 가 먼저 읽고**(키가 있을 때), 붐비거나 실패하면 **Gemini 가 예비**로 읽습니다.

```
병음 사전(브라우저) ──비밀번호──▶ 이 Worker ──API 키──▶ Claude (주) / Google Gemini (예비)
```

- **비밀번호**: 사람마다 따로 줄 수 있음 (`이름:비밀번호` 여러 개). 한 명만 막고 싶으면 그 항목만 지우면 됨.
- **하루 상한**: 전체 `DAILY_LIMIT_TOTAL`(기본 100회), 한 사람 `DAILY_LIMIT_PER_USER`(기본 20회). 한국 날짜 기준으로 매일 초기화.
- **사진은 저장하지 않음** (AI 로 전달만). 단 Gemini **무료** 키로 처리될 때는 Google 이 입력을 서비스 개선에 쓸 수 있음.
- 비용: Cloudflare Workers 무료 플랜 + Claude API 크레딧(사진 1장 약 $0.02~0.03, Opus 5.5·effort low 추정 — 실제 토큰은 `npx wrangler tail` 로그의 in/out 으로 확인) + Gemini 무료 사용분.
  하루 상한(전체 100회)이 있어 최대 하루 약 $3. Claude Console 에서 월 사용 한도(spend limit)도 걸어 두면 안전.

## 처음 설정 (한 번만)

준비물: 구글 계정, Cloudflare 계정(무료), 이 저장소(`pinyin-search/relay` 폴더)

1. **Gemini API 키 받기** — https://aistudio.google.com/apikey 에서 *Create API key* → 키 복사 (남에게 보여 주지 말 것)
2. **Cloudflare 가입** — https://dash.cloudflare.com/sign-up (무료 플랜)
3. 터미널에서 `pinyin-search/relay` 폴더로 이동 후:

```bash
npx wrangler login
```
브라우저가 열리면 Cloudflare 로그인 → *Allow*.

```bash
npx wrangler kv namespace create OCR_USAGE
```
출력된 `id = "…"` 값을 `wrangler.toml` 의 `REPLACE_WITH_KV_NAMESPACE_ID` 자리에 넣기.

```bash
npx wrangler secret put GEMINI_API_KEY
```
물으면 1번에서 복사한 키를 붙여넣기.

```bash
npx wrangler secret put ACCESS_PASSWORDS
```
물으면 `나:긴비밀번호1,친구1:긴비밀번호2` 처럼 입력 (쉼표로 구분, 비밀번호에 쉼표는 못 씀, 12자 이상 추천).

```bash
npx wrangler deploy
```
마지막에 나오는 주소(예: `https://pinyin-ocr-relay.<내이름>.workers.dev`)를
`docs/lib/ocr.js` 의 `AI_RELAY_URL` 에 넣고 커밋·푸시하면 앱에 ✨ 버튼이 나타납니다.

확인: 브라우저에서 `<주소>/health` → `"geminiKey":true, "passwords":2, "usageStore":true` 와 사용할 모델 이름이 보이면 정상.

## Claude 연결 (선택, 권장)

1. https://platform.claude.com/settings/keys 에서 API 키 만들기 (크레딧이 있는 조직에서)
2. `relay` 폴더에서:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```
물으면 키를 붙여넣기. 확인: `<주소>/health` 에 `"claude":{"model":"claude-opus-5-5","keyCheck":{"ok":true…}}`.

모델·깊이는 `wrangler.toml` 의 `CLAUDE_MODEL`(opus-5-5 / sonnet-5-5 / haiku-5-5), `CLAUDE_EFFORT`(low/medium/high), 순서는 `AI_PROVIDERS`.

## 바꾸고 싶을 때

| 하고 싶은 것 | 방법 |
|---|---|
| 비밀번호 추가·삭제 | `npx wrangler secret put ACCESS_PASSWORDS` 로 전체 목록을 다시 입력 |
| 하루 상한 변경 | `wrangler.toml` 의 `DAILY_LIMIT_*` 수정 → `npx wrangler deploy` |
| Gemini 모델 고정 | `GEMINI_MODEL = "gemini-…"` 입력 → deploy (비워 두면 `src/index.js` 의 `MODEL_PLAN` 순서) |
| Claude 모델·깊이 | `CLAUDE_MODEL`, `CLAUDE_EFFORT` 수정 → deploy |
| 키 교체 | `npx wrangler secret put GEMINI_API_KEY` |
| 실시간 로그 | `npx wrangler tail` |

PC 에서 진짜 계정 없이 화면 흐름만 확인하려면 `node scripts/dev-relay.js` (가짜 Gemini, 비밀번호 `local-test-pass`).
