'use strict';
/** 의존성 없는 최소 ZIP 리더 (stored / deflate 만 지원, zip64 미지원) */
const zlib = require('zlib');

function openZip(buf) {
  let eocd = -1;
  const stop = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP 끝 레코드를 찾을 수 없습니다');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('ZIP 중앙 디렉터리 손상');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.set(name, { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }

  return {
    names: [...entries.keys()],
    read(name) {
      const e = entries.get(name);
      if (!e) throw new Error(`ZIP 안에 ${name} 이(가) 없습니다`);
      const lh = e.localOff;
      if (buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('ZIP 로컬 헤더 손상');
      const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
      const data = buf.subarray(start, start + e.compSize);
      if (e.method === 0) return Buffer.from(data);
      if (e.method === 8) return zlib.inflateRawSync(data);
      throw new Error(`지원하지 않는 압축 방식: ${e.method}`);
    },
  };
}

module.exports = { openZip };
