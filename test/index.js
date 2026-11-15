'use strict';

// Directory entry point so the requested `node --test test/` command works.
// Everything runs offline: do not import server.js or the browser-only service.
const { before, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { parseQuery, markSyllable, parseCedictPinyin } = require('../docs/lib/pinyin');
const { idsPosition, pinyinKey } = require('../docs/lib/dict');
const { loadDictionary } = require('../scripts/node-dict');

const bases = (segmentation) => segmentation.map((syllable) => syllable.base);

describe('pinyin query parsing', () => {
  test('xihuan includes the xi + huan segmentation', () => {
    assert.ok(parseQuery('xihuan').segmentations.some((seg) => bases(seg).join(' ') === 'xi huan'));
  });

  test('xi huan has the same first segmentation as xihuan', () => {
    assert.deepEqual(bases(parseQuery('xi huan').segmentations[0]), ['xi', 'huan']);
    assert.deepEqual(parseQuery('xi huan').segmentations[0], parseQuery('xihuan').segmentations[0]);
  });

  test('benzi segments as ben + zi', () => {
    assert.deepEqual(bases(parseQuery('benzi').segmentations[0]), ['ben', 'zi']);
  });

  for (const [input, expected] of [
    ['xi3 huan5', [{ base: 'xi', tone: 3 }, { base: 'huan', tone: 5 }]],
    ['xǐhuan', [{ base: 'xi', tone: 3 }, { base: 'huan', tone: null }]],
    ['pian2 yi', [{ base: 'pian', tone: 2 }, { base: 'yi', tone: null }]],
  ]) {
    test(`${JSON.stringify(input)} preserves specified and unspecified tones`, () => {
      assert.deepEqual(parseQuery(input).segmentations[0], expected);
    });
  }

  for (const [input, expected] of [
    ['lv se', ['lv', 'se']],
    ['lüse', ['lv', 'se']],
    ['lu:se', ['lv', 'se']],
    ['nü', ['nv']],
    ['lue', ['lve']],
    ['jv', ['ju']],
  ]) {
    test(`${JSON.stringify(input)} normalizes the umlaut spelling`, () => {
      assert.deepEqual(bases(parseQuery(input).segmentations[0]), expected);
    });
  }

  test('xian supports both xian and xi + an', () => {
    const interpretations = parseQuery('xian').segmentations.map((seg) => bases(seg).join(' '));
    assert.ok(interpretations.includes('xian'), JSON.stringify(interpretations));
    assert.ok(interpretations.includes('xi an'), JSON.stringify(interpretations));
  });

  for (const input of ["xi'an", 'xi an']) {
    test(`${JSON.stringify(input)} permits only xi + an`, () => {
      assert.deepEqual(parseQuery(input).segmentations.map(bases), [['xi', 'an']]);
    });
  }

  test('xyz is reported as invalid', () => {
    assert.ok(parseQuery('xyz').invalid.includes('xyz'));
  });

  test('ben zi produces the apostrophe-separated IME query', () => {
    assert.equal(parseQuery('ben zi').imeText, "ben'zi");
  });

  for (const input of ['xi3 huan5', 'xǐhuan', 'pian2 yi', 'ben zi', '123']) {
    test(`IME query for ${JSON.stringify(input)} has no tone digits`, () => {
      assert.doesNotMatch(parseQuery(input).imeText, /[0-9]/);
    });
  }
});

describe('pinyin tone marks and CEDICT', () => {
  for (const [base, tone, expected] of [
    ['xi', 3, 'xǐ'],
    ['lv', 4, 'lǜ'],
    ['lve', 4, 'lüè'],
    ['gou', 3, 'gǒu'],
    ['liu', 2, 'liú'],
    ['gui', 4, 'guì'],
    ['Xi', 1, 'Xī'],
    ['zi', 5, 'zi'],
    ['er', 2, 'ér'],
  ]) {
    test(`markSyllable(${JSON.stringify(base)}, ${tone}) is ${expected}`, () => {
      assert.equal(markSyllable(base, tone), expected);
    });
  }

  test('CEDICT lu:4 se4 marks the umlaut and both fourth tones', () => {
    assert.deepEqual(parseCedictPinyin('lu:4 se4').map((syllable) => syllable.marked), ['lǜ', 'sè']);
  });

  test('CEDICT Xi1 an1 preserves the proper-name flag', () => {
    assert.equal(parseCedictPinyin('Xi1 an1')[0].proper, true);
  });
});

describe('parser robustness', () => {
  for (const [label, input] of [
    ['empty input', ''],
    ['whitespace', '   '],
    ['200 repeated vowels', 'a'.repeat(200)],
    ['apostrophes only', "''''"],
    ['digits only', '123'],
    ['emoji', '😀🐼'],
  ]) {
    test(`${label} does not throw`, () => {
      assert.doesNotThrow(() => parseQuery(input));
    });
  }
});

describe('dictionary using the real built data', () => {
  let dictionary;

  before(() => {
    // One shared load for all dictionary cases, with no data builders or writes.
    dictionary = loadDictionary();
  });

  const searchPinyin = (q) => dictionary.searchPinyin(q, { imeWords: [] });

  const findGroup = (result, word) => {
    const group = result.groups.find((candidate) => candidate.word === word);
    assert.ok(group, `Expected ${word}; actual words: ${result.groups.map((g) => g.word).join(', ')}`);
    return group;
  };

  test('loaded dictionary stats match the compact entry count', () => {
    assert.ok(dictionary.raw.length > 0, 'Expected the real CEDICT data to be loaded');
    assert.equal(dictionary.stats().cedict, dictionary.raw.length);
  });

  test('xi huan ranks 喜欢 first', () => {
    assert.equal(searchPinyin('xi huan').groups[0]?.word, '喜欢');
  });

  test('xian ranks 先 first without IME candidates', () => {
    assert.equal(searchPinyin('xian').groups[0]?.word, '先');
  });

  test('ma ranks 吗 first without IME candidates', () => {
    assert.equal(searchPinyin('ma').groups[0]?.word, '吗');
  });

  test('the first ma result serializes its first syllable as neutral-tone ma', () => {
    const group = searchPinyin('ma').groups[0];
    assert.ok(group, 'Expected a result for ma');
    assert.equal(dictionary.serializeGroup(group).readings[0]?.syllables[0]?.t, 'ma');
  });

  for (const [pinyin, expected] of [['xian4', true], ['jian4', false]]) {
    test(`见 ${pinyin} has secondary-reading status ${expected}`, () => {
      const id = dictionary.raw.findIndex(([simp, , py]) => simp === '见' && py === pinyin);
      assert.notEqual(id, -1, `Expected a 见 entry with pinyin ${pinyin}`);
      assert.equal(dictionary.isSecondaryReading(dictionary.entry(id)), expected);
    });
  }

  for (const [input, expected] of [
    ['Xi1 an1', 'xi an'],
    ['lu:4 se4', 'lv se'],
    ['Ma3 ke4 · Tu4 wen1', 'ma ke tu wen'],
  ]) {
    test(`pinyinKey(${JSON.stringify(input)}) is ${expected}`, () => {
      assert.equal(pinyinKey(input), expected);
    });
  }

  test('喜欢 serializes its first reading as xǐ + huan', () => {
    const group = findGroup(searchPinyin('xi huan'), '喜欢');
    assert.deepEqual(dictionary.serializeGroup(group).readings[0].syllables.map((s) => s.t), ['xǐ', 'huan']);
  });

  test('pian2 yi includes 便宜 and only second-tone initial syllables', () => {
    const result = searchPinyin('pian2 yi');
    findGroup(result, '便宜');
    assert.ok(result.groups.length > 0);
    for (const group of result.groups) {
      const serialized = dictionary.serializeGroup(group);
      assert.ok(serialized.readings.length > 0);
      for (const reading of serialized.readings) {
        assert.equal(reading.syllables[0]?.tone, 2, `Unexpected first tone for ${group.word}`);
      }
    }
    assert.equal(result.toneRelaxed, false);
  });

  test('dong xi preserves both 东西 readings', () => {
    const group = findGroup(searchPinyin('dong xi'), '东西');
    const readings = dictionary.serializeGroup(group).readings;
    assert.equal(readings.length, 2);
    assert.deepEqual(readings.map((r) => r.syllables.map((s) => s.t).join(' ')).sort(), ['dōng xi', 'dōng xī'].sort());
  });

  for (const [input, word] of [
    ['da suan', '打算'],
    ['da suan', '大蒜'],
    ['lv se', '绿色'],
    ['yidianr', '一点儿'],
  ]) {
    test(`${JSON.stringify(input)} includes ${word}`, () => {
      findGroup(searchPinyin(input), word);
    });
  }

  test('xi3 huan3 relaxes incorrect tones and still finds 喜欢', () => {
    const result = searchPinyin('xi3 huan3');
    assert.equal(result.toneRelaxed, true);
    findGroup(result, '喜欢');
  });

  test('simplified 喜欢 is the first exact Hanzi result', () => {
    assert.equal(dictionary.searchHanzi('喜欢').groups[0]?.word, '喜欢');
  });

  test('traditional 喜歡 finds simplified 喜欢', () => {
    findGroup(dictionary.searchHanzi('喜歡'), '喜欢');
  });

  test('学 returns many words containing 学', () => {
    const { groups } = dictionary.searchHanzi('学');
    assert.ok(groups.length > 10, `Expected many words, got ${groups.length}`);
    assert.ok(groups.every((g) => g.word.includes('学')), 'Every returned word must contain 学');
  });

  test('说 has nine strokes, radical 149 / 讠, and traditional 說', () => {
    const info = dictionary.charInfo('说');
    assert.equal(info.strokes, 9);
    assert.equal(info.radical?.num, 149);
    assert.equal(info.radical?.form, '讠');
    assert.ok(info.traditional.includes('說'));
  });

  test('说 gets 말씀 설 from the 說 hun source (hun membership, not order)', () => {
    const source = dictionary.charInfo('说').hunSources[0];
    assert.equal(source?.char, '說');
    assert.ok(source.hun.includes('말씀 설'), JSON.stringify(source.hun));
  });

  test('说 radical is positioned on the left (변)', () => {
    assert.equal(dictionary.charInfo('说').radical?.position, '변');
  });

  test('喜 has twelve strokes and radical 30 / 口', () => {
    const info = dictionary.charInfo('喜');
    assert.equal(info.strokes, 12);
    assert.equal(info.radical?.num, 30);
    assert.equal(info.radical?.form, '口');
  });

  test('喜 radical is positioned at the bottom (발)', () => {
    assert.equal(dictionary.charInfo('喜').radical?.position, '발');
  });

  test('喜 does not label its bottom radical 입구변', () => {
    const radical = dictionary.charInfo('喜').radical;
    assert.ok(radical, 'Expected radical information for 喜');
    assert.notEqual(radical.label, '입구변');
  });

  for (const [char, expected] of [['那', '우부방'], ['院', '좌부변'], ['肚', '육달월']]) {
    test(`${char} radical is labeled ${expected}`, () => {
      assert.equal(dictionary.charInfo(char).radical?.label, expected);
    });
  }

  test('木 is its own radical (제부수)', () => {
    assert.equal(dictionary.charInfo('木').radical?.position, '제부수');
  });

  test('们 uses the 亻 radical form', () => {
    assert.equal(dictionary.charInfo('们').radical?.form, '亻');
  });

  test('喜欢 has a Korean dictionary definition containing 좋아하다', () => {
    const korean = dictionary.koreanDict('喜欢');
    assert.equal(korean?.kind, 'dict');
    assert.ok(korean.text.includes('좋아하다'), korean.text);
  });

  test('打算 prefers the verb part of speech', () => {
    assert.equal(dictionary.koreanDict('打算')?.pos, '동사');
  });

  test('searchPinyin returns within one second for 10,000 repeated vowels', () => {
    const input = 'a'.repeat(10_000);
    const start = performance.now();
    let result;
    assert.doesNotThrow(() => {
      result = searchPinyin(input);
    }, 'searchPinyin must return, rather than throw, for a 10,000-character query');
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 1000, `Expected <1000 ms; actual ${elapsed.toFixed(2)} ms`);
    assert.ok(Array.isArray(result.groups));
  });
});

describe('IDS radical positions', () => {
  for (const [ids, form, expected] of [
    ['⿰讠兑', '讠', '변'],
    ['⿱壴口', '口', '발'],
    ['⿸广付', '广', '엄'],
    ['⿺辶首', '辶', '받침'],
    ['⿴囗玉', '囗', '몸'],
  ]) {
    test(`${ids} locates ${form} at ${expected}`, () => {
      assert.equal(idsPosition(ids, form), expected);
    });
  }
});

describe('static-site integrity', () => {
  const docs = path.join(__dirname, '..', 'docs');
  const read = (file) => fs.readFileSync(path.join(docs, file), 'utf8');
  const assertSiteFile = (resource) => {
    const pathname = decodeURIComponent(resource.split(/[?#]/)[0]);
    const file = path.resolve(docs, pathname === './' ? 'index.html' : pathname.replace(/^\/+/, ''));
    assert.ok(file.startsWith(docs + path.sep), `Path must stay under docs/: ${resource}`);
    assert.ok(fs.existsSync(file), `Missing static file: ${resource}`);
    assert.ok(fs.statSync(file).isFile(), `Expected a file: ${resource}`);
    return file;
  };

  test('every service-worker SHELL_FILES path exists under docs/', () => {
    const match = /\bconst\s+SHELL_FILES\s*=\s*(\[[\s\S]*?\]);/.exec(read('sw.js'));
    assert.ok(match, 'Expected a SHELL_FILES array in sw.js');
    // Parse only the literal array, never execute the service worker in Node.
    const files = JSON.parse(match[1].replace(/'/g, '"').replace(/,\s*\]/g, ']'));
    assert.ok(files.length > 0, 'Expected shell files to be listed');
    for (const file of files) assertSiteFile(file);
  });

  test('meta.json lists existing data files with exact byte sizes', () => {
    const metaFile = assertSiteFile('data/meta.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    assert.ok(meta.files && Object.keys(meta.files).length > 0, 'Expected data files in meta.files');
    for (const [key, size] of Object.entries(meta.files)) {
      const file = assertSiteFile(`data/${key}.json`);
      assert.equal(fs.statSync(file).size, size, `Byte size mismatch for data/${key}.json`);
    }
  });

  test('every local script src and link href in index.html exists', () => {
    const tags = [...read('index.html').matchAll(/<(script|link)\b[^>]*>/gi)];
    let localCount = 0;
    for (const [tag, name] of tags) {
      const attribute = name.toLowerCase() === 'script' ? 'src' : 'href';
      const match = new RegExp(`\\b${attribute}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(tag);
      if (!match || /^(?:https?:)?\/\//i.test(match[2])) continue;
      assertSiteFile(match[2]);
      localCount++;
    }
    assert.ok(localCount > 0, 'Expected local scripts and links');
  });

  test('every manifest icon src exists under docs/', () => {
    const manifest = JSON.parse(read('manifest.webmanifest'));
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'Expected manifest icons');
    for (const icon of manifest.icons) assertSiteFile(icon.src);
  });

  test('.nojekyll exists for GitHub Pages', () => {
    assertSiteFile('.nojekyll');
  });

  test('service-worker activation filters owned cache names before deleting', () => {
    const source = read('sw.js');
    assert.ok(source.includes('pinyin-search-'), 'Expected the app-specific cache prefix');
    assert.match(source, /\bconst\s+PREFIX\s*=\s*['"]pinyin-search-['"]/);
    const activate = /self\.addEventListener\(\s*['"]activate['"][\s\S]*?\n\}\);/.exec(source);
    assert.ok(activate, 'Expected an activate handler');
    assert.match(
      activate[0],
      /\.filter\([\s\S]*?\.startsWith\(PREFIX(?:\s*\+\s*['"][^'"]*['"])?\)[\s\S]*?\.map\([\s\S]*?caches\.delete\(/,
      'Cache deletion must follow filtering by the pinyin-search- prefix',
    );
  });
});

describe('sentence segmentation', () => {
  const { loadDictionary } = require('../scripts/node-dict');
  let d;
  before(() => {
    d = loadDictionary();
  });
  const split = (q, ime) => {
    const s = d.searchSentence(q, { imeSentence: ime });
    return s.words.map((w) => w.word + '/' + d.entry(w.id).numbered).join(' ');
  };

  test('offline: wo jue de … splits into words with contextual readings (得 děi)', () => {
    assert.equal(split('wo jue de wo hai dei zai nu li'), '我/wo3 觉得/jue2de5 我/wo3 还/hai2 得/dei3 在/zai4 努力/nu3li4');
  });

  test('offline: common sentences keep multi-syllable words', () => {
    assert.equal(
      d.searchSentence('jin tian tian qi hen hao').words.map((w) => w.word).join(' '),
      '今天 天气 很 好',
    );
    assert.equal(
      d.searchSentence('yin wei ta hen mang suo yi mei lai').words.map((w) => w.word).join(' '),
      '因为 他 很 忙 所以 没 来',
    );
  });

  test('IME sentence hint fixes homophones without over-splitting', () => {
    assert.equal(split('wo jue de wo hai dei zai nu li', '我觉得我还得再努力'), '我/wo3 觉得/jue2de5 我/wo3 还/hai2 得/dei3 再/zai4 努力/nu3li4');
    assert.equal(
      d.searchSentence('wo xi huan chi zhong guo cai', { imeSentence: '我喜欢吃中国菜' }).hanzi,
      '我喜欢吃中国菜',
    );
  });

  test('single syllable or invalid input gives no sentence', () => {
    assert.equal(d.searchSentence('ni'), null);
    assert.equal(d.searchSentence('xyz'), null);
  });
});
