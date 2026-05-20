// Vendored from @boof2015/xlrc (dist/index.js). Do not edit by hand.
// Re-copy from the xlrc repo's dist/index.js after running `npm run build` there.
// src/parser.ts
var HEADER_TAG_PATTERN = /^\[([A-Za-z][A-Za-z0-9_-]*):([^\]]*)\]$/;
var LINE_TIMESTAMP_PATTERN = /^\[(\d+):(\d{2})\.(\d{2})\](.*)$/;
var TRANSLATION_PATTERN = /^\[>([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\](.*)$/;
var VOICE_PATTERN = /^\[v:([^\]]*)\](.*)$/;
var WORD_TIMESTAMP_PATTERN = /<(\d+):(\d{2})\.(\d{2})>/g;
var ANY_ANGLE_TAG_PATTERN = /<[^>]*>/g;
var KANA_PATTERN = /^[\u3040-\u309f\u30a0-\u30ff\u31f0-\u31ff\uff66-\uff9f]+$/u;
var KANJI_PATTERN = /[\u3400-\u9fff々〆ヵヶ]/u;
var KNOWN_HEADERS = /* @__PURE__ */ new Set(["ti", "ar", "al", "by", "offset", "lang", "langs", "xlrc"]);
function parseXLRC(input) {
  const warnings = [];
  const meta = {};
  const lines = [];
  const rows = input.replace(/^\uFEFF/, "").split(/\r?\n/);
  let lastLyricLine;
  let inHeader = true;
  rows.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trimEnd();
    if (line.trim() === "") {
      return;
    }
    const translation = parseTranslationLine(line, lineNumber, warnings);
    if (translation) {
      if (!lastLyricLine) {
        warn(warnings, lineNumber, "orphan-translation", "Translation line has no preceding lyric line");
        return;
      }
      lastLyricLine.translations.push(translation);
      return;
    }
    const timestampMatch = line.match(LINE_TIMESTAMP_PATTERN);
    if (timestampMatch) {
      inHeader = false;
      const timestamp = readTimestamp(timestampMatch[1], timestampMatch[2], timestampMatch[3]);
      if (timestamp.warning) {
        warn(warnings, lineNumber, "malformed-timestamp", timestamp.warning);
        lastLyricLine = void 0;
        return;
      }
      const body = timestampMatch[4] ?? "";
      const parsedLine = parseLyricLineBody(timestamp.timestamp, body, lineNumber, warnings);
      lines.push(parsedLine);
      lastLyricLine = parsedLine;
      return;
    }
    if (inHeader) {
      const headerMatch = line.match(HEADER_TAG_PATTERN);
      if (headerMatch) {
        applyHeader(meta, headerMatch[1] ?? "", headerMatch[2] ?? "", lineNumber, warnings);
        return;
      }
    }
    if (/^\[\d+:\d/.test(line)) {
      warn(warnings, lineNumber, "malformed-timestamp", "Malformed timestamp; line was skipped");
      lastLyricLine = void 0;
      inHeader = false;
      return;
    }
    if (line.startsWith("[")) {
      warn(warnings, lineNumber, "unrecognized-line", "Unrecognized line prefix; line was skipped");
      lastLyricLine = void 0;
      inHeader = false;
      return;
    }
    warn(warnings, lineNumber, "unrecognized-line", "Line has no timestamp or supported tag; line was skipped");
    lastLyricLine = void 0;
    inHeader = false;
  });
  return { meta, lines, warnings };
}
function applyHeader(meta, key, value, line, warnings) {
  if (!KNOWN_HEADERS.has(key)) {
    meta[key] = value;
    return;
  }
  if (key === "offset") {
    const parsedOffset = Number(value);
    if (!/^[-+]?\d+$/.test(value) || !Number.isSafeInteger(parsedOffset)) {
      warn(warnings, line, "malformed-offset", "Offset header is not a valid integer");
      return;
    }
    meta.offset = parsedOffset;
    return;
  }
  if (key === "langs") {
    meta.langs = value.split(",").map((lang) => lang.trim()).filter(Boolean);
    return;
  }
  meta[key] = value;
}
function parseTranslationLine(line, lineNumber, warnings) {
  if (!line.startsWith("[>")) {
    return void 0;
  }
  const translationMatch = line.match(TRANSLATION_PATTERN);
  if (!translationMatch) {
    warn(warnings, lineNumber, "malformed-translation", "Malformed translation tag; line was skipped");
    return void 0;
  }
  let text = translationMatch[2] ?? "";
  const voiceMatch = text.match(VOICE_PATTERN);
  if (voiceMatch) {
    warn(warnings, lineNumber, "translation-voice", "Voice tags on translation lines are ignored");
    text = voiceMatch[2] ?? "";
  }
  return {
    lang: translationMatch[1] ?? "",
    text,
    line: lineNumber
  };
}
function parseLyricLineBody(timestamp, body, line, warnings) {
  let voice = null;
  let rawText = body;
  const voiceMatch = body.match(VOICE_PATTERN);
  if (voiceMatch) {
    const label = voiceMatch[1] ?? "";
    if (label.trim() === "") {
      warn(warnings, line, "empty-voice", "Empty voice tag was ignored");
    } else {
      voice = label;
    }
    rawText = voiceMatch[2] ?? "";
  }
  const parsedContent = parseLyricContent(rawText, line, warnings);
  return {
    timestamp,
    text: parsedContent.text,
    sourceText: parsedContent.sourceText,
    rawText,
    voice,
    isEmpty: parsedContent.text.length === 0 && parsedContent.words.length === 0,
    words: parsedContent.words,
    furigana: parsedContent.furigana,
    translations: [],
    line
  };
}
function parseLyricContent(rawText, line, warnings) {
  warnForMalformedWordTags(rawText, line, warnings);
  const sourceText = rawText.replace(WORD_TIMESTAMP_PATTERN, "");
  const parsedText = parseFuriganaText(sourceText, line, warnings);
  return {
    text: parsedText.text,
    sourceText,
    words: parseWords(rawText, line, warnings),
    furigana: parsedText.furigana
  };
}
function parseWords(rawText, line, warnings) {
  const matches = Array.from(rawText.matchAll(WORD_TIMESTAMP_PATTERN));
  const words = [];
  matches.forEach((match, index) => {
    const timestamp = readTimestamp(match[1], match[2], match[3]);
    if (timestamp.warning) {
      warn(warnings, line, "malformed-word-timestamp", timestamp.warning, match.index);
      return;
    }
    const segmentStart = (match.index ?? 0) + match[0].length;
    const nextMatch = matches[index + 1];
    const segmentEnd = nextMatch?.index ?? rawText.length;
    const sourceText = rawText.slice(segmentStart, segmentEnd);
    const parsedText = parseFuriganaText(sourceText, line, warnings);
    words.push({
      timestamp: timestamp.timestamp,
      text: parsedText.text,
      sourceText,
      furigana: parsedText.furigana,
      line
    });
  });
  return words;
}
function parseFuriganaText(input, line, warnings) {
  let text = "";
  const furigana = [];
  const warnedColumns = /* @__PURE__ */ new Set();
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character !== "[") {
      text += character;
      continue;
    }
    const closeIndex = input.indexOf("]", index + 1);
    if (closeIndex === -1) {
      text += character;
      continue;
    }
    const reading = input.slice(index + 1, closeIndex);
    const previousCharacter = text[text.length - 1];
    const mayBeFurigana = Boolean(previousCharacter) && !/\s/.test(previousCharacter ?? "") && previousCharacter !== "]";
    if (mayBeFurigana && isKana(reading)) {
      const start = findFuriganaBaseStart(text);
      if (start === void 0) {
        text += character;
        continue;
      }
      const base = text.slice(start);
      furigana.push({
        start,
        end: text.length,
        base,
        reading,
        line
      });
      index = closeIndex;
      continue;
    }
    if (mayBeFurigana && isKanji(previousCharacter ?? "") && !warnedColumns.has(index)) {
      warnedColumns.add(index);
      warn(warnings, line, "malformed-furigana", "Furigana reading must contain only kana", index + 1);
    }
    text += character;
  }
  return { text, furigana };
}
function warnForMalformedWordTags(rawText, line, warnings) {
  for (const match of rawText.matchAll(ANY_ANGLE_TAG_PATTERN)) {
    const tag = match[0];
    if (!/^<\d+:\d{2}\.\d{2}>$/.test(tag)) {
      warn(warnings, line, "malformed-word-timestamp", "Malformed word timestamp was treated as literal text", match.index);
    }
  }
}
function readTimestamp(minutesValue = "", secondsValue = "", centisecondsValue = "") {
  const minutes = Number.parseInt(minutesValue, 10);
  const seconds = Number.parseInt(secondsValue, 10);
  const centiseconds = Number.parseInt(centisecondsValue, 10);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || !Number.isFinite(centiseconds)) {
    return { timestamp: 0, warning: "Timestamp contains non-numeric values" };
  }
  if (seconds > 59) {
    return { timestamp: 0, warning: "Timestamp seconds must be less than 60" };
  }
  return {
    timestamp: minutes * 6e4 + seconds * 1e3 + centiseconds * 10
  };
}
function findFuriganaBaseStart(text) {
  let start = text.length;
  while (start > 0 && isKanji(text[start - 1] ?? "")) {
    start -= 1;
  }
  if (start < text.length) {
    return start;
  }
  return void 0;
}
function isKana(value) {
  return KANA_PATTERN.test(value);
}
function isKanji(value) {
  return KANJI_PATTERN.test(value);
}
function warn(warnings, line, code, message, column) {
  warnings.push({
    line,
    ...column === void 0 ? {} : { column },
    code,
    message
  });
}

// src/serializer.ts
var KNOWN_META_ORDER = ["ti", "ar", "al", "by", "offset", "lang", "langs", "xlrc"];
function serializeXLRC(file) {
  const output = [];
  const headers = serializeHeaders(file.meta);
  output.push(...headers);
  if (headers.length > 0 && file.lines.length > 0) {
    output.push("");
  }
  for (const line of file.lines) {
    output.push(serializeLine(line));
    for (const translation of line.translations) {
      output.push(`[>${translation.lang}]${translation.text}`);
    }
  }
  return `${output.join("\n")}
`;
}
function serializeHeaders(meta) {
  const headers = [];
  const usedKeys = /* @__PURE__ */ new Set();
  for (const key of KNOWN_META_ORDER) {
    const value = meta[key];
    if (value === void 0) {
      continue;
    }
    headers.push(`[${key}:${formatMetaValue(value)}]`);
    usedKeys.add(key);
  }
  const unknownKeys = Object.keys(meta).filter((key) => !usedKeys.has(key) && meta[key] !== void 0).sort();
  for (const key of unknownKeys) {
    headers.push(`[${key}:${formatMetaValue(meta[key])}]`);
  }
  return headers;
}
function serializeLine(line) {
  const timestamp = `[${formatTimestamp(line.timestamp)}]`;
  const voice = line.voice ? `[v:${line.voice}]` : "";
  const content = line.isEmpty ? "" : serializeLyricContent(line);
  return `${timestamp}${voice}${content}`;
}
function serializeLyricContent(line) {
  if (line.words.length > 0) {
    return line.words.map((word) => serializeWord(word)).join("");
  }
  return line.sourceText ?? applyFurigana(line.text, line.furigana);
}
function serializeWord(word) {
  const sourceText = word.sourceText ?? applyFurigana(word.text, word.furigana);
  return `<${formatTimestamp(word.timestamp)}>${sourceText}`;
}
function applyFurigana(text, furigana) {
  return [...furigana].sort((a, b) => b.end - a.end).reduce((output, entry) => {
    return `${output.slice(0, entry.end)}[${entry.reading}]${output.slice(entry.end)}`;
  }, text);
}
function formatMetaValue(value) {
  if (Array.isArray(value)) {
    return value.join(",");
  }
  return String(value);
}
function formatTimestamp(timestamp) {
  const safeTimestamp = Math.max(0, Math.round(timestamp));
  const minutes = Math.floor(safeTimestamp / 6e4);
  const seconds = Math.floor(safeTimestamp % 6e4 / 1e3);
  const centiseconds = Math.floor(safeTimestamp % 1e3 / 10);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
}

// src/validator.ts
var LANGUAGE_TAG_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
var KANA_PATTERN2 = /^[\u3040-\u309f\u30a0-\u30ff\u31f0-\u31ff\uff66-\uff9f]+$/u;
function validateXLRC(file) {
  const warnings = [];
  validateMeta(file, warnings);
  if (!Array.isArray(file.lines)) {
    warn2(warnings, 0, "invalid-lines", "XLRC file lines must be an array");
    return { valid: false, warnings };
  }
  file.lines.forEach((line, index) => validateLine(line, index, warnings));
  return {
    valid: warnings.length === 0,
    warnings
  };
}
function validateMeta(file, warnings) {
  if (!file.meta || typeof file.meta !== "object") {
    warn2(warnings, 0, "invalid-meta", "XLRC file meta must be an object");
    return;
  }
  if (file.meta.offset !== void 0 && !Number.isInteger(file.meta.offset)) {
    warn2(warnings, 0, "invalid-offset", "Meta offset must be an integer number of milliseconds");
  }
  if (file.meta.lang !== void 0 && !isLanguageTag(file.meta.lang)) {
    warn2(warnings, 0, "invalid-lang", "Meta lang must be a non-empty BCP 47-style language tag");
  }
  if (file.meta.langs !== void 0) {
    if (!Array.isArray(file.meta.langs)) {
      warn2(warnings, 0, "invalid-langs", "Meta langs must be an array of language tags");
    } else {
      file.meta.langs.forEach((lang) => {
        if (!isLanguageTag(lang)) {
          warn2(warnings, 0, "invalid-langs", "Meta langs contains an invalid language tag");
        }
      });
    }
  }
  for (const [key, value] of Object.entries(file.meta)) {
    if (!isSerializableMetaValue(value)) {
      warn2(warnings, 0, "invalid-meta-value", `Meta value for "${key}" must be a string, number, or string array`);
    }
  }
}
function validateLine(line, index, warnings) {
  if (!line || typeof line !== "object") {
    warn2(warnings, index + 1, "invalid-line", "Line must be an object");
    return;
  }
  const warningLine = line.line ?? index + 1;
  const lineText = typeof line.text === "string" ? line.text : "";
  if (!isValidTimestamp(line.timestamp)) {
    warn2(warnings, warningLine, "invalid-line-timestamp", "Line timestamp must be a non-negative finite integer");
  }
  if (typeof line.text !== "string") {
    warn2(warnings, warningLine, "invalid-line-text", "Line text must be a string");
  }
  if (line.sourceText !== void 0 && typeof line.sourceText !== "string") {
    warn2(warnings, warningLine, "invalid-source-text", "Line sourceText must be a string when present");
  }
  if (line.rawText !== void 0 && typeof line.rawText !== "string") {
    warn2(warnings, warningLine, "invalid-raw-text", "Line rawText must be a string when present");
  }
  if (line.voice !== void 0 && line.voice !== null && (typeof line.voice !== "string" || line.voice.length === 0)) {
    warn2(warnings, warningLine, "invalid-voice", "Line voice must be a non-empty string, null, or undefined");
  }
  if (typeof line.isEmpty !== "boolean") {
    warn2(warnings, warningLine, "invalid-empty-flag", "Line isEmpty must be a boolean");
  }
  validateFurigana(line.furigana, lineText, warningLine, warnings);
  if (!Array.isArray(line.words)) {
    warn2(warnings, warningLine, "invalid-words", "Line words must be an array");
  } else {
    line.words.forEach((word) => validateWord(word, warningLine, warnings));
  }
  if (!Array.isArray(line.translations)) {
    warn2(warnings, warningLine, "invalid-translations", "Line translations must be an array");
  } else {
    line.translations.forEach((translation) => {
      if (!isLanguageTag(translation.lang)) {
        warn2(warnings, translation.line ?? warningLine, "invalid-translation-lang", "Translation language must be a non-empty BCP 47-style tag");
      }
      if (typeof translation.text !== "string") {
        warn2(warnings, translation.line ?? warningLine, "invalid-translation-text", "Translation text must be a string");
      }
    });
  }
}
function validateWord(word, parentLine, warnings) {
  if (!word || typeof word !== "object") {
    warn2(warnings, parentLine, "invalid-word", "Word must be an object");
    return;
  }
  const warningLine = word.line ?? parentLine;
  const wordText = typeof word.text === "string" ? word.text : "";
  if (!isValidTimestamp(word.timestamp)) {
    warn2(warnings, warningLine, "invalid-word-timestamp", "Word timestamp must be a non-negative finite integer");
  }
  if (typeof word.text !== "string") {
    warn2(warnings, warningLine, "invalid-word-text", "Word text must be a string");
  }
  if (word.sourceText !== void 0 && typeof word.sourceText !== "string") {
    warn2(warnings, warningLine, "invalid-word-source-text", "Word sourceText must be a string when present");
  }
  validateFurigana(word.furigana, wordText, warningLine, warnings);
}
function validateFurigana(furigana, text, line, warnings) {
  if (!Array.isArray(furigana)) {
    warn2(warnings, line, "invalid-furigana", "Furigana must be an array");
    return;
  }
  furigana.forEach((entry) => {
    if (!Number.isInteger(entry.start) || !Number.isInteger(entry.end) || entry.start < 0 || entry.end <= entry.start) {
      warn2(warnings, entry.line ?? line, "invalid-furigana-range", "Furigana range must be a valid start/end pair");
      return;
    }
    if (entry.end > text.length) {
      warn2(warnings, entry.line ?? line, "invalid-furigana-range", "Furigana range exceeds the display text length");
      return;
    }
    if (text.slice(entry.start, entry.end) !== entry.base) {
      warn2(warnings, entry.line ?? line, "invalid-furigana-base", "Furigana base must match the referenced display text range");
    }
    if (!KANA_PATTERN2.test(entry.reading)) {
      warn2(warnings, entry.line ?? line, "invalid-furigana-reading", "Furigana reading must contain only kana");
    }
  });
}
function isValidTimestamp(value) {
  return Number.isInteger(value) && Number.isFinite(value) && value >= 0;
}
function isLanguageTag(value) {
  return typeof value === "string" && LANGUAGE_TAG_PATTERN.test(value);
}
function isSerializableMetaValue(value) {
  return value === void 0 || typeof value === "string" || typeof value === "number" || Array.isArray(value) && value.every((item) => typeof item === "string");
}
function warn2(warnings, line, code, message) {
  warnings.push({ line, code, message });
}
export {
  parseXLRC,
  serializeXLRC,
  validateXLRC
};
