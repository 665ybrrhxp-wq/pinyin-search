'use strict';
/** Node 에서 사전 엔진을 쓰기 위한 도우미 (테스트·점검용): docs/data 의 JSON 을 읽어 Dictionary 를 만듦 */
const fs = require('fs');
const path = require('path');
const { Dictionary } = require('../docs/lib/dict');

const DOCS = path.join(__dirname, '..', 'docs');

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadDictionary(dataDir = path.join(DOCS, 'data')) {
  const get = (name) => readJSON(path.join(dataDir, `${name}.json`), name === 'cedict' ? [] : {});
  return new Dictionary().loadData({
    cedict: get('cedict'),
    mmah: get('mmah'),
    unihan: get('unihan'),
    hun: get('hun'),
    freq: get('freq'),
    hsk: get('hsk'),
    kowikt: get('kowikt'),
    radicals: readJSON(path.join(DOCS, 'lib', 'radicals.json'), { radicals: [] }),
  });
}

module.exports = { loadDictionary, DOCS };
