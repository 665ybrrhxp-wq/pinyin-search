# 병음 사전 (pinyin-search)

병음을 넣으면 중국어 단어를 **`한자 (병음·성조): 뜻`** 형식으로 보여 주고,
단어 속 한자마다 **훈음 · 부수(변/방/머리…) · 획수 · 구성 · 자원 · 획순**을 보여 주는 TSC 학습용 웹앱입니다.
서버 없이 브라우저 안에서만 동작해서 GitHub Pages 로 배포합니다.

```
喜欢 (xǐ huan): 기뻐하다, 좋아하다          HSK 1
  喜  xǐ   · 기쁠 희        부수 口 입 구 (아래·발) · 12획
  欢  huan · 기뻐할 환 (歡)  부수 欠 하품흠방 · 6획
```

## 쓰는 방법

- 웹 주소: **https://665ybrrhxp-wq.github.io/pinyin-search/**
- 아이폰: Safari 로 주소 열기 → 공유 → **홈 화면에 추가** → 앱처럼 실행
- 처음 한 번 사전 데이터(약 5.5MB)를 받고 나면 기기에 저장되어 **오프라인에서도 검색**됩니다.
  (한국어로 찾기 · 사전에 없는 단어의 자동 번역 · 입력기 순위만 인터넷이 필요)

| 입력 | 예 |
|---|---|
| 띄어쓰기 있어도/없어도 | `ben zi`, `benzi`, `xihuan` |
| 성조로 좁히기 (숫자·부호) | `pian2 yi`, `xi3 huan`, `xǐhuan` |
| ü 는 v | `lv se`, `nv er` (`lü`, `lu:` 도 가능) |
| 儿화 | `yidianr` |
| 애매한 분절은 둘 다 검색 | `xian` → 先·现 … + 西安 |
| 문장 (단어별로 나눠 풀이 + 문장 번역) | `wo jue de wo hai dei zai nu li` → 我 / 觉得 / 我 / 还 / 得(děi) / 再 / 努力 |
| 한자 직접 (단어) | `喜欢`, `喜歡` |
| 한자 한 글자 → 맨 위에 훈음·부수·획수·구성 카드 | `学` |
| 한자 문장 → 단어별로 나눠 풀이 (번체도 가능) | `我觉得我还得再努力`, `因為他很忙` |
| 한국어 | `좋아하다` → 喜欢 |
| 📷 사진 | 사진을 찍거나 고른 뒤 글자 부분을 끌어서 선택 → 인식 결과를 고쳐서 검색 (한글 섞인 교재는 체크) |
| ✨ AI로 읽기 | 손글씨·어두운 사진은 AI(Gemini)로 다시 읽기 — 비밀번호를 받은 사람만, 하루 횟수 제한 (설정: `relay/README.md`) |

- 카드의 🔊 발음 듣기, ⧉ `喜欢 (xǐ huan): 기뻐하다, 좋아하다` 형식으로 복사
- **글자 칩 클릭** → 훈음(번체 기준), 부수 이름과 위치, 총획/부수 외 획수, 구성 요소, 자원(상형·회의·형성),
  획순 애니메이션·따라 쓰기(부수 획은 색 표시), 그 글자가 들어간 단어
- 단축키: `/` 검색창, `Esc` 상세 닫기

## 구조

```
docs/                     ← GitHub Pages 가 그대로 서비스하는 웹앱 (빌드 과정 없음)
  index.html · app.js · style.css
  lib/pinyin.js           병음 정규화 · 음절 분절(xian → xian | xi an) · 성조 부호
  lib/dict.js             CC-CEDICT 색인 · 정렬 · 한자 정보 · 부수 위치 판정 (Node 에서도 동작 → 테스트)
  lib/service.js          데이터 불러오기·보관 · 무료 API 호출 · 결과 캐시 (예전 서버가 하던 일)
  lib/radicals.json       214부수 한국어 이름과 변형(亻 사람인변, 阝 좌부변/우부방 …)
  sw.js · manifest.webmanifest · icons/   오프라인 · 홈 화면 앱
  vendor/hanzi-writer.min.js              획순 애니메이션 (MIT)
  data/                   사전 데이터(아래 스크립트가 생성) + licenses/ 원본 라이선스
scripts/build-data.js     원본 데이터 내려받기·가공 → docs/data (+ meta.json 버전)
server.js · start.bat     PC 에서 실행할 때 쓰는 정적 서버 (docs 폴더를 그대로 보여 줌)
test/                     node:test
```

검색 흐름: 입력 → 음절 분절(+성조) → CC-CEDICT 에서 음절 키로 단어 찾기 →
Google 입력 도구 후보 순위(없으면 jieba 빈도·HSK·주된 발음 기준) → 한국어 뜻(위키낱말사전 → 없으면 무료 번역) →
글자별 정보(Unihan 부수·획수 · Make Me a Hanzi 구성·자원 · libhangul 훈음 · 부수표).

## 무료 API (키 필요 없음, 브라우저에서 직접 호출)

| 용도 | API | 실패하면 |
|---|---|---|
| 단어 후보 순위 | Google 입력 도구 `inputtools.google.com` | 사전 빈도순으로 정렬 |
| 사전에 없는 단어의 한국어 뜻 | Google 번역 `translate.googleapis.com` (gtx) | MyMemory API → 그래도 없으면 영어 뜻 |
| 한국어로 찾기 | Google 번역 (ko→zh) | — |
| 발음 | 기기 내장 중국어 음성 | Google TTS 음성 파일 |
| 획순 데이터 | hanzi-writer-data (jsDelivr CDN) | 획순 칸만 비어 있음 |

Google 엔드포인트는 공식 공개 API가 아니라 언제든 막힐 수 있습니다. 그래서 **핵심 기능(병음→단어, 성조, 영어 뜻,
한자 정보, 위키낱말사전 한국어 뜻)은 전부 기기에 저장된 데이터로 동작**하고, API는 순위·번역을 보강하는 데만 씁니다.
받은 결과는 기기(IndexedDB)에 저장해 같은 단어로 다시 호출하지 않습니다. 자동 번역으로 채운 뜻에는 `자동 번역` 표시가 붙습니다.

## PC 에서 실행 · 개발

| 명령 | 설명 |
|---|---|
| `start.bat` 더블클릭 또는 `npm start` | http://localhost:3939 로 실행하고 브라우저 열기 |
| `npm test` | 테스트 (node:test) |
| `npm run build-data` | 없는 데이터 파일만 생성 |
| `npm run rebuild-data` | 데이터 전부 새로 받기 → 커밋·푸시하면 기기에 저장된 사전도 자동으로 새로 받음 (`meta.json` 버전 기준) |

## 같은 주소의 TSC NOTE 와 함께 쓸 때

`665ybrrhxp-wq.github.io` 아래의 앱들은 브라우저 저장소를 공유합니다. 이 앱은 TSC NOTE 의 학습 데이터가 있는
localStorage 를 캐시로 쓰지 않고(검색 기록 몇 줄만 저장), 캐시 이름도 모두 `pinyin-search-` 로 시작해 자기 것만 지웁니다.
다만 TSC NOTE 의 `sw.js` 는 새 버전이 설치될 때 자기 것이 아닌 캐시를 모두 지우게 되어 있어서, TSC NOTE 의 `sw.js` 를 고치면
이 사전의 오프라인 사본이 한 번 지워질 수 있습니다(온라인에서 다시 열면 다시 받음).

## 데이터 출처

CC-CEDICT · Make Me a Hanzi · Unihan · libhangul 한자 사전 · 한국어 위키낱말사전 · complete-hsk-vocabulary · jieba ·
Hanzi Writer. 라이선스와 고지는 [DATA-LICENSES.md](DATA-LICENSES.md) 참고.
