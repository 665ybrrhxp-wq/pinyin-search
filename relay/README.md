# AI 사진 인식 중계 서버 (Cloudflare Worker)

병음 사전의 **✨ AI로 읽기** 버튼이 쓰는 작은 서버입니다.
Gemini API 키를 공개 사이트에 넣지 않고 여기(Cloudflare 비밀값)에만 두고, 아는 사람만 비밀번호로 쓰게 합니다.

```
병음 사전(브라우저) ──비밀번호──▶ 이 Worker ──Gemini 키──▶ Google Gemini
```

- **비밀번호**: 사람마다 따로 줄 수 있음 (`이름:비밀번호` 여러 개). 한 명만 막고 싶으면 그 항목만 지우면 됨.
- **하루 상한**: 전체 `DAILY_LIMIT_TOTAL`(기본 100회), 한 사람 `DAILY_LIMIT_PER_USER`(기본 20회). 한국 날짜 기준으로 매일 초기화.
- **사진은 저장하지 않음** (Gemini 로 전달만). 단 Gemini **무료** 키는 Google 이 입력을 서비스 개선에 쓸 수 있음.
- 비용: Cloudflare Workers 무료 플랜 + Gemini 무료 사용분이면 0원. Google 프로젝트에 결제를 연결하지 않는 한 과금되지 않음.

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

## 바꾸고 싶을 때

| 하고 싶은 것 | 방법 |
|---|---|
| 비밀번호 추가·삭제 | `npx wrangler secret put ACCESS_PASSWORDS` 로 전체 목록을 다시 입력 |
| 하루 상한 변경 | `wrangler.toml` 의 `DAILY_LIMIT_*` 수정 → `npx wrangler deploy` |
| 모델 고정 | `GEMINI_MODEL = "gemini-…"` 입력 → deploy (비워 두면 최신 Flash 자동 선택) |
| 키 교체 | `npx wrangler secret put GEMINI_API_KEY` |
| 실시간 로그 | `npx wrangler tail` |

PC 에서 진짜 계정 없이 화면 흐름만 확인하려면 `node scripts/dev-relay.js` (가짜 Gemini, 비밀번호 `local-test-pass`).
