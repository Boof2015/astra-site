// Word-level (karaoke) timing: the <mm:ss.xx> tags inside a lyric line. Pure, unit-tested.
//
// The XLRC spec's rules, which everything here keeps to:
// - A tag goes in front of each word or syllable: [00:12.40]<00:12.40>I'm <00:12.90>a ...
//   Whatever follows a tag up to the next one is that word, so spaces and punctuation belong
//   to the word before them, and text before the first tag isn't a timed word at all.
// - A tag prefixes a word together with its furigana: <00:12.40>私[わたし]<00:12.90>が. A tag
//   never goes inside a kanji span that has a reading.
// - The line's own [mm:ss.xx] stays, even with word tags.
//
// "Chips" are the units a line is tapped in: { start, end, source, ms } where start / end are
// offsets into the line's text with the word tags removed (furigana kept), and ms is the
// word's time or null when it isn't stamped yet.

import { formatTimestamp } from "./render.js";
import { leadingTimestamps, setLineTimestamp } from "./editor-transforms.js";

const VOICE = /^\[v:[^\]]*\]/u;
const WORD_TAG = /<(\d+):(\d{2})(?:\.(\d{1,3}))?>/gu;
// Same character classes as the vendored parser (docs/xlrc/assets/xlrc.js).
const KANA = /^[぀-ゟ゠-ヿㇰ-ㇿｦ-ﾟ]+$/u;
const KANJI = /[㐀-鿿々〆ヵヶ]/u;
// Kana that can't start a syllable (small kana, the long-vowel mark, voicing marks): they
// stay with the kana before them, so うっせぇ splits as うっ|せぇ, never う|っ|せ|ぇ.
const TRAILING_KANA = /^[ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮㇰ-ㇿｧ-ｯｰー゛゜ﾞﾟ]+$/u;
const OPENING = /^[\p{Ps}\p{Pi}]+$/u;

const segmenters = new Map();

// ── reading a line ──

// A raw source line split into its head (leading timestamps, voice tag, leading spaces) and
// the lyric body after it.
export function splitLine(raw) {
  const line = raw.replace(/\r$/u, "");
  const stamps = leadingTimestamps(line);
  let headEnd = stamps.length ? stamps[stamps.length - 1].end : 0;
  const voice = line.slice(headEnd).match(VOICE);
  if (voice) headEnd += voice[0].length;
  while (headEnd < line.length && /\s/u.test(line[headEnd])) headEnd++;
  return { head: line.slice(0, headEnd), body: line.slice(headEnd), stamps };
}

// The body's text without word tags, and where each tag sat in that text.
function readTags(body) {
  let text = "";
  let last = 0;
  const tags = [];
  for (const match of body.matchAll(WORD_TAG)) {
    text += body.slice(last, match.index);
    tags.push({ at: text.length, ms: tagMs(match) });
    last = match.index + match[0].length;
  }
  text += body.slice(last);
  return { text, tags };
}

function tagMs([, minutes, seconds, fraction = ""]) {
  return Number(minutes) * 60000 + Number(seconds) * 1000 + (fraction ? Number(fraction.padEnd(3, "0")) : 0);
}

function tag(ms) {
  return `<${formatTimestamp(Math.max(0, Math.round(ms)))}>`;
}

// Furigana the way the parser reads it: a [kana] bracket right after a kanji span is that
// span's reading. Returns the display text (readings removed), the source offset of every
// display character (plus one past the end), and the kanji spans that carry a reading.
function scanFurigana(text) {
  let display = "";
  const at = [];
  const bases = [];
  let boundary = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "[") {
      const close = text.indexOf("]", i + 1);
      const prev = display[display.length - 1];
      if (close !== -1 && prev && !/\s/u.test(prev) && prev !== "]" && KANA.test(text.slice(i + 1, close))) {
        let start = display.length;
        while (start > boundary && KANJI.test(display[start - 1])) start--;
        if (start < display.length) {
          bases.push({ start, end: display.length, reading: text.slice(i + 1, close) });
          boundary = display.length;
          i = close;
          continue;
        }
      }
    }
    at.push(i);
    display += ch;
  }
  at.push(text.length);
  return { display, at, bases };
}

// Runs of display text for drawing a chip: [{ text, reading? }].
export function furiganaParts(source) {
  const { display, bases } = scanFurigana(source);
  const parts = [];
  let cursor = 0;
  for (const base of bases) {
    if (base.start > cursor) parts.push({ text: display.slice(cursor, base.start) });
    parts.push({ text: display.slice(base.start, base.end), reading: base.reading });
    cursor = base.end;
  }
  if (cursor < display.length) parts.push({ text: display.slice(cursor) });
  return parts;
}

// Where a chip may start in this text, as source offsets: between any two characters, but not
// inside a kanji span with a reading. Each comes with the display text before it, for the
// split / join view. [{ offset, display: index into the display text }]
export function cutPoints(text) {
  const { display, at, bases } = scanFurigana(text);
  const out = [];
  for (let d = 1; d < display.length; d++) {
    if (bases.some((base) => d > base.start && d < base.end)) continue;
    out.push({ offset: at[d], display: d });
  }
  return out;
}

function segment(text, lang) {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const key = lang || "";
    let segmenter = segmenters.get(key);
    if (!segmenter) {
      try {
        segmenter = new Intl.Segmenter(lang || undefined, { granularity: "word" });
      } catch (_) {
        segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
      }
      segmenters.set(key, segmenter);
    }
    return Array.from(segmenter.segment(text), (s) => ({ segment: s.segment, index: s.index, isWordLike: Boolean(s.isWordLike) }));
  }
  // No Intl.Segmenter: words are the runs between spaces.
  return Array.from(text.matchAll(/\s+|\S+/gu), (m) => ({ segment: m[0], index: m.index, isWordLike: /\S/u.test(m[0]) }));
}

// Display offsets where a new word starts. Words come from the browser's word segmenter
// (spaces for most scripts, a dictionary for Japanese, Chinese and Thai). Spaces and closing
// punctuation stay with the word before; opening brackets and quotes go with the word after.
function wordStarts(display, lang) {
  const starts = [];
  let pending = null;
  let haveWord = false;
  for (const piece of segment(display, lang)) {
    const trimmed = piece.segment.trim();
    if (piece.isWordLike) {
      if (haveWord && pending === null && TRAILING_KANA.test(piece.segment)) continue;
      starts.push(pending ?? piece.index);
      pending = null;
      haveWord = true;
    } else if (pending === null && (!haveWord || (trimmed && OPENING.test(trimmed)))) {
      pending = piece.index;
    }
  }
  if (!haveWord && pending !== null) starts.push(pending);
  return starts;
}

// Default chip boundaries for untimed text, as source offsets (not including 0 or the end).
export function autoCuts(text, lang) {
  const { display, at, bases } = scanFurigana(text);
  if (!display.trim()) return [];
  const cuts = [];
  for (const d of wordStarts(display, lang)) {
    if (d <= 0 || d >= display.length) continue;
    if (bases.some((base) => d > base.start && d < base.end)) continue;
    cuts.push(at[d]);
  }
  return [...new Set(cuts)].sort((a, b) => a - b);
}

// A line as chips. Word tags already in the line are always chip starts. Untimed text is
// split into words automatically, unless `cuts` gives the boundaries (the user's own splits,
// as source offsets into the tag-free text; a function of that text, or an array).
// Returns { head, text, chips, endMs, stamps }; endMs is a trailing tag with no word after it.
export function lineWords(raw, { lang = "", cuts } = {}) {
  const { head, body, stamps } = splitLine(raw);
  const { text, tags } = readTags(body);
  const own = typeof cuts === "function" ? cuts(text) : cuts;
  const bounds = new Set();
  if (own) {
    for (const cut of own) bounds.add(cut);
  } else if (!tags.length) {
    for (const cut of autoCuts(text, lang)) bounds.add(cut);
  } else if (tags[0].at > 0) {
    // Untagged text before the first tag (not a timed word yet): split it like untimed text.
    for (const cut of autoCuts(text.slice(0, tags[0].at), lang)) bounds.add(cut);
  }
  const msAt = new Map();
  for (const t of tags) {
    msAt.set(t.at, t.ms);
    bounds.add(t.at);
  }
  const edges = [0, ...[...bounds].filter((b) => b > 0 && b < text.length).sort((a, b) => a - b), text.length];
  const chips = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const start = edges[i];
    const end = edges[i + 1];
    if (end <= start) continue;
    chips.push({ start, end, source: text.slice(start, end), ms: msAt.get(start) ?? null });
  }
  const endMs = text.length && msAt.has(text.length) ? msAt.get(text.length) : null;
  return { head, text, chips, endMs, stamps };
}

// The word tags of a line in order, with the text each one times (furigana removed).
export function wordTags(raw) {
  const { text, tags } = readTags(splitLine(raw).body);
  return tags.map((t, i) => {
    const end = tags[i + 1]?.at ?? text.length;
    return { ms: t.ms, label: scanFurigana(text.slice(t.at, end)).display.trim() };
  });
}

// A line's lyric text without timestamps, voice tag or word tags (furigana kept).
export function lineText(raw) {
  return readTags(splitLine(raw).body).text;
}

export function hasWordTags(raw) {
  return readTags(splitLine(raw).body).tags.length > 0;
}

// ── writing a line ──

export function joinWords(head, chips, endMs = null) {
  return head + chips.map((chip) => (chip.ms === null || chip.ms === undefined ? "" : tag(chip.ms)) + chip.source).join("") + (endMs === null ? "" : tag(endMs));
}

// Replace a line's words with `chips` (same text, new boundaries or times). Returns the
// source unchanged if the chips no longer match the line's text.
export function writeLineWords(source, lineNumber, chips) {
  const lines = source.split("\n");
  const raw = lines[lineNumber - 1];
  if (raw === undefined) return source;
  const current = lineWords(raw);
  if (chips.map((chip) => chip.source).join("") !== current.text) return source;
  lines[lineNumber - 1] = joinWords(current.head, chips, current.endMs);
  return lines.join("\n");
}

// Stamp one chip. The first word is where the line starts, so stamping it also sets the
// line's timestamp (adding one to untimed text), the way the spec's examples are written.
export function stampWord(source, lineNumber, chips, index, ms) {
  if (!chips[index]) return source;
  const time = Math.max(0, Math.round(ms));
  const next = chips.map((chip, i) => (i === index ? { ...chip, ms: time } : chip));
  let out = writeLineWords(source, lineNumber, next);
  if (out === source && chips[index].ms !== time) return source;
  if (index === 0) out = setLineTimestamp(out, lineNumber, time, 0, { moveWords: false });
  return out;
}

// Move the n-th word tag of a line. When the first word and the line started together, the
// line's timestamp moves with it.
export function setWordTag(source, lineNumber, index, ms) {
  const lines = source.split("\n");
  const raw = lines[lineNumber - 1];
  if (raw === undefined) return source;
  const { head, body, stamps } = splitLine(raw);
  const time = Math.max(0, Math.round(ms));
  let n = 0;
  let old = null;
  const nextBody = body.replace(WORD_TAG, (match, ...groups) => {
    if (n++ !== index) return match;
    old = tagMs([match, ...groups]);
    return tag(time);
  });
  if (old === null) return source;
  lines[lineNumber - 1] = head + nextBody;
  let out = lines.join("\n");
  if (index === 0 && stamps.length === 1 && Math.abs(stamps[0].ms - old) < 10) {
    out = setLineTimestamp(out, lineNumber, time, 0, { moveWords: false });
  }
  return out;
}

export function clearLineWords(source, lineNumber) {
  const lines = source.split("\n");
  const raw = lines[lineNumber - 1];
  if (raw === undefined) return source;
  const { head, body } = splitLine(raw);
  lines[lineNumber - 1] = head + body.replace(WORD_TAG, "");
  return lines.join("\n");
}

// ── lines sung more than once ──

// LRC writes a repeated line once with several timestamps ([00:30.00][01:30.00]chorus). Word
// times are absolute, so they can only fit one of those. This gives every timestamp its own
// line (with a copy of the translations, and the word times moved by the same amount), each
// placed where its time falls in the file. Returns { text, lines: new line numbers, in time
// order } or null if the line has fewer than two timestamps.
export function splitRepeatedLine(source, lineNumber) {
  const lines = source.split("\n");
  const raw = lines[lineNumber - 1];
  if (raw === undefined) return null;
  const { stamps } = splitLine(raw);
  if (stamps.length < 2) return null;
  const rest = raw.slice(stamps[stamps.length - 1].end);

  // The translation block under the line (blank lines inside it are skipped, as the parser does).
  const block = [];
  let blockEnd = lineNumber;
  for (let i = lineNumber; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (!lines[i].startsWith("[>")) break;
    block.push(lines[i]);
    blockEnd = i + 1;
  }

  const [first, ...others] = stamps;
  const copyFor = (stamp) => {
    const shifted = rest.replace(WORD_TAG, (match, ...groups) => tag(tagMs([match, ...groups]) + stamp.ms - first.ms));
    return [`[${formatTimestamp(stamp.ms)}]${shifted}`, ...block];
  };

  // Keep the first in place, then drop each copy in before the first timed line that starts
  // after it.
  const out = [...lines.slice(0, lineNumber - 1), ...copyFor(first), ...lines.slice(blockEnd)];
  const placed = [{ ms: first.ms, at: lineNumber }];
  for (const stamp of others) {
    let insertAt = out.length;
    while (insertAt > 0 && out[insertAt - 1].trim() === "") insertAt--;
    for (let i = 0; i < out.length; i++) {
      const own = leadingTimestamps(out[i]);
      if (own.length && own[0].ms > stamp.ms) {
        insertAt = i;
        break;
      }
    }
    const copy = copyFor(stamp);
    out.splice(insertAt, 0, ...copy);
    for (const p of placed) if (p.at > insertAt) p.at += copy.length;
    placed.push({ ms: stamp.ms, at: insertAt + 1 });
  }
  return { text: out.join("\n"), lines: placed.sort((a, b) => a.ms - b.ms).map((p) => p.at) };
}
