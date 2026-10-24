// Pure checks + fixes for the editor (no DOM, unit-tested in node).
//
// Issues are { code, message, line, field?, fix? }. `line` is 1-based (0 = no source line, e.g.
// a header that is missing entirely), `field` names the meta-bar input that owns the problem,
// and `fix` is plain data for applyFix(). The editor decides severity: validateLanguageMetadata
// returns what CI rejects (errors); the lint* functions return advice (warnings).

import {
  LIKELY_MISTAKES,
  isValidLanguageTag,
  languageName,
  suggestReplacement
} from "./languages.js";
import { splitRepeatedLine } from "./word-timing.js";

const HEADER_TAG_PATTERN = /^\[([A-Za-z][A-Za-z0-9_-]*):([^\]]*)\]\s*$/u;
const TRANSLATION_TAG_PATTERN = /^\[>([^\]]+)\]/u;
const EMPTY_TRANSLATION_PATTERN = /^\[>[^\]]+\]\s*$/u;

export function validateLanguageMetadata(parsed, source) {
  const { primaryLanguage, languages, translations } = readLanguageMeta(parsed);
  const errors = [];
  const canSyncLangs = Boolean(primaryLanguage) || translations.length > 0;

  if (!primaryLanguage) {
    errors.push({ code: "missing-lang", message: "Missing non-empty [lang:] header", line: findHeaderLine(source, "lang"), field: "lang" });
  }
  if (languages.length === 0) {
    errors.push({
      code: "missing-langs",
      message: "Missing non-empty [langs:] header",
      line: findHeaderLine(source, "langs"),
      field: "langs",
      ...(canSyncLangs ? { fix: { kind: "sync-langs" } } : {})
    });
  }

  // Invalid tags come first: they're usually the root cause of a coverage error too
  // ([lang:en] + [langs:english] is one mistake, not two).
  const replacements = new Map();
  for (const use of languageUses(parsed, source, { primaryLanguage, languages, translations })) {
    if (isValidLanguageTag(use.tag)) continue;
    const replacement = suggestReplacement(use.tag);
    if (replacement) replacements.set(use.tag.toLowerCase(), replacement.toLowerCase());
    errors.push({
      code: "invalid-language",
      message: replacement
        ? `"${use.tag}" is not a language code. Did you mean ${replacement} (${languageName(replacement)})?`
        : `"${use.tag}" is not a language code. Use ISO 639 / BCP 47, like ja, en or ja-Latn`,
      line: use.line,
      count: use.count,
      ...(use.field ? { field: use.field } : {}),
      ...(replacement ? { fix: { kind: "replace-language", from: use.tag, to: replacement } } : {})
    });
  }

  if (languages.length > 0) {
    // Compare as if the suggested replacements were already applied, so fixing "english"
    // doesn't leave a second error asking for "en".
    const effective = (tag) => replacements.get(tag.toLowerCase()) ?? tag.toLowerCase();
    const required = new Map();
    if (primaryLanguage) required.set(effective(primaryLanguage), primaryLanguage);
    for (const { lang } of translations) required.set(effective(lang), lang);

    const declared = new Set(languages.map(effective));
    const missing = [...required].filter(([key]) => !declared.has(key)).map(([, language]) => language);

    if (missing.length > 0) {
      errors.push({
        code: "langs-coverage",
        message: `[langs:] must include [lang:] and every inline translation language; missing: ${missing.join(", ")}`,
        line: findHeaderLine(source, "langs"),
        field: "langs",
        fix: { kind: "sync-langs" }
      });
    }
  }

  return errors;
}

// Valid codes that almost certainly mean something else ("kr" is Kanuri, not Korean).
export function lintLanguages(parsed, source) {
  const warnings = [];
  for (const use of languageUses(parsed, source, readLanguageMeta(parsed))) {
    const mistake = LIKELY_MISTAKES[use.tag.toLowerCase()];
    if (!mistake) continue;
    warnings.push({
      code: "likely-language-mistake",
      message: `${mistake.note}. Did you mean ${mistake.suggest} (${languageName(mistake.suggest)})?`,
      line: use.line,
      ...(use.field ? { field: use.field } : {}),
      fix: { kind: "replace-language", from: use.tag, to: mistake.suggest }
    });
  }
  return warnings;
}

// Timing advice: order, duplicates, lines past the end, word timing, empty translations.
// endMs: where the track ends (audio duration, else [length:]), or undefined to skip that check.
export function lintTiming(parsed, { endMs } = {}) {
  const warnings = [];
  const lines = firstTimestampPerSourceLine(parsed);

  let previous = null;
  const pastEnd = [];
  for (const line of lines) {
    if (previous && line.timestamp < previous.timestamp) {
      warnings.push({
        code: "timestamp-order",
        message: `Starts at ${formatMs(line.timestamp)}, before the line above (${formatMs(previous.timestamp)})`,
        line: line.line
      });
    } else if (previous && line.timestamp === previous.timestamp && (line.voice ?? null) === (previous.voice ?? null)) {
      warnings.push({
        code: "timestamp-duplicate",
        message: `Same timestamp as the line above (${formatMs(line.timestamp)})`,
        line: line.line
      });
    }
    previous = line;

    if (endMs !== undefined && line.timestamp > endMs + 1000) pastEnd.push(line);

    if (Array.isArray(line.words) && line.words.length > 0) {
      const before = line.words.some((word) => word.timestamp < line.timestamp);
      const backwards = line.words.some((word, i) => i > 0 && word.timestamp < line.words[i - 1].timestamp);
      if (before || backwards) {
        warnings.push({
          code: "word-timing",
          message: before ? "A word starts before its line's timestamp" : "Word timestamps go backwards",
          line: line.line
        });
      }
    }
  }

  // Word timing only fits one time, but parsers copy it to every time a repeated line is sung.
  const timesPerLine = new Map();
  for (const line of parsed?.lines ?? []) timesPerLine.set(line.line, (timesPerLine.get(line.line) ?? 0) + 1);
  for (const line of lines) {
    const times = timesPerLine.get(line.line) ?? 1;
    if (times > 1 && line.words?.length) {
      warnings.push({
        code: "word-timing-repeat",
        message: `Sung ${times} times but the word timing only fits the first`,
        line: line.line,
        fix: { kind: "split-repeat", line: line.line }
      });
    }
  }

  // A word that starts after the next line (same singer) has begun.
  const byTime = [...lines].sort((a, b) => a.timestamp - b.timestamp);
  byTime.forEach((line, i) => {
    if (!line.words?.length) return;
    const next = byTime.slice(i + 1).find((other) => (other.voice ?? null) === (line.voice ?? null) && other.timestamp > line.timestamp);
    if (next && line.words.some((word) => word.timestamp >= next.timestamp)) {
      warnings.push({
        code: "word-past-next",
        message: `A word starts after the next line does (${formatMs(next.timestamp)})`,
        line: line.line
      });
    }
  });

  if (pastEnd.length > 0) {
    warnings.push({
      code: "past-end",
      message: pastEnd.length === 1
        ? `Starts at ${formatMs(pastEnd[0].timestamp)}, after the track ends (${formatMs(endMs)})`
        : `${pastEnd.length} lines start after the track ends (${formatMs(endMs)})`,
      line: pastEnd[0].line,
      lines: pastEnd.map((line) => line.line)
    });
  }

  const empty = emptyTranslationLines(parsed);
  if (empty.length > 0) {
    warnings.push({
      code: "empty-translation",
      message: empty.length === 1 ? "Empty translation line" : `${empty.length} empty translation lines`,
      line: empty[0],
      lines: empty,
      fix: { kind: "remove-empty-translations" }
    });
  }

  return warnings;
}

// [length:] vs the loaded audio, when both are known.
export function lintLength({ lengthSeconds, audioSeconds, line = 0 }) {
  if (lengthSeconds === undefined || !Number.isFinite(audioSeconds)) return [];
  const audioRounded = Math.round(audioSeconds);
  if (Math.abs(lengthSeconds - audioRounded) <= 2) return [];
  const value = formatLength(audioRounded);
  return [{
    code: "length-mismatch",
    message: `[length:] is ${formatLength(lengthSeconds)} but the loaded audio is ${value}`,
    line,
    field: "length",
    fix: { kind: "set-length", value }
  }];
}

// Source lines (1-based) that carry text but no timestamp or tag: pasted, not yet timed.
export function findUntimedLines(source) {
  const out = [];
  source.replace(/^﻿/u, "").split(/\r?\n/u).forEach((raw, index) => {
    const line = raw.trimEnd();
    if (line.trim() !== "" && !line.startsWith("[")) out.push(index + 1);
  });
  return out;
}

// ─────────────────────────── fixes ───────────────────────────

export function fixLabel(fix) {
  switch (fix?.kind) {
    case "sync-langs": return "Fill in [langs:]";
    case "replace-language": return `Use ${fix.to}`;
    case "remove-empty-translations": return "Remove empty lines";
    case "set-length": return `Use ${fix.value}`;
    case "set-header": return `Use ${fix.value}`;
    case "split-repeat": return "Give each its own line";
    default: return "Fix";
  }
}

export function applyFix(source, parsed, fix) {
  switch (fix?.kind) {
    case "sync-langs": return syncLangsHeader(source, parsed);
    case "replace-language": return replaceLanguageTag(source, fix.from, fix.to);
    case "remove-empty-translations": return removeEmptyTranslations(source);
    case "set-length": return patchHeader(source, "length", fix.value);
    case "set-header": return patchHeader(source, fix.key, fix.value);
    case "split-repeat": return splitRepeatedLine(source, fix.line)?.text ?? source;
    default: return source;
  }
}

// [langs:] = what's declared, plus [lang:] and every translation language that's missing.
// A declared tag that is invalid but has an obvious replacement ("english" for a needed "en")
// is corrected in place rather than left beside a second copy.
export function syncLangsHeader(source, parsed) {
  const { primaryLanguage, languages, translations } = readLanguageMeta(parsed);
  const list = dedupeTags(languages);
  for (const tag of [primaryLanguage, ...translations.map((t) => t.lang)]) {
    if (!tag || list.some((have) => have.toLowerCase() === tag.toLowerCase())) continue;
    const slot = list.findIndex((have) => (
      !isValidLanguageTag(have) && suggestReplacement(have)?.toLowerCase() === tag.toLowerCase()
    ));
    if (slot >= 0) list[slot] = tag;
    else list.push(tag);
  }
  return patchHeader(source, "langs", list.join(","));
}

function dedupeTags(tags) {
  const seen = new Set();
  return tags.filter((tag) => {
    const key = tag.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Rename a language everywhere it appears: [lang:], [langs:] and [>tag] lines.
export function replaceLanguageTag(source, from, to) {
  const target = from.trim().toLowerCase();
  return source.split("\n").map((raw) => {
    const header = raw.match(/^\[(lang|langs):([^\]]*)\](\s*)$/iu);
    if (header) {
      const values = header[2].split(",").map((value) => (value.trim().toLowerCase() === target ? to : value));
      const list = header[1].toLowerCase() === "langs" ? dedupeTags(values) : values;
      return `[${header[1]}:${list.join(",")}]${header[3]}`;
    }
    const translation = raw.match(TRANSLATION_TAG_PATTERN);
    if (translation && translation[1].trim().toLowerCase() === target) {
      return `[>${to}]${raw.slice(translation[0].length)}`;
    }
    return raw;
  }).join("\n");
}

export function removeEmptyTranslations(source) {
  return source.split("\n").filter((raw) => !EMPTY_TRANSLATION_PATTERN.test(raw.replace(/\r$/u, ""))).join("\n");
}

// ─────────────────────────── header helpers ───────────────────────────

// Read the managed fields from the leading header block.
export function readHeaders(source) {
  const headers = { ar: "", ti: "", length: "", lang: "", langs: "" };
  for (const line of source.replace(/^﻿/u, "").split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    const match = line.match(HEADER_TAG_PATTERN);
    if (!match) break;
    const key = (match[1] ?? "").toLowerCase();
    if (key in headers) headers[key] = match[2] ?? "";
  }
  return headers;
}

// Replace (or insert) one header line in place, leaving the lyric body untouched.
export function patchHeader(source, key, value) {
  const lines = source.replace(/^﻿/u, "").split(/\r?\n/u);
  let lastHeader = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") {
      if (lastHeader >= 0) break;
      continue;
    }
    const match = lines[i].match(HEADER_TAG_PATTERN);
    if (!match) break;
    lastHeader = i;
    if ((match[1] ?? "").toLowerCase() === key) {
      lines[i] = `[${key}:${value}]`;
      return lines.join("\n");
    }
  }
  lines.splice(lastHeader + 1, 0, `[${key}:${value}]`);
  return lines.join("\n");
}

export function findHeaderLine(source, header) {
  const lines = source.replace(/^﻿/u, "").split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === "") continue;
    const match = lines[index].match(HEADER_TAG_PATTERN);
    if (!match) break;
    if ((match[1] ?? "").toLowerCase() === header) return index + 1;
  }
  return 0;
}

// ─────────────────────────── internals ───────────────────────────

function readLanguageMeta(parsed) {
  const meta = parsed?.meta && typeof parsed.meta === "object" ? parsed.meta : {};
  const primaryLanguage = typeof meta.lang === "string" ? meta.lang.trim() : "";
  const languages = Array.isArray(meta.langs)
    ? meta.langs
      .filter((language) => typeof language === "string")
      .map((language) => language.trim())
      .filter(Boolean)
    : [];
  const translations = [];
  if (Array.isArray(parsed?.lines)) {
    for (const line of parsed.lines) {
      if (!Array.isArray(line?.translations)) continue;
      for (const translation of line.translations) {
        if (typeof translation?.lang !== "string" || translation.lang.trim() === "") continue;
        translations.push({ lang: translation.lang.trim(), line: translation.line ?? line.line ?? 0 });
      }
    }
  }
  return { primaryLanguage, languages, translations };
}

// Each distinct tag (case-insensitive) with where a reader first meets it and how often.
function languageUses(parsed, source, { primaryLanguage, languages, translations }) {
  const uses = new Map();
  const add = (tag, line, field) => {
    const key = tag.toLowerCase();
    const use = uses.get(key);
    if (use) {
      use.count += 1;
      return;
    }
    uses.set(key, { tag, line, field, count: 1 });
  };
  if (primaryLanguage) add(primaryLanguage, findHeaderLine(source, "lang"), "lang");
  const langsLine = findHeaderLine(source, "langs");
  for (const tag of languages) add(tag, langsLine, "langs");
  // A multi-timestamp line shares one translation line across its clones; count it once.
  const seenLines = new Set();
  for (const { lang, line } of translations) {
    const key = `${line}:${lang.toLowerCase()}`;
    if (seenLines.has(key)) continue;
    seenLines.add(key);
    add(lang, line);
  }
  return [...uses.values()];
}

function firstTimestampPerSourceLine(parsed) {
  const out = [];
  const seen = new Set();
  for (const line of parsed?.lines ?? []) {
    if (seen.has(line.line)) continue;
    seen.add(line.line);
    out.push(line);
  }
  return out;
}

function emptyTranslationLines(parsed) {
  const out = new Set();
  for (const line of parsed?.lines ?? []) {
    for (const translation of line.translations ?? []) {
      if (typeof translation.text === "string" && translation.text.trim() === "") out.add(translation.line);
    }
  }
  return [...out].sort((a, b) => a - b);
}

function formatMs(ms) {
  const total = Math.max(0, Math.round(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const centis = Math.floor((total % 1000) / 10);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

function formatLength(seconds) {
  const total = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
