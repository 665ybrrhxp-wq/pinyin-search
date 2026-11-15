# 데이터 출처와 라이선스

이 앱의 코드와 별개로, `docs/data/`, `docs/lib/radicals.json`, `docs/vendor/` 에 들어 있는 데이터와 라이브러리는
아래 원본에서 받아 가공한 것이며 각 원본의 라이선스를 따릅니다. 가공한 데이터도 같은 조건(표시·동일조건변경허락 등)으로 공개합니다.
원본 라이선스 전문은 [`docs/data/licenses/`](docs/data/licenses) 와 [`docs/vendor/`](docs/vendor) 에 있습니다.

| 데이터 | 원본 | 라이선스 | 앱에서의 용도 (파일) | 가공 내용 |
|---|---|---|---|---|
| CC-CEDICT | [MDBG](https://www.mdbg.net/chinese/dictionary?page=cc-cedict) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | 단어·병음·영어 뜻 (`cedict.json`) | 줄 형식을 JSON 배열로 변환 |
| Make Me a Hanzi `dictionary.txt` | [skishore/makemeahanzi](https://github.com/skishore/makemeahanzi) | LGPL-3.0-or-later (`licenses/makemeahanzi-COPYING.txt`) | 한자 뜻·분해·자원·부수 모양 (`mmah.json`) | 필요한 필드만 추림 |
| Unihan (Unicode 18.0) | [unicode.org](https://www.unicode.org/charts/unihan.html) | Unicode License v3 (`licenses/unicode-license.txt`) | 부수 번호·획수·한국 한자음·간체/번체 (`unihan.json`) | 필요한 글자·필드만 추림 |
| 한자 훈음 `hanja.txt` | [libhangul](https://github.com/libhangul/libhangul) (Choe Hwanjin) | BSD-3-Clause (`licenses/libhangul-hanja-LICENSE.txt`) | 훈음 (`hun.json`) | 한 글자 항목만 추림 |
| 한문 교육용 기초 한자 1800 | 한국어 위키낱말사전 부록 ([aliencube 스냅숏](https://github.com/aliencube/Hanja-for-Everyday-Use)) | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) | 대표 훈음을 맨 앞에 두는 순서 (`hun.json`) | 순서 정렬에만 사용 |
| 한국어 위키낱말사전 중국어 표제어 | [ko.wiktionary.org](https://ko.wiktionary.org) · [kaikki.org wiktextract](https://kaikki.org/kowiktionary/) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | 단어의 한국어 뜻 (`kowikt.json`) | 품사별 뜻만 추림 |
| complete-hsk-vocabulary | [drkameleon](https://github.com/drkameleon/complete-hsk-vocabulary) | MIT (`licenses/complete-hsk-vocabulary-LICENSE.txt`), 영어 뜻은 CC-CEDICT 유래 | HSK 등급·품사 (`hsk.json`) | 등급·품사·병음만 추림 |
| jieba `dict.txt` | [fxsjy/jieba](https://github.com/fxsjy/jieba) | MIT (`licenses/jieba-LICENSE.txt`) | 단어 빈도 (`freq.json`) | CC-CEDICT 표제어만 추림 |
| 214부수 한국어 이름표 | 한국어 위키백과 「[부수](https://ko.wikipedia.org/wiki/부수)」, Unicode `CJKRadicals.txt` 등을 정리 | CC BY-SA 4.0 (위키백과 유래 부분) | 부수 이름·변형 (`docs/lib/radicals.json`) | 표로 재구성 |
| Hanzi Writer 3.7.3 | [chanind/hanzi-writer](https://github.com/chanind/hanzi-writer) | MIT (`docs/vendor/hanzi-writer-LICENSE.txt`) | 획순 애니메이션 (`docs/vendor/hanzi-writer.min.js`) | 그대로 사용 |
| hanzi-writer-data 2.0.1 | [chanind/hanzi-writer-data](https://github.com/chanind/hanzi-writer-data) | Arphic Public License | 획순 데이터 (CDN 에서 불러옴, 저장소에는 없음) | — |

무료 API(Google 입력 도구·번역·TTS, MyMemory)의 결과는 사용자 기기에서 화면에 보여 주고 그 기기에만 캐시할 뿐,
데이터셋으로 저장소에 넣거나 재배포하지 않습니다.
