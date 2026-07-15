// src/spec.ts
var TIERS = [
  { id: 0, name: "small", dataBytes: 19, parityBytes: 8, codewordBytes: 27, dataColumns: 54 },
  { id: 1, name: "medium", dataBytes: 27, parityBytes: 12, codewordBytes: 39, dataColumns: 78 },
  { id: 2, name: "large", dataBytes: 35, parityBytes: 16, codewordBytes: 51, dataColumns: 102 }
];
var SIGNAL_SPEC = {
  version: 3,
  levelsPerSide: 4,
  bitsPerColumn: 4,
  tiers: TIERS,
  geom: {
    quietModules: 4,
    columnPitchModules: 2,
    guardColumnsPerSide: 4,
    halfHeightModules: 16,
    heightStepModules: 4,
    heightModules: 40
  }
};
function tierSpec(tier) {
  const found = typeof tier === "number" ? SIGNAL_SPEC.tiers.find((candidate) => candidate.id === tier) : SIGNAL_SPEC.tiers.find((candidate) => candidate.name === tier);
  if (!found) throw new Error(`unsupported Signal tier ${String(tier)}`);
  return found;
}
function signalWidthModules(tier) {
  const resolved = typeof tier === "string" ? tierSpec(tier) : tier;
  const g = SIGNAL_SPEC.geom;
  const columns = resolved.dataColumns + g.guardColumnsPerSide * 2;
  return g.quietModules * 2 + columns * g.columnPitchModules;
}
function levelHeightModules(level) {
  const clamped = Math.max(0, Math.min(SIGNAL_SPEC.levelsPerSide - 1, Math.round(level)));
  return (clamped + 1) * SIGNAL_SPEC.geom.heightStepModules;
}
function grayToLevel(gray) {
  const value = gray & 3;
  return value ^ value >>> 1;
}
function levelToGray(level) {
  const clamped = Math.max(0, Math.min(3, Math.round(level)));
  return clamped ^ clamped >>> 1;
}
var LEFT_GUARD_LEVELS = [3, 0, 2, 3];
function rightGuardLevels(tier) {
  return [3, tierSpec(tier).id, 1, 3];
}

// src/crc.ts
function crc16Ccitt(bytes) {
  let crc = 65535;
  for (const byte of bytes) {
    crc ^= (byte & 255) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 32768) !== 0 ? crc << 1 ^ 4129 : crc << 1;
      crc &= 65535;
    }
  }
  return crc;
}

// src/bits.ts
var BitWriter = class {
  constructor() {
    this.bits = [];
  }
  writeBits(value, count) {
    for (let i = count - 1; i >= 0; i--) this.bits.push(value >>> i & 1);
  }
  get length() {
    return this.bits.length;
  }
  /** Pack accumulated bits into bytes, MSB-first, zero-padding the last byte. */
  toBytes() {
    const bytes = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = b << 1 | (this.bits[i + j] ?? 0);
      bytes.push(b);
    }
    return bytes;
  }
};
var BitReader = class {
  constructor(bits) {
    this.bits = bits;
    this.pos = 0;
  }
  readBits(count) {
    let v = 0;
    for (let i = 0; i < count; i++) v = v << 1 | (this.bits[this.pos++] ?? 0);
    return v;
  }
  get remaining() {
    return this.bits.length - this.pos;
  }
};
function bytesToBits(bytes) {
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push(b >>> i & 1);
  return bits;
}

// src/charset.ts
function isStrictAscii(input) {
  for (let i = 0; i < input.length; i++) if (input.charCodeAt(i) > 127) return false;
  return true;
}
function asciiTextToSymbols(text) {
  const out = [];
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code > 127) throw new Error("text is not strict ASCII metadata");
    out.push(code);
  }
  return out;
}
function asciiSymbolsToText(symbols) {
  let out = "";
  for (const symbol of symbols) {
    if (!Number.isInteger(symbol) || symbol < 0 || symbol > 127) {
      throw new Error("invalid ASCII metadata symbol");
    }
    out += String.fromCharCode(symbol);
  }
  return out;
}

// src/compress.ts
var EOF_SYMBOL = 128;
var NUM_SYMBOLS = 129;
var WEIGHTS = (() => {
  const w = new Array(NUM_SYMBOLS).fill(1);
  const letters = [
    82,
    15,
    28,
    43,
    127,
    22,
    20,
    61,
    70,
    2,
    8,
    40,
    24,
    // a..m
    67,
    75,
    19,
    1,
    60,
    63,
    91,
    28,
    10,
    24,
    2,
    20,
    1
    // n..z
  ];
  for (let i = 0; i < 26; i++) {
    w[97 + i] = letters[i];
    w[65 + i] = Math.max(2, Math.round(letters[i] / 8));
  }
  for (let i = 0; i < 10; i++) w[48 + i] = 7;
  w[32] = 180;
  for (const [character, weight] of [
    ["'", 16],
    ["-", 14],
    ["&", 12],
    [".", 11],
    ["!", 9],
    ["/", 8],
    ["#", 7],
    ["(", 6],
    [")", 6],
    [",", 6],
    [":", 5],
    ["+", 4],
    ["?", 4]
  ]) {
    w[character.charCodeAt(0)] = weight;
  }
  w[EOF_SYMBOL] = 30;
  return w;
})();
var TREE = (() => {
  let counter = 0;
  let nodes = [];
  for (let s = 0; s < NUM_SYMBOLS; s++) {
    nodes.push({ weight: WEIGHTS[s], symbol: s, order: counter++ });
  }
  while (nodes.length > 1) {
    nodes.sort((a2, b2) => a2.weight - b2.weight || a2.order - b2.order);
    const a = nodes.shift();
    const b = nodes.shift();
    nodes.push({ weight: a.weight + b.weight, symbol: -1, left: a, right: b, order: counter++ });
  }
  return nodes[0];
})();
var CODES = (() => {
  const codes = new Array(NUM_SYMBOLS);
  const walk = (node, path) => {
    if (node.symbol >= 0) {
      codes[node.symbol] = path.slice();
      return;
    }
    if (node.left) walk(node.left, [...path, 0]);
    if (node.right) walk(node.right, [...path, 1]);
  };
  walk(TREE, []);
  return codes;
})();
function huffEncodeBits(symbols) {
  const bits = [];
  for (const s of symbols) {
    const code = CODES[s];
    if (!code) throw new Error(`no Huffman code for symbol ${s}`);
    for (const b of code) bits.push(b);
  }
  return bits;
}
function huffDecodeSymbolsStrict(reader) {
  const out = [];
  for (let guard = 0; guard < 4096 && reader.remaining > 0; guard++) {
    let node = TREE;
    while (node.symbol < 0) {
      if (reader.remaining <= 0) throw new Error("ASCII Huffman stream is missing EOF");
      node = reader.readBits(1) === 0 ? node.left : node.right;
    }
    if (node.symbol === EOF_SYMBOL) {
      while (reader.remaining > 0) {
        if (reader.readBits(1) !== 0) throw new Error("ASCII Huffman stream has non-zero padding");
      }
      return out;
    }
    out.push(node.symbol);
  }
  throw new Error("ASCII Huffman stream is missing EOF");
}
function bitsToBytes(bits) {
  const bw = new BitWriter();
  for (const b of bits) bw.writeBits(b, 1);
  return bw.toBytes();
}

// src/scsu.ts
var STATIC_OFFSETS = [0, 128, 256, 768, 8192, 8320, 8448, 12288];
var INITIAL_DYNAMIC_OFFSETS = [128, 192, 1024, 1536, 2304, 12352, 12448, 65280];
var SPECIAL_OFFSETS = [192, 592, 880, 1328, 12352, 12448, 65376];
function offsetFromIndex(index) {
  if (index >= 1 && index <= 103) return index << 7;
  if (index >= 104 && index <= 167) return (index << 7) + 44032;
  if (index >= 249 && index <= 255) return SPECIAL_OFFSETS[index - 249] ?? null;
  return null;
}
function indexForCodePoint(codePoint) {
  for (let i = 0; i < SPECIAL_OFFSETS.length; i++) {
    const offset2 = SPECIAL_OFFSETS[i];
    if (codePoint >= offset2 && codePoint < offset2 + 128) return { index: 249 + i, offset: offset2 };
  }
  const offset = codePoint & ~127;
  if (offset >= 128 && offset <= 13184) return { index: offset >>> 7, offset };
  if (offset >= 57344 && offset <= 65408) return { index: offset - 44032 >>> 7, offset };
  return null;
}
function pushCodePoint(out, codePoint) {
  if (codePoint < 0 || codePoint > 1114111 || codePoint >= 55296 && codePoint <= 57343) {
    throw new Error("invalid SCSU code point");
  }
  if (codePoint <= 65535) {
    out.push(codePoint);
    return;
  }
  const value = codePoint - 65536;
  out.push(55296 + (value >>> 10), 56320 + (value & 1023));
}
function codePoints(input) {
  const out = [];
  for (let i = 0; i < input.length; i++) {
    const first = input.charCodeAt(i);
    if (first >= 55296 && first <= 56319 && i + 1 < input.length) {
      const second = input.charCodeAt(i + 1);
      if (second >= 56320 && second <= 57343) {
        out.push(65536 + (first - 55296 << 10) + second - 56320);
        i++;
        continue;
      }
    }
    out.push(first >= 55296 && first <= 57343 ? 65533 : first);
  }
  return out;
}
function directSingleByte(codePoint) {
  return codePoint === 0 || codePoint === 9 || codePoint === 10 || codePoint === 13 || codePoint >= 32 && codePoint <= 127;
}
function scsuEncode(input) {
  const dynamic = [...INITIAL_DYNAMIC_OFFSETS];
  let current = 0;
  const out = [];
  for (const cp of codePoints(input)) {
    if (directSingleByte(cp)) {
      out.push(cp);
      continue;
    }
    const currentOffset = dynamic[current];
    if (cp >= currentOffset && cp < currentOffset + 128) {
      out.push(128 + cp - currentOffset);
      continue;
    }
    let existing = -1;
    for (let window = 0; window < dynamic.length; window++) {
      if (cp >= dynamic[window] && cp < dynamic[window] + 128) {
        existing = window;
        break;
      }
    }
    if (existing >= 0) {
      current = existing;
      out.push(16 + current, 128 + cp - dynamic[current]);
      continue;
    }
    let quoted = false;
    for (let window = 0; window < STATIC_OFFSETS.length; window++) {
      const offset2 = STATIC_OFFSETS[window];
      if (cp >= offset2 && cp < offset2 + 128) {
        out.push(1 + window, cp - offset2);
        quoted = true;
        break;
      }
    }
    if (quoted) continue;
    const definition = indexForCodePoint(cp);
    if (definition) {
      dynamic[current] = definition.offset;
      out.push(24 + current, definition.index, 128 + cp - definition.offset);
      continue;
    }
    if (cp <= 65535) {
      out.push(14, cp >>> 8, cp & 255);
      continue;
    }
    const block = Math.floor((cp - 65536) / 128);
    const first = current << 5 | block >>> 8 & 31;
    const second = block & 255;
    const offset = 65536 + block * 128;
    dynamic[current] = offset;
    out.push(11, first, second, 128 + cp - offset);
  }
  return out;
}
function scsuDecode(bytes) {
  const dynamic = [...INITIAL_DYNAMIC_OFFSETS];
  const units = [];
  let current = 0;
  let unicodeMode = false;
  let i = 0;
  const next = () => {
    if (i >= bytes.length) throw new Error("truncated SCSU stream");
    return bytes[i++] & 255;
  };
  const defineExtended = (first, second) => {
    current = first >>> 5;
    dynamic[current] = 65536 + ((first & 31) << 8 | second) * 128;
  };
  while (i < bytes.length) {
    const value = next();
    if (!unicodeMode) {
      if (directSingleByte(value)) {
        units.push(value);
      } else if (value >= 128) {
        pushCodePoint(units, dynamic[current] + value - 128);
      } else if (value >= 1 && value <= 8) {
        const quoted = next();
        const window = value - 1;
        pushCodePoint(units, quoted < 128 ? STATIC_OFFSETS[window] + quoted : dynamic[window] + quoted - 128);
      } else if (value === 11) {
        defineExtended(next(), next());
      } else if (value === 14) {
        pushCodePoint(units, next() << 8 | next());
      } else if (value === 15) {
        unicodeMode = true;
      } else if (value >= 16 && value <= 23) {
        current = value - 16;
      } else if (value >= 24 && value <= 31) {
        current = value - 24;
        const offset = offsetFromIndex(next());
        if (offset === null) throw new Error("invalid SCSU window definition");
        dynamic[current] = offset;
      } else {
        throw new Error("reserved SCSU command");
      }
      continue;
    }
    if (value >= 224 && value <= 231) {
      current = value - 224;
      unicodeMode = false;
    } else if (value >= 232 && value <= 239) {
      current = value - 232;
      const offset = offsetFromIndex(next());
      if (offset === null) throw new Error("invalid SCSU window definition");
      dynamic[current] = offset;
      unicodeMode = false;
    } else if (value === 240) {
      units.push(next() << 8 | next());
    } else if (value === 241) {
      defineExtended(next(), next());
      unicodeMode = false;
    } else {
      units.push(value << 8 | next());
    }
  }
  let out = "";
  const chunk = 16384;
  for (let start = 0; start < units.length; start += chunk) {
    out += String.fromCharCode(...units.slice(start, start + chunk));
  }
  return out;
}

// src/text.ts
function utf8Encode(input) {
  const out = [];
  for (let i = 0; i < input.length; i++) {
    let cp = input.charCodeAt(i);
    if (cp >= 55296 && cp <= 56319 && i + 1 < input.length) {
      const low = input.charCodeAt(i + 1);
      if (low >= 56320 && low <= 57343) {
        cp = 65536 + (cp - 55296 << 10) + low - 56320;
        i++;
      } else cp = 65533;
    } else if (cp >= 55296 && cp <= 57343) cp = 65533;
    if (cp <= 127) out.push(cp);
    else if (cp <= 2047) out.push(192 | cp >>> 6, 128 | cp & 63);
    else if (cp <= 65535) out.push(224 | cp >>> 12, 128 | cp >>> 6 & 63, 128 | cp & 63);
    else out.push(240 | cp >>> 18, 128 | cp >>> 12 & 63, 128 | cp >>> 6 & 63, 128 | cp & 63);
  }
  return out;
}
function utf8Decode(bytes) {
  const units = [];
  for (let i = 0; i < bytes.length; ) {
    const first = bytes[i++] & 255;
    let cp = first;
    let count = 0;
    let min = 0;
    if (first <= 127) {
      units.push(first);
      continue;
    } else if (first >= 194 && first <= 223) {
      cp = first & 31;
      count = 1;
      min = 128;
    } else if (first >= 224 && first <= 239) {
      cp = first & 15;
      count = 2;
      min = 2048;
    } else if (first >= 240 && first <= 244) {
      cp = first & 7;
      count = 3;
      min = 65536;
    } else throw new Error("invalid UTF-8 lead byte");
    if (i + count > bytes.length) throw new Error("truncated UTF-8 stream");
    for (let j = 0; j < count; j++) {
      const next = bytes[i++] & 255;
      if ((next & 192) !== 128) throw new Error("invalid UTF-8 continuation byte");
      cp = cp << 6 | next & 63;
    }
    if (cp < min || cp > 1114111 || cp >= 55296 && cp <= 57343) throw new Error("invalid UTF-8 code point");
    if (cp <= 65535) units.push(cp);
    else {
      cp -= 65536;
      units.push(55296 + (cp >>> 10), 56320 + (cp & 1023));
    }
  }
  return String.fromCharCode(...units);
}
function huffmanEncodeField(input) {
  const symbols = [...asciiTextToSymbols(input), EOF_SYMBOL];
  return bitsToBytes(huffEncodeBits(symbols));
}
function huffmanDecodeField(bytes) {
  return asciiSymbolsToText(huffDecodeSymbolsStrict(new BitReader(bytesToBits(bytes))));
}
function encodeFieldCandidates(artistInput, titleInput) {
  const artist = artistInput ?? "";
  const title = titleInput ?? "";
  const candidates = [];
  if (isStrictAscii(artist) && isStrictAscii(title)) {
    candidates.push({
      codec: "ascii-huffman",
      artist,
      title,
      artistBytes: huffmanEncodeField(artist),
      titleBytes: huffmanEncodeField(title)
    });
  }
  candidates.push({ codec: "scsu", artist, title, artistBytes: scsuEncode(artist), titleBytes: scsuEncode(title) });
  candidates.push({ codec: "utf8", artist, title, artistBytes: utf8Encode(artist), titleBytes: utf8Encode(title) });
  const priority = { "ascii-huffman": 0, scsu: 1, utf8: 2 };
  return candidates.sort(
    (a, b) => a.artistBytes.length + a.titleBytes.length - b.artistBytes.length - b.titleBytes.length || priority[a.codec] - priority[b.codec]
  );
}
function decodeFields(codec, artistBytes, titleBytes) {
  if (codec === "ascii-huffman") {
    return { artist: huffmanDecodeField(artistBytes), title: huffmanDecodeField(titleBytes) };
  }
  if (codec === "scsu") return { artist: scsuDecode(artistBytes), title: scsuDecode(titleBytes) };
  return { artist: utf8Decode(artistBytes), title: utf8Decode(titleBytes) };
}

// src/payload.ts
var HEADER_BYTES = 5;
var CRC_BYTES = 2;
var CODEC_ID = { "ascii-huffman": 3, scsu: 1, utf8: 2 };
var ID_CODEC = [void 0, "scsu", "utf8", "ascii-huffman"];
function clampDuration(value) {
  if (!Number.isFinite(value) || !value) return 0;
  return Math.max(0, Math.min(65535, Math.round(value)));
}
function frameForCandidate(candidate, tier, durationSec) {
  const body = [...candidate.artistBytes, ...candidate.titleBytes];
  if (body.length > 255 || candidate.artistBytes.length > 255) return null;
  const usedBytes = HEADER_BYTES + body.length + CRC_BYTES;
  if (usedBytes > tier.dataBytes) return null;
  const header = SIGNAL_SPEC.version << 4 | CODEC_ID[candidate.codec] << 2 | tier.id;
  const bytes = [
    header,
    durationSec >>> 8 & 255,
    durationSec & 255,
    body.length,
    candidate.artistBytes.length,
    ...body
  ];
  const crc = crc16Ccitt(bytes);
  bytes.push(crc >>> 8 & 255, crc & 255);
  const paddedData = bytes.concat(new Array(tier.dataBytes - bytes.length).fill(0));
  return {
    bytes,
    paddedData,
    tier: tier.name,
    codec: candidate.codec,
    payload: {
      version: 3,
      type: "metadata",
      artist: candidate.artist,
      title: candidate.title,
      durationSec
    }
  };
}
function tryEncode(artist, title, durationSec) {
  for (const tier of SIGNAL_SPEC.tiers) {
    for (const candidate of encodeFieldCandidates(artist, title)) {
      const frame = frameForCandidate(candidate, tier, durationSec);
      if (frame) return frame;
    }
  }
  return null;
}
function scalarPrefixes(input) {
  const prefixes = [""];
  let value = "";
  for (const scalar of input) {
    value += scalar;
    prefixes.push(value);
  }
  return prefixes;
}
function encodeSignalFrame(input) {
  const durationSec = clampDuration(input.durationSec);
  const artist = input.artist ?? "";
  const title = input.title ?? "";
  const full = tryEncode(artist, title, durationSec);
  if (full) return full;
  const titlePrefixes = scalarPrefixes(title);
  for (let i = titlePrefixes.length - 1; i >= 0; i--) {
    const frame = tryEncode(artist, titlePrefixes[i], durationSec);
    if (frame) return frame;
  }
  const artistPrefixes = scalarPrefixes(artist);
  for (let i = artistPrefixes.length - 1; i >= 0; i--) {
    const frame = tryEncode(artistPrefixes[i], "", durationSec);
    if (frame) return frame;
  }
  throw new Error("could not encode Signal metadata");
}
function decodeSignalFrame(bytes, expectedTier) {
  if (bytes.length < HEADER_BYTES + CRC_BYTES) throw new Error("Signal frame is too short");
  if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error("Signal frame contains an invalid byte");
  }
  const header = bytes[0] & 255;
  const version = header >>> 4;
  if (version !== SIGNAL_SPEC.version) throw new Error(`unsupported Signal version ${version}`);
  const codecId = header >>> 2 & 3;
  const codec = ID_CODEC[codecId];
  if (!codec) throw new Error("unsupported Signal text codec");
  const tier = tierSpec(header & 3);
  if (expectedTier && expectedTier !== tier.name) throw new Error("Signal tier marker does not match frame");
  if (bytes.length > tier.dataBytes) throw new Error("Signal frame exceeds its tier");
  const bodyLength = bytes[3];
  const artistLength = bytes[4];
  if (artistLength > bodyLength) throw new Error("invalid Signal artist length");
  const usedBytes = HEADER_BYTES + bodyLength + CRC_BYTES;
  if (usedBytes > bytes.length || usedBytes > tier.dataBytes) throw new Error("truncated Signal body");
  const expectedCrc = bytes[usedBytes - 2] << 8 | bytes[usedBytes - 1];
  const actualCrc = crc16Ccitt(bytes.slice(0, usedBytes - CRC_BYTES));
  if (expectedCrc !== actualCrc) throw new Error("Signal checksum mismatch");
  for (let index = usedBytes; index < bytes.length; index++) {
    if (bytes[index] !== 0) throw new Error("Signal frame contains non-zero padding");
  }
  const body = bytes.slice(HEADER_BYTES, HEADER_BYTES + bodyLength);
  const fields = decodeFields(codec, body.slice(0, artistLength), body.slice(artistLength));
  return {
    payload: {
      version: 3,
      type: "metadata",
      artist: fields.artist,
      title: fields.title,
      durationSec: bytes[1] << 8 | bytes[2]
    },
    tier: tier.name,
    codec,
    usedBytes
  };
}

// src/ecc.ts
var PRIM = 285;
var gfExp = new Uint8Array(512);
var gfLog = new Uint8Array(256);
(function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    gfExp[i] = x;
    gfLog[x] = i;
    x <<= 1;
    if (x & 256) x ^= PRIM;
  }
  for (let i = 255; i < 512; i++) gfExp[i] = gfExp[i - 255];
})();
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return gfExp[gfLog[a] + gfLog[b]];
}
function gfDiv(a, b) {
  if (b === 0) throw new Error("GF division by zero");
  if (a === 0) return 0;
  let d = gfLog[a] - gfLog[b];
  if (d < 0) d += 255;
  return gfExp[d];
}
function gfPow(x, power) {
  let l = gfLog[x] * power % 255;
  if (l < 0) l += 255;
  return gfExp[l];
}
function gfInverse(x) {
  return gfExp[255 - gfLog[x]];
}
function gfPolyScale(p, x) {
  return p.map((c) => gfMul(c, x));
}
function gfPolyAdd(p, q) {
  const r = new Array(Math.max(p.length, q.length)).fill(0);
  for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
  for (let i = 0; i < q.length; i++) {
    const k = i + r.length - q.length;
    r[k] = r[k] ^ q[i];
  }
  return r;
}
function gfPolyMul(p, q) {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++) {
    for (let i = 0; i < p.length; i++) r[i + j] = r[i + j] ^ gfMul(p[i], q[j]);
  }
  return r;
}
function gfPolyEval(p, x) {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = gfMul(y, x) ^ p[i];
  return y;
}
function gfPolyDiv(dividend, divisor) {
  const out = dividend.slice();
  for (let i = 0; i < dividend.length - (divisor.length - 1); i++) {
    const coef = out[i];
    if (coef !== 0) {
      for (let j = 1; j < divisor.length; j++) {
        if (divisor[j] !== 0) out[i + j] = out[i + j] ^ gfMul(divisor[j], coef);
      }
    }
  }
  const sep = out.length - (divisor.length - 1);
  return [out.slice(0, sep), out.slice(sep)];
}
function rsGeneratorPoly(nsym) {
  let g = [1];
  for (let i = 0; i < nsym; i++) g = gfPolyMul(g, [1, gfPow(2, i)]);
  return g;
}
function rsEncode(msg, nsym) {
  const gen = rsGeneratorPoly(nsym);
  const out = msg.concat(new Array(gen.length - 1).fill(0));
  for (let i = 0; i < msg.length; i++) {
    const coef = out[i];
    if (coef !== 0) {
      for (let j = 1; j < gen.length; j++) out[i + j] = out[i + j] ^ gfMul(gen[j], coef);
    }
  }
  for (let i = 0; i < msg.length; i++) out[i] = msg[i];
  return out;
}
function rsCalcSyndromes(msg, nsym) {
  const synd = [0];
  for (let i = 0; i < nsym; i++) synd.push(gfPolyEval(msg, gfPow(2, i)));
  return synd;
}
function rsFindErrorLocator(synd, nsym, eraseCount = 0) {
  let errLoc = [1];
  let oldLoc = [1];
  const syndShift = synd.length > nsym ? synd.length - nsym : 0;
  for (let i = 0; i < nsym - eraseCount; i++) {
    const K = i + syndShift;
    let delta = synd[K];
    for (let j = 1; j < errLoc.length; j++) {
      delta ^= gfMul(errLoc[errLoc.length - 1 - j], synd[K - j]);
    }
    oldLoc = oldLoc.concat([0]);
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = gfPolyScale(oldLoc, delta);
        oldLoc = gfPolyScale(errLoc, gfInverse(delta));
        errLoc = newLoc;
      }
      errLoc = gfPolyAdd(errLoc, gfPolyScale(oldLoc, delta));
    }
  }
  while (errLoc.length && errLoc[0] === 0) errLoc.shift();
  const errs = errLoc.length - 1;
  if (errs * 2 + eraseCount > nsym) throw new Error("too many errors to correct");
  return errLoc;
}
function rsFindErrors(errLoc, nmess) {
  const errs = errLoc.length - 1;
  const errPos = [];
  for (let i = 0; i < nmess; i++) {
    if (gfPolyEval(errLoc, gfPow(2, i)) === 0) errPos.push(nmess - 1 - i);
  }
  if (errPos.length !== errs) throw new Error("could not locate all errors");
  return errPos;
}
function rsFindErrataLocator(coefPos) {
  let eLoc = [1];
  for (const i of coefPos) eLoc = gfPolyMul(eLoc, gfPolyAdd([1], [gfPow(2, i), 0]));
  return eLoc;
}
function rsFindErrorEvaluator(synd, errLoc, nsym) {
  const [, remainder] = gfPolyDiv(
    gfPolyMul(synd, errLoc),
    [1].concat(new Array(nsym + 1).fill(0))
  );
  return remainder;
}
function rsCorrectErrata(msg, synd, errPos) {
  const coefPos = errPos.map((p) => msg.length - 1 - p);
  const errLoc = rsFindErrataLocator(coefPos);
  const errEval = rsFindErrorEvaluator(
    synd.slice().reverse(),
    errLoc,
    errLoc.length - 1
  ).reverse();
  const X = [];
  for (let i = 0; i < coefPos.length; i++) X.push(gfPow(2, -(255 - coefPos[i])));
  const E = new Array(msg.length).fill(0);
  for (let i = 0; i < X.length; i++) {
    const Xi = X[i];
    const XiInv = gfInverse(Xi);
    let errLocPrime = 1;
    for (let j = 0; j < X.length; j++) {
      if (j !== i) errLocPrime = gfMul(errLocPrime, 1 ^ gfMul(XiInv, X[j]));
    }
    if (errLocPrime === 0) throw new Error("could not solve error magnitude");
    let y = gfPolyEval(errEval.slice().reverse(), XiInv);
    y = gfMul(Xi, y);
    E[errPos[i]] = gfDiv(y, errLocPrime);
  }
  return gfPolyAdd(msg, E);
}
function rsForneySyndromes(synd, erasePos, nmess) {
  const fsynd = synd.slice(1);
  for (const position of erasePos) {
    const x = gfPow(2, nmess - 1 - position);
    for (let j = 0; j < fsynd.length - 1; j++) {
      fsynd[j] = gfMul(fsynd[j], x) ^ fsynd[j + 1];
    }
    fsynd.pop();
  }
  return [0, ...fsynd];
}
function rsDecode(codeword, nsym, erasurePositions = []) {
  const msgOut = codeword.slice();
  const erasePos = [...new Set(erasurePositions)].sort((a, b) => a - b);
  if (erasePos.length > nsym) throw new Error("too many erasures to correct");
  for (const position of erasePos) {
    if (!Number.isInteger(position) || position < 0 || position >= msgOut.length) {
      throw new Error("invalid erasure position");
    }
    msgOut[position] = 0;
  }
  const synd = rsCalcSyndromes(msgOut, nsym);
  if (Math.max(...synd) === 0) {
    return { msg: msgOut.slice(0, msgOut.length - nsym), corrected: 0, erasures: 0 };
  }
  const fsynd = rsForneySyndromes(synd, erasePos, msgOut.length);
  const errLoc = rsFindErrorLocator(fsynd, nsym, erasePos.length);
  const foundErrors = rsFindErrors(errLoc.slice().reverse(), msgOut.length);
  const errPos = [.../* @__PURE__ */ new Set([...erasePos, ...foundErrors])].sort((a, b) => a - b);
  if ((errPos.length - erasePos.length) * 2 + erasePos.length > nsym) {
    throw new Error("too many errors to correct");
  }
  const corrected = rsCorrectErrata(msgOut, synd, errPos);
  const synd2 = rsCalcSyndromes(corrected, nsym);
  if (Math.max(...synd2) > 0) throw new Error("message is too corrupted to correct");
  return {
    msg: corrected.slice(0, corrected.length - nsym),
    corrected: errPos.length,
    erasures: erasePos.length
  };
}

// src/encode.ts
function dataColumnsFromCodeword(codeword) {
  const columns = [];
  for (const byte of codeword) {
    for (const nibble of [byte >>> 4 & 15, byte & 15]) {
      columns.push({
        upperLevel: grayToLevel(nibble >>> 2 & 3),
        lowerLevel: grayToLevel(nibble & 3),
        role: "data"
      });
    }
  }
  return columns;
}
function guardColumns(levels) {
  return levels.map((level) => ({ upperLevel: level, lowerLevel: level, role: "guard" }));
}
function encodeSignal(input) {
  const frame = encodeSignalFrame(input);
  const tier = tierSpec(frame.tier);
  const codeword = rsEncode(frame.paddedData, tier.parityBytes);
  const columns = [
    ...guardColumns(LEFT_GUARD_LEVELS),
    ...dataColumnsFromCodeword(codeword),
    ...guardColumns(rightGuardLevels(frame.tier))
  ];
  return {
    version: 3,
    tier: frame.tier,
    widthModules: signalWidthModules(tier),
    heightModules: SIGNAL_SPEC.geom.heightModules,
    dataColumnOffset: SIGNAL_SPEC.geom.guardColumnsPerSide,
    dataColumns: tier.dataColumns,
    columns,
    payload: frame.payload
  };
}
function codewordFromColumns(columns) {
  if (columns.length % 2 !== 0) throw new Error("Signal data column count must be even");
  const bytes = [];
  for (let i = 0; i < columns.length; i += 2) {
    const first = columns[i];
    const second = columns[i + 1];
    const high = levelToGray(first.upperLevel) << 2 | levelToGray(first.lowerLevel);
    const low = levelToGray(second.upperLevel) << 2 | levelToGray(second.lowerLevel);
    bytes.push(high << 4 | low);
  }
  return bytes;
}
function decodeSignalColumns(tierName, columns, erasureThreshold = 0.36) {
  const tier = tierSpec(tierName);
  if (columns.length !== tier.dataColumns) throw new Error("Signal data column count does not match tier");
  const codeword = codewordFromColumns(columns);
  const erasureCandidates = [];
  for (let byte = 0; byte < codeword.length; byte++) {
    const confidence2 = Math.min(columns[byte * 2]?.confidence ?? 1, columns[byte * 2 + 1]?.confidence ?? 1);
    if (confidence2 < erasureThreshold) erasureCandidates.push({ byte, confidence: confidence2 });
  }
  const erasures = erasureCandidates.sort((a, b) => a.confidence - b.confidence).slice(0, tier.parityBytes).map((candidate) => candidate.byte);
  const corrected = rsDecode(codeword, tier.parityBytes, erasures);
  const frame = decodeSignalFrame(corrected.msg, tierName);
  const confidence = columns.reduce((sum, column) => sum + (column.confidence ?? 1), 0) / Math.max(1, columns.length);
  return {
    payload: frame.payload,
    tier: tierName,
    correctedBytes: corrected.corrected,
    erasedBytes: corrected.erasures,
    confidence
  };
}

// src/util.ts
var BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function bytesToBase64Url(bytes) {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] & 255;
    const second = index + 1 < bytes.length ? bytes[index + 1] & 255 : -1;
    const third = index + 2 < bytes.length ? bytes[index + 2] & 255 : -1;
    out += BASE64URL[first >>> 2];
    out += BASE64URL[(first & 3) << 4 | (second >= 0 ? second >>> 4 : 0)];
    if (second >= 0) out += BASE64URL[(second & 15) << 2 | (third >= 0 ? third >>> 6 : 0)];
    if (third >= 0) out += BASE64URL[third & 63];
  }
  return out;
}
function base64UrlToBytes(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error("invalid base64url payload");
  }
  const lookup = new Int16Array(128).fill(-1);
  for (let index = 0; index < BASE64URL.length; index++) lookup[BASE64URL.charCodeAt(index)] = index;
  const out = [];
  for (let index = 0; index < value.length; index += 4) {
    const a = lookup[value.charCodeAt(index)];
    const b = index + 1 < value.length ? lookup[value.charCodeAt(index + 1)] : -1;
    const c = index + 2 < value.length ? lookup[value.charCodeAt(index + 2)] : -1;
    const d = index + 3 < value.length ? lookup[value.charCodeAt(index + 3)] : -1;
    if (a < 0 || b < 0) throw new Error("invalid base64url payload");
    out.push((a << 2 | b >>> 4) & 255);
    if (c >= 0) out.push((b << 4 | c >>> 2) & 255);
    if (d >= 0) out.push((c << 6 | d) & 255);
  }
  return out;
}

// src/link.ts
var SIGNAL_LINK_PREFIX = "astra:signal:v3:";
function encodeSignalLink(input) {
  return `${SIGNAL_LINK_PREFIX}${bytesToBase64Url(encodeSignalFrame(input).bytes)}`;
}
function decodeSignalLink(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith(SIGNAL_LINK_PREFIX)) throw new Error("not an Astra Signal v3 link");
  const encoded = trimmed.slice(SIGNAL_LINK_PREFIX.length);
  const bytes = base64UrlToBytes(encoded);
  if (bytesToBase64Url(bytes) !== encoded) throw new Error("non-canonical Astra Signal link");
  return decodeSignalFrame(bytes).payload;
}

// src/raster.ts
function rasterizeSignal(layout, options = {}) {
  const scale = options.scale ?? 6;
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("raster scale must be positive");
  const width = Math.max(1, Math.round(layout.widthModules * scale));
  const height = Math.max(1, Math.round(layout.heightModules * scale));
  const foreground = options.foreground ?? [17, 17, 17];
  const background = options.background ?? [245, 245, 245];
  const data = new Uint8ClampedArray(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    data[pixel * 4] = background[0];
    data[pixel * 4 + 1] = background[1];
    data[pixel * 4 + 2] = background[2];
    data[pixel * 4 + 3] = 255;
  }
  const fill = (x0, y0, x1, y1) => {
    const left = Math.max(0, Math.floor(x0 * scale));
    const right = Math.min(width, Math.ceil(x1 * scale));
    const top = Math.max(0, Math.floor(y0 * scale));
    const bottom = Math.min(height, Math.ceil(y1 * scale));
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const index = (y * width + x) * 4;
        data[index] = foreground[0];
        data[index + 1] = foreground[1];
        data[index + 2] = foreground[2];
        data[index + 3] = 255;
      }
    }
  };
  const g = SIGNAL_SPEC.geom;
  const centerY = g.quietModules + g.halfHeightModules;
  for (let index = 0; index < layout.columns.length; index++) {
    const column = layout.columns[index];
    const x0 = g.quietModules + index * g.columnPitchModules;
    const x1 = x0 + g.columnPitchModules;
    fill(
      x0,
      centerY - levelHeightModules(column.upperLevel),
      x1,
      centerY + levelHeightModules(column.lowerLevel)
    );
  }
  return { width, height, data };
}

// src/decode.ts
function grayscale(image) {
  const gray = new Uint8Array(image.width * image.height);
  for (let i = 0; i < gray.length; i++) {
    const r = image.data[i * 4] ?? 0;
    const g = image.data[i * 4 + 1] ?? 0;
    const b = image.data[i * 4 + 2] ?? 0;
    gray[i] = r * 77 + g * 150 + b * 29 >> 8;
  }
  return gray;
}
function otsuHistogram(histogram, count) {
  let totalSum = 0;
  for (let value = 0; value < 256; value++) totalSum += value * histogram[value];
  let backgroundSum = 0;
  let backgroundWeight = 0;
  let bestVariance = -1;
  let best = 127;
  for (let value = 0; value < 256; value++) {
    backgroundWeight += histogram[value];
    if (backgroundWeight === 0) continue;
    const foregroundWeight = count - backgroundWeight;
    if (foregroundWeight === 0) break;
    backgroundSum += value * histogram[value];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (totalSum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = value;
    }
  }
  return best;
}
function otsu(gray) {
  const histogram = new Array(256).fill(0);
  for (const value of gray) histogram[value] = histogram[value] + 1;
  return otsuHistogram(histogram, gray.length);
}
function globalBinary(gray, threshold) {
  const binary = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) binary[i] = gray[i] <= threshold ? 1 : 0;
  return binary;
}
function adaptiveBinary(gray, width, height) {
  const stride = width + 1;
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += gray[y * width + x];
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
    }
  }
  const radius = Math.max(8, Math.round(Math.min(width, height) / 12));
  const binary = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width, x + radius + 1);
      const sum = integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      binary[y * width + x] = gray[y * width + x] <= mean - 7 ? 1 : 0;
    }
  }
  return binary;
}
function connectedComponents(binary, width, height) {
  const visited = new Uint8Array(binary.length);
  const stack = [];
  const blobs = [];
  for (let start = 0; start < binary.length; start++) {
    if (binary[start] !== 1 || visited[start]) continue;
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumYY = 0;
    let sumXY = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    let minSum = Infinity;
    let maxSum = -Infinity;
    let minDiff = Infinity;
    let maxDiff = -Infinity;
    let tl = [0, 0];
    let tr = [0, 0];
    let bl = [0, 0];
    let br = [0, 0];
    while (stack.length) {
      const pixel = stack.pop();
      const x = pixel % width;
      const y = (pixel - x) / width;
      area++;
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumYY += y * y;
      sumXY += x * y;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      const sum = x + y;
      const diff = x - y;
      if (sum < minSum) {
        minSum = sum;
        tl = [x, y];
      }
      if (sum > maxSum) {
        maxSum = sum;
        br = [x, y];
      }
      if (diff > maxDiff) {
        maxDiff = diff;
        tr = [x, y];
      }
      if (diff < minDiff) {
        minDiff = diff;
        bl = [x, y];
      }
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighbor = ny * width + nx;
          if (binary[neighbor] === 1 && !visited[neighbor]) {
            visited[neighbor] = 1;
            stack.push(neighbor);
          }
        }
      }
    }
    blobs.push({ area, sumX, sumY, sumXX, sumYY, sumXY, minX, maxX, minY, maxY, tl, tr, bl, br });
  }
  return blobs;
}
function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
function blobFromParts(parts) {
  const points = parts.flatMap((part) => [part.tl, part.tr, part.bl, part.br]);
  const bySum = [...points].sort((a, b) => a[0] + a[1] - b[0] - b[1]);
  const byDiff = [...points].sort((a, b) => a[0] - a[1] - b[0] + b[1]);
  return {
    area: parts.reduce((sum, part) => sum + part.area, 0),
    sumX: parts.reduce((sum, part) => sum + part.sumX, 0),
    sumY: parts.reduce((sum, part) => sum + part.sumY, 0),
    sumXX: parts.reduce((sum, part) => sum + part.sumXX, 0),
    sumYY: parts.reduce((sum, part) => sum + part.sumYY, 0),
    sumXY: parts.reduce((sum, part) => sum + part.sumXY, 0),
    minX: Math.min(...parts.map((part) => part.minX)),
    maxX: Math.max(...parts.map((part) => part.maxX)),
    minY: Math.min(...parts.map((part) => part.minY)),
    maxY: Math.max(...parts.map((part) => part.maxY)),
    tl: bySum[0],
    br: bySum[bySum.length - 1],
    bl: byDiff[0],
    tr: byDiff[byDiff.length - 1]
  };
}
function mergeable(a, b) {
  const overlap = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) + 1);
  const minHeight = Math.min(a.maxY - a.minY + 1, b.maxY - b.minY + 1);
  const left = a.minX <= b.minX ? a : b;
  const right = left === a ? b : a;
  const gap = right.minX - left.maxX - 1;
  const combinedHeight = Math.max(a.maxY, b.maxY) - Math.min(a.minY, b.minY) + 1;
  return overlap / Math.max(1, minHeight) >= 0.55 && gap >= 0 && gap <= combinedHeight * 1.5;
}
function candidateBlobs(binary, width, height, maxCandidates) {
  const components = connectedComponents(binary, width, height).filter((blob) => blob.area >= 50).sort((a, b) => b.area - a.area).slice(0, 24);
  const merged = [];
  for (let first = 0; first < components.length; first++) {
    for (let second = first + 1; second < components.length; second++) {
      if (mergeable(components[first], components[second])) {
        merged.push(blobFromParts([components[first], components[second]]));
      }
    }
  }
  return [...components, ...merged].filter((blob) => {
    const boxWidth = blob.maxX - blob.minX + 1;
    const boxHeight = blob.maxY - blob.minY + 1;
    const longSide = Math.max(boxWidth, boxHeight);
    const shortSide = Math.min(boxWidth, boxHeight);
    const fill = blob.area / (boxWidth * boxHeight);
    return blob.area >= 120 && longSide / Math.max(1, shortSide) >= 1.45 && fill >= 0.12;
  }).sort((a, b) => b.area - a.area).slice(0, maxCandidates);
}
function solveLinear(matrix, rhs) {
  const size = rhs.length;
  const work = matrix.map((row, index) => [...row, rhs[index]]);
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(work[row][column]) > Math.abs(work[pivot][column])) pivot = row;
    }
    if (Math.abs(work[pivot][column]) < 1e-9) return null;
    [work[column], work[pivot]] = [work[pivot], work[column]];
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = work[row][column] / work[column][column];
      for (let item = column; item <= size; item++) {
        work[row][item] = work[row][item] - factor * work[column][item];
      }
    }
  }
  return work.map((row, index) => row[size] / row[index]);
}
function homography(source, destination) {
  const matrix = [];
  const rhs = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = source[i];
    const [u, v] = destination[i];
    matrix.push([x, y, 1, 0, 0, 0, -x * u, -y * u]);
    rhs.push(u);
    matrix.push([0, 0, 0, x, y, 1, -x * v, -y * v]);
    rhs.push(v);
  }
  const solved = solveLinear(matrix, rhs);
  if (!solved) return null;
  return (x, y) => {
    const denominator = solved[6] * x + solved[7] * y + 1;
    return [
      (solved[0] * x + solved[1] * y + solved[2]) / denominator,
      (solved[3] * x + solved[4] * y + solved[5]) / denominator
    ];
  };
}
function quantizeHeight(height) {
  const step = SIGNAL_SPEC.geom.heightStepModules;
  const raw = height / step - 1;
  const level = Math.max(0, Math.min(3, Math.round(raw)));
  const alternate = Math.max(0, Math.min(3, raw < level ? level - 1 : level + 1));
  const error = Math.abs(height - levelHeightModules(level));
  return { level, alternate, confidence: Math.max(0, Math.min(1, 1 - error / (step * 0.55))) };
}
function pcaQuad(isForeground, blob) {
  const meanX = blob.sumX / blob.area;
  const meanY = blob.sumY / blob.area;
  const covarianceX = blob.sumXX / blob.area - meanX * meanX;
  const covarianceY = blob.sumYY / blob.area - meanY * meanY;
  const covarianceXY = blob.sumXY / blob.area - meanX * meanY;
  const angle = 0.5 * Math.atan2(2 * covarianceXY, covarianceX - covarianceY);
  let axisX = Math.cos(angle);
  let axisY = Math.sin(angle);
  if (axisX < 0) {
    axisX = -axisX;
    axisY = -axisY;
  }
  const normalX = -axisY;
  const normalY = axisX;
  let minAlong = Infinity;
  let maxAlong = -Infinity;
  for (let y = blob.minY; y <= blob.maxY; y++) {
    for (let x = blob.minX; x <= blob.maxX; x++) {
      if (!isForeground(x, y)) continue;
      const along = (x - meanX) * axisX + (y - meanY) * axisY;
      minAlong = Math.min(minAlong, along);
      maxAlong = Math.max(maxAlong, along);
    }
  }
  if (!Number.isFinite(minAlong) || maxAlong - minAlong < 8) return null;
  const endBand = Math.max(2, (maxAlong - minAlong) * 0.035);
  let leftTop = Infinity;
  let leftBottom = -Infinity;
  let rightTop = Infinity;
  let rightBottom = -Infinity;
  for (let y = blob.minY; y <= blob.maxY; y++) {
    for (let x = blob.minX; x <= blob.maxX; x++) {
      if (!isForeground(x, y)) continue;
      const dx = x - meanX;
      const dy = y - meanY;
      const along = dx * axisX + dy * axisY;
      const across = dx * normalX + dy * normalY;
      if (along <= minAlong + endBand) {
        leftTop = Math.min(leftTop, across);
        leftBottom = Math.max(leftBottom, across);
      }
      if (along >= maxAlong - endBand) {
        rightTop = Math.min(rightTop, across);
        rightBottom = Math.max(rightBottom, across);
      }
    }
  }
  if (![leftTop, leftBottom, rightTop, rightBottom].every(Number.isFinite)) return null;
  const point = (along, across) => [
    meanX + along * axisX + across * normalX,
    meanY + along * axisY + across * normalY
  ];
  return [
    point(minAlong, leftTop),
    point(maxAlong, rightTop),
    point(maxAlong, rightBottom),
    point(minAlong, leftBottom)
  ];
}
function candidateQuads(isForeground, blob) {
  const pca = pcaQuad(isForeground, blob);
  return [
    [blob.tl, blob.tr, blob.br, blob.bl],
    ...pca ? [pca] : [],
    [
      [blob.minX, blob.minY],
      [blob.maxX, blob.minY],
      [blob.maxX, blob.maxY],
      [blob.minX, blob.maxY]
    ]
  ];
}
function sampleCandidate(foreground, width, height, destination, tierName, centerOffset = 0, horizontalWarp = 0) {
  const tier = tierSpec(tierName);
  const g = SIGNAL_SPEC.geom;
  const canonicalWidth = signalWidthModules(tier);
  const source = [
    [g.quietModules, g.quietModules],
    [canonicalWidth - g.quietModules, g.quietModules],
    [canonicalWidth - g.quietModules, g.heightModules - g.quietModules],
    [g.quietModules, g.heightModules - g.quietModules]
  ];
  const map = homography(source, destination);
  if (!map) return null;
  const inkCenterX = canonicalWidth / 2;
  const inkHalfWidth = (canonicalWidth - g.quietModules * 2) / 2;
  const warpedX = (x) => {
    if (horizontalWarp === 0) return x;
    const normalized = (x - inkCenterX) / inkHalfWidth;
    return x + horizontalWarp * (normalized ** 3 - normalized) * inkHalfWidth;
  };
  const centerY = g.quietModules + g.halfHeightModules + centerOffset;
  const isForeground = (point) => {
    const x = Math.round(point[0]);
    const y = Math.round(point[1]);
    return x >= 0 && y >= 0 && x < width && y < height && foreground(x, y);
  };
  const extent = (x, direction) => {
    const increment = 0.25;
    let best = 0;
    let misses = 0;
    for (let step = 0; step <= (g.halfHeightModules + 2) / increment; step++) {
      const distanceFromCenter = step * increment;
      if (isForeground(map(warpedX(x), centerY + direction * distanceFromCenter))) {
        best = distanceFromCenter;
        misses = 0;
      } else if (++misses >= 3) break;
    }
    return best;
  };
  const totalColumns = tier.dataColumns + g.guardColumnsPerSide * 2;
  const columns = [];
  for (let index = 0; index < totalColumns; index++) {
    const centerX = g.quietModules + (index + 0.5) * g.columnPitchModules;
    const offsets = [-0.25, 0, 0.25].map((fraction) => centerX + fraction * g.columnPitchModules);
    const uppers = offsets.map((x) => extent(x, -1)).sort((a, b) => a - b);
    const lowers = offsets.map((x) => extent(x, 1)).sort((a, b) => a - b);
    columns.push({ upper: quantizeHeight(uppers[1]), lower: quantizeHeight(lowers[1]) });
  }
  return columns;
}
function oriented(columns, reverse) {
  if (!reverse) return columns.map((column) => ({ upper: { ...column.upper }, lower: { ...column.lower } }));
  return [...columns].reverse().map((column) => ({ upper: { ...column.lower }, lower: { ...column.upper } }));
}
function guardMismatch(columns, tier) {
  const guards = SIGNAL_SPEC.geom.guardColumnsPerSide;
  const expected = [...LEFT_GUARD_LEVELS, ...rightGuardLevels(tier)];
  const actual = [...columns.slice(0, guards), ...columns.slice(-guards)];
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch += Math.abs(actual[i].upper.level - expected[i]);
    mismatch += Math.abs(actual[i].lower.level - expected[i]);
  }
  return mismatch;
}
function attemptDecode(columns, tier) {
  const guards = SIGNAL_SPEC.geom.guardColumnsPerSide;
  const data = columns.slice(guards, -guards);
  const toInput = () => data.map((column) => ({
    upperLevel: column.upper.level,
    lowerLevel: column.lower.level,
    confidence: Math.min(column.upper.confidence, column.lower.confidence)
  }));
  try {
    return decodeSignalColumns(tier, toInput(), 0);
  } catch (primaryError) {
    try {
      return decodeSignalColumns(tier, toInput());
    } catch {
    }
    const alternatives = [];
    for (let index = 0; index < data.length; index++) {
      alternatives.push({ index, side: "upper", confidence: data[index].upper.confidence });
      alternatives.push({ index, side: "lower", confidence: data[index].lower.confidence });
    }
    const ambiguous = alternatives.sort((a, b) => a.confidence - b.confidence).slice(0, 4);
    for (let mask = 1; mask < 1 << ambiguous.length; mask++) {
      const changed = [];
      for (let bit = 0; bit < ambiguous.length; bit++) {
        if ((mask & 1 << bit) === 0) continue;
        const choice = ambiguous[bit];
        const item = data[choice.index][choice.side];
        changed.push({ item, level: item.level });
        item.level = item.alternate;
      }
      try {
        try {
          return decodeSignalColumns(tier, toInput(), 0);
        } catch {
          return decodeSignalColumns(tier, toInput());
        }
      } catch {
      } finally {
        for (const change of changed) change.item.level = change.level;
      }
    }
    throw primaryError;
  }
}
function aspectScore(blob, tier) {
  const observedWidth = (distance(blob.tl, blob.tr) + distance(blob.bl, blob.br)) / 2;
  const observedHeight = (distance(blob.tl, blob.bl) + distance(blob.tr, blob.br)) / 2;
  const g = SIGNAL_SPEC.geom;
  const expected = (signalWidthModules(tier) - g.quietModules * 2) / (g.heightModules - g.quietModules * 2);
  return Math.abs(Math.log(observedWidth / Math.max(1, observedHeight) / expected));
}
function decodeSignalImage(image, options = {}) {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0) {
    throw new Error("invalid image dimensions");
  }
  const pixelCount = image.width * image.height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > 1e8) throw new Error("image is too large");
  if (!Number.isSafeInteger(image.data.length) || image.data.length < pixelCount * 4) {
    throw new Error("image pixel data is truncated");
  }
  const gray = grayscale(image);
  const globalThreshold = options.threshold ?? otsu(gray);
  const liftedThresholds = [...new Set([0, 30, 46, 62, 78].map((offset) => Math.min(244, globalThreshold + offset)))];
  const passes = options.threshold === void 0 ? [
    // Whole-camera frames often contain a large near-black phone body. Otsu
    // then chooses a threshold that is excellent for separating the phone
    // from the room but too low for the optically bloomed Signal ink. Lifted
    // candidates reconnect that ink; guards, RS, frame validation, and CRC
    // still gate every successful return.
    ...liftedThresholds.map((threshold) => ({
      makeBinary: () => globalBinary(gray, threshold),
      kind: "global",
      threshold
    })),
    {
      makeBinary: () => adaptiveBinary(gray, image.width, image.height),
      kind: "adaptive"
    }
  ] : [{
    makeBinary: () => globalBinary(gray, options.threshold),
    kind: "explicit",
    threshold: options.threshold
  }];
  let lastError = new Error("could not locate an Astra Signal");
  for (const pass of passes) {
    const binary = pass.makeBinary();
    const blobs = candidateBlobs(binary, image.width, image.height, options.maxCandidates ?? 12);
    const candidateDiagnostics = blobs.map((blob) => ({
      bounds: [blob.minX, blob.minY, blob.maxX, blob.maxY],
      area: blob.area,
      bestGuardMismatch: null,
      guardMatches: 0,
      decodeAttempts: 0
    }));
    const emitDiagnostic = () => options.onDiagnostic?.({
      binary: pass.kind,
      threshold: pass.threshold,
      candidates: candidateDiagnostics
    });
    for (let blobIndex = 0; blobIndex < blobs.length; blobIndex++) {
      const blob = blobs[blobIndex];
      const diagnostic = candidateDiagnostics[blobIndex];
      const foreground = (x, y) => binary[y * image.width + x] === 1;
      const tiers = SIGNAL_SPEC.tiers.map((tier) => tier.name).sort((a, b) => aspectScore(blob, a) - aspectScore(blob, b));
      for (const tier of tiers) {
        for (const quad of candidateQuads(foreground, blob)) {
          for (const centerOffset of [0, -0.5, 0.5, -1, 1]) {
            let retryWithWarp = false;
            for (const horizontalWarp of [0, -0.04, 0.04, -0.08, 0.08]) {
              if (horizontalWarp !== 0 && !retryWithWarp) break;
              const sampled = sampleCandidate(
                foreground,
                image.width,
                image.height,
                quad,
                tier,
                centerOffset,
                horizontalWarp
              );
              if (!sampled) continue;
              for (const reverse of [false, true]) {
                const columns = oriented(sampled, reverse);
                const mismatch = guardMismatch(columns, tier);
                diagnostic.bestGuardMismatch = diagnostic.bestGuardMismatch === null ? mismatch : Math.min(diagnostic.bestGuardMismatch, mismatch);
                if (mismatch > 3) continue;
                diagnostic.guardMatches++;
                diagnostic.decodeAttempts++;
                try {
                  const result = attemptDecode(columns, tier);
                  emitDiagnostic();
                  return result;
                } catch (error) {
                  if (horizontalWarp === 0) retryWithWarp = true;
                  lastError = error;
                  diagnostic.lastDecodeError = error instanceof Error ? error.message : String(error);
                }
              }
            }
          }
        }
      }
    }
    emitDiagnostic();
  }
  throw lastError instanceof Error ? lastError : new Error("could not decode Astra Signal");
}
export {
  SIGNAL_LINK_PREFIX,
  SIGNAL_SPEC,
  decodeSignalColumns,
  decodeSignalFrame,
  decodeSignalImage,
  decodeSignalLink,
  encodeSignal,
  encodeSignalFrame,
  encodeSignalLink,
  levelHeightModules,
  rasterizeSignal,
  signalWidthModules,
  tierSpec
};
