import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalTag,
  isValidLanguageTag,
  languageName,
  suggestLanguages,
  suggestReplacement
} from "./languages.js";

test("accepts real language tags, rejects non-languages (same cases as xlrcdb CI)", () => {
  for (const tag of ["en", "ja", "ja-Latn", "zh-Hans", "es-419", "id", "haw", "fil", "ja-latn", "kr", "ain", "es-001"]) {
    assert.equal(isValidLanguageTag(tag), true, tag);
  }
  for (const tag of ["xx", "zz", "jp", "english", "und", "mul", "en-u-ca-gregory", "x-private", "ja-Zzzz", "en-ZZ", ""]) {
    assert.equal(isValidLanguageTag(tag), false, tag);
  }
});

test("names and casing", () => {
  assert.equal(languageName("ja"), "Japanese");
  assert.equal(languageName("ja-latn"), "Japanese (romaji)");
  assert.equal(languageName("xx"), "");
  assert.equal(canonicalTag("ZH-hans"), "zh-Hans");
  assert.equal(canonicalTag("es-419"), "es-419");
});

test("suggestions match codes and names", () => {
  assert.equal(suggestLanguages("japanese")[0].tag, "ja");
  assert.equal(suggestLanguages("romaji")[0].tag, "ja-Latn");
  assert.equal(suggestLanguages("pinyin")[0].tag, "zh-Latn");
  assert.equal(suggestLanguages("ja")[0].tag, "ja");
  assert.equal(suggestLanguages("es-mx")[0].tag, "es-MX");
  assert.ok(suggestLanguages("").every((item) => item.name));
  assert.ok(!suggestLanguages("", { exclude: ["en"] }).some((item) => item.tag === "en"));
});

test("replacements for invalid tags", () => {
  assert.equal(suggestReplacement("english"), "en");
  assert.equal(suggestReplacement("jp"), "ja");
  assert.equal(suggestReplacement("romaji"), "ja-Latn");
  assert.equal(suggestReplacement("xx"), null);
  assert.equal(suggestReplacement("eng-x"), "en");
  assert.equal(suggestReplacement("ja-JPN"), "ja");
  assert.equal(suggestReplacement("ja-romaji"), "ja-Latn");
});

test("names exist for languages the browser's own Intl data may not know", () => {
  assert.ok(languageName("kr"));
  assert.ok(languageName("ain"));
  assert.ok(languageName("kr-Latn").includes("Latin"));
});

test("the snapshot agrees with this runtime's ICU on two-letter codes", () => {
  // Guards against a stale or truncated language-registry.js. Node's full ICU is the source
  // of truth (it is what xlrcdb CI runs); regenerate with `npm run build:languages`.
  const names = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
  const letters = "abcdefghijklmnopqrstuvwxyz";
  for (const a of letters) {
    for (const b of letters) {
      const code = a + b;
      let known = false;
      try {
        known = Boolean(names.of(code));
      } catch {}
      assert.equal(isValidLanguageTag(code), known, code);
    }
  }
});
