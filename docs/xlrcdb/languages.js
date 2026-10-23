// Language tag validation + naming for the editor.
//
// isValidLanguageTag applies the same rules as xlrcdb/src/languages.js (the data repo's CI
// check), but against a registry snapshot generated from Node's ICU (language-registry.js)
// rather than the browser's Intl data: Chrome knows ~350 languages to Node's ~930, so a
// browser-side lookup would reject tags CI accepts. Keep the rules in sync with xlrcdb.

import { LANGUAGES, REGIONS, SCRIPTS } from "./language-registry.js";

// language[-script][-region] only. Extension and private-use subtags ("en-u-ca-gregory",
// "x-private") are not language identifiers for a set of lyrics, so they are rejected by shape.
const TAG_PATTERN = /^([A-Za-z]{2,3})(?:-([A-Za-z]{4}))?(?:-([A-Za-z]{2}|[0-9]{3}))?$/u;

// Real registry entries that resolve to a display name but do not name any single language,
// so none of them describe the lyrics in a file.
const NON_SPECIFIC_LANGUAGES = new Set(["und", "mis", "mul", "zxx"]);

// ICU resolves these to "Unknown Script" / "Unknown Region" rather than undefined, so they
// survive a plain lookup despite carrying no information.
const UNKNOWN_SCRIPT = "Zzzz";
const UNKNOWN_REGION = "ZZ";

const SCRIPT_SET = new Set(SCRIPTS);
const REGION_SET = new Set(REGIONS);

export function isValidLanguageTag(tag) {
  if (typeof tag !== "string") {
    return false;
  }

  const match = tag.trim().match(TAG_PATTERN);
  if (!match) {
    return false;
  }

  const [, language, script, region] = match;

  const languageSubtag = language.toLowerCase();
  if (NON_SPECIFIC_LANGUAGES.has(languageSubtag) || !Object.hasOwn(LANGUAGES, languageSubtag)) {
    return false;
  }

  if (script) {
    const scriptSubtag = script[0].toUpperCase() + script.slice(1).toLowerCase();
    if (scriptSubtag === UNKNOWN_SCRIPT || !SCRIPT_SET.has(scriptSubtag)) {
      return false;
    }
  }

  if (region) {
    const regionSubtag = region.toUpperCase();
    if (regionSubtag === UNKNOWN_REGION || !REGION_SET.has(regionSubtag)) {
      return false;
    }
  }

  return true;
}

// ─────────────────────────── editor-only helpers (not in CI) ───────────────────────────

// Friendlier names than ICU's "Japanese (Latin)" for the romanizations lyrics actually use.
const NAME_OVERRIDES = {
  "ja-Latn": "Japanese (romaji)",
  "zh-Latn": "Chinese (pinyin)",
  "ko-Latn": "Korean (romanized)"
};

// Shown first and when the field is empty. SPEC.md's recommended codes lead.
const COMMON = [
  ["en"],
  ["ja"],
  ["ja-Latn", "romaji romanized romanization latin"],
  ["ko"],
  ["ko-Latn", "romanized romanization romaja latin"],
  ["zh-Hans", "mandarin simplified"],
  ["zh-Hant", "mandarin cantonese traditional"],
  ["zh-Latn", "pinyin romanized romanization latin"],
  ["es"],
  ["es-419", "latin america"],
  ["fr"],
  ["de"],
  ["pt"],
  ["pt-BR", "brazil"],
  ["it"],
  ["ru"],
  ["uk"],
  ["pl"],
  ["nl"],
  ["sv"],
  ["id"],
  ["vi"],
  ["th"],
  ["fil", "tagalog"],
  ["ar"],
  ["hi"],
  ["tr"]
];

// Country codes and names people type instead of a language code. Only consulted for tags
// that fail validation, so a real code is never "corrected".
const COMMON_MISTAKES = {
  jp: "ja",
  cn: "zh-Hans",
  gr: "el",
  ua: "uk",
  cz: "cs",
  dk: "da",
  romaji: "ja-Latn",
  "ja-romaji": "ja-Latn",
  pinyin: "zh-Latn",
  "zh-pinyin": "zh-Latn"
};

// Valid codes that are almost never what a lyrics file means. Each names a real language,
// so CI accepts them; the editor only warns.
export const LIKELY_MISTAKES = {
  kr: { suggest: "ko", note: "kr is Kanuri" },
  se: { suggest: "sv", note: "se is Northern Sami" },
  br: { suggest: "pt-BR", note: "br is Breton" },
  tw: { suggest: "zh-Hant", note: "tw is Twi" }
};

// Proper casing for display and insertion: language lower, Script title, REGION upper.
export function canonicalTag(tag) {
  const match = String(tag).trim().match(TAG_PATTERN);
  if (!match) return String(tag).trim();
  const [, language, script, region] = match;
  let out = language.toLowerCase();
  if (script) out += `-${script[0].toUpperCase()}${script.slice(1).toLowerCase()}`;
  if (region) out += `-${region.toUpperCase()}`;
  return out;
}

// "Japanese", "Japanese (romaji)", "Latin American Spanish"; "" for anything invalid.
// The browser's Intl names read best when it knows the language; otherwise compose one from
// the snapshot ("Kanuri (Latin)").
export function languageName(tag) {
  if (typeof tag !== "string" || !tag.trim() || !isValidLanguageTag(tag)) return "";
  const canonical = canonicalTag(tag);
  if (NAME_OVERRIDES[canonical]) return NAME_OVERRIDES[canonical];
  const [language, ...rest] = canonical.split("-");
  if (displayName(browserLanguageNames, language)) {
    const full = displayName(browserLanguageNames, canonical);
    if (full) return full;
  }
  const qualifiers = rest.map((subtag) => (
    subtag.length === 4 ? displayName(browserScriptNames, subtag) || subtag : displayName(browserRegionNames, subtag) || subtag
  ));
  return qualifiers.length ? `${LANGUAGES[language]} (${qualifiers.join(", ")})` : LANGUAGES[language];
}

// A replacement for an invalid tag, if there's an obvious one ("jp" -> "ja", "english" -> "en").
export function suggestReplacement(tag) {
  const key = String(tag).trim().toLowerCase();
  if (!key) return null;
  if (COMMON_MISTAKES[key]) return COMMON_MISTAKES[key];
  const [best] = suggestLanguages(key, { limit: 1, minScore: 500 });
  if (best) return best.tag;
  // A real language with a broken suffix ("eng-x", "ja-JPN"): offer the language itself,
  // as its two-letter code when there is one ("eng" -> "en").
  const base = key.split(/[-_]/u)[0];
  if (base !== key && isValidLanguageTag(base)) {
    const [same] = suggestLanguages(LANGUAGES[base], { limit: 1, minScore: 700 });
    return same && languageName(same.tag) === languageName(base) ? same.tag : base;
  }
  return null;
}

let registry = null;

function entry(tag, keywords = "", common = false) {
  return { tag, name: languageName(tag), keywords, common };
}

function ensureRegistry() {
  if (registry) return registry;
  const seenTags = new Set();
  const seenNames = new Set();
  registry = [];
  for (const [tag, keywords] of COMMON) {
    const item = entry(tag, keywords, true);
    seenTags.add(tag);
    seenNames.add(item.name);
    registry.push(item);
  }
  // Two-letter codes first so an ISO 639-2 duplicate ("jpn" = Japanese) is the one dropped.
  const codes = Object.keys(LANGUAGES).sort((a, b) => a.length - b.length || a.localeCompare(b));
  for (const tag of codes) {
    if (seenTags.has(tag) || NON_SPECIFIC_LANGUAGES.has(tag)) continue;
    const item = entry(tag);
    if (!item.name || seenNames.has(item.name)) continue;
    seenTags.add(tag);
    seenNames.add(item.name);
    registry.push(item);
  }
  return registry;
}

// Ranked suggestions for a code or a language name. Empty query -> the common list.
export function suggestLanguages(query, { limit = 8, exclude = [], minScore = 0 } = {}) {
  const list = ensureRegistry();
  const skip = new Set(exclude.map((tag) => String(tag).toLowerCase()));
  const q = String(query).trim().toLowerCase();

  if (!q) {
    return list.filter((item) => item.common && !skip.has(item.tag.toLowerCase())).slice(0, limit);
  }

  const words = q.split(/\s+/u);
  const scored = [];
  for (const item of list) {
    if (skip.has(item.tag.toLowerCase())) continue;
    const score = scoreLanguage(item, q, words);
    if (score > minScore) scored.push({ item, score });
  }

  // A valid tag the registry list doesn't carry (es-MX, sr-Latn) is still a fine answer.
  if (!skip.has(q) && isValidLanguageTag(q) && !scored.some(({ item }) => item.tag.toLowerCase() === q)) {
    scored.push({ item: entry(canonicalTag(q)), score: 900 });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.item.tag.length - b.item.tag.length || a.item.tag.localeCompare(b.item.tag))
    .slice(0, limit)
    .map(({ item }) => item);
}

function scoreLanguage(item, q, words) {
  const tag = item.tag.toLowerCase();
  const name = item.name.toLowerCase();
  const haystack = `${name} ${item.keywords}`;
  const bonus = item.common ? 50 : 0;

  if (tag === q) return 1000 + bonus;
  if (tag.startsWith(q)) return 800 - tag.length + bonus;
  if (name === q) return 750 + bonus;

  // Every typed word has to hit a word of the name or keywords.
  const nameWords = haystack.split(/[\s(),]+/u).filter(Boolean);
  if (words.every((word) => nameWords.some((candidate) => candidate.startsWith(word)))) {
    return 600 + bonus;
  }
  if (name.includes(q)) return 400 + bonus;
  return 0;
}

// Display names only; validity never depends on these.
const browserLanguageNames = createDisplayNames("language");
const browserScriptNames = createDisplayNames("script");
const browserRegionNames = createDisplayNames("region");

function createDisplayNames(type) {
  try {
    return new Intl.DisplayNames(["en"], { type, fallback: "none" });
  } catch {
    return undefined;
  }
}

function displayName(displayNames, code) {
  if (!displayNames) return "";
  try {
    return displayNames.of(code) || "";
  } catch {
    return "";
  }
}
