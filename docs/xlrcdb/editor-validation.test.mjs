import test from "node:test";
import assert from "node:assert/strict";
import { parseXLRC } from "../xlrc/assets/xlrc.js";
import {
  applyFix,
  findUntimedLines,
  lintLanguages,
  lintLength,
  lintTiming,
  patchHeader,
  readHeaders,
  removeEmptyTranslations,
  replaceLanguageTag,
  syncLangsHeader,
  validateLanguageMetadata
} from "./editor-validation.js";

test("missing language headers are required", () => {
  const source = "[ti:Example]\n[ar:Artist]\n[length:00:10]\n\n[00:00.00]Lyrics\n";

  assert.deepEqual(validate(source), [
    { message: "Missing non-empty [lang:] header", line: 0 },
    { message: "Missing non-empty [langs:] header", line: 0 }
  ]);
});

test("empty language headers point to their source lines", () => {
  const source = trackSource({ lang: "", langs: "" });

  assert.deepEqual(validate(source), [
    { message: "Missing non-empty [lang:] header", line: 4 },
    { message: "Missing non-empty [langs:] header", line: 5 }
  ]);
});

test("langs covers the primary and every inline translation language", () => {
  const source = trackSource({
    lang: "ja",
    langs: "fr",
    body: "[00:00.00]例\n[>en]Example"
  });

  assert.deepEqual(validate(source), [{
    message: "[langs:] must include [lang:] and every inline translation language; missing: ja, en",
    line: 5
  }]);
});

test("language coverage is case-insensitive and permits extra declarations", () => {
  const source = trackSource({
    lang: "JA",
    langs: "fr,ja,EN",
    body: "[00:00.00]例\n[>en]Example"
  });

  assert.deepEqual(validate(source), []);
});

test("managed language headers can be read, inserted, and replaced without changing lyrics", () => {
  const original = "[ti:Example]\n[ar:Artist]\n[length:00:10]\n\n[00:00.00]Lyrics\n";
  const withLang = patchHeader(original, "lang", "ja");
  const withLangs = patchHeader(withLang, "langs", "ja,en");
  const updated = patchHeader(withLangs, "lang", "JA");

  assert.deepEqual(readHeaders(updated), {
    ar: "Artist",
    ti: "Example",
    length: "00:10",
    lang: "JA",
    langs: "ja,en"
  });
  assert.match(updated, /\n\n\[00:00\.00\]Lyrics\n$/u);
});

function validate(source) {
  return validateLanguageMetadata(parseXLRC(source), source).map(({ message, line }) => ({ message, line }));
}

function codes(issues) {
  return issues.map((issue) => issue.code);
}

function trackSource({ lang = "en", langs = "en", body = "[00:00.00]Lyrics" } = {}) {
  return [
    "[ti:Example]",
    "[ar:Artist]",
    "[length:00:10]",
    `[lang:${lang}]`,
    `[langs:${langs}]`,
    "",
    body,
    ""
  ].join("\n");
}

test("language tags must name a real language, like the data repo's CI", () => {
  const source = trackSource({ lang: "xx", langs: "xx,en", body: "[00:00.00]Lyrics\n[>en]Lyrics" });
  const issues = validateLanguageMetadata(parseXLRC(source), source);

  assert.deepEqual(codes(issues), ["invalid-language"]);
  assert.equal(issues[0].line, 4);
  assert.equal(issues[0].field, "lang");
  assert.equal(issues[0].fix, undefined);
});

test("invalid translation tags point at their first line and offer an obvious replacement", () => {
  const source = trackSource({
    lang: "ja",
    langs: "ja,english",
    body: "[00:00.00]例\n[>english]Example\n[00:01.00]例\n[>english]Example"
  });
  const [issue] = validateLanguageMetadata(parseXLRC(source), source);

  assert.equal(issue.code, "invalid-language");
  assert.equal(issue.line, 5);
  assert.equal(issue.count, 3);
  assert.deepEqual(issue.fix, { kind: "replace-language", from: "english", to: "en" });
  assert.equal(validate(applyFix(source, parseXLRC(source), issue.fix)).length, 0);
});

test("country codes used as languages get a fix", () => {
  const source = trackSource({ lang: "jp", langs: "jp" });
  const issues = validateLanguageMetadata(parseXLRC(source), source);

  assert.deepEqual(issues.map((issue) => issue.fix?.to), ["ja"]);
});

test("real but unlikely codes are warnings, not errors", () => {
  const source = trackSource({ lang: "ja", langs: "ja,kr", body: "[00:00.00]例\n[>kr]예" });
  const parsed = parseXLRC(source);

  assert.deepEqual(validate(source), []);
  const [warning] = lintLanguages(parsed, source);
  assert.equal(warning.code, "likely-language-mistake");
  assert.deepEqual(warning.fix, { kind: "replace-language", from: "kr", to: "ko" });
  assert.equal(warning.line, 5);
});

test("syncing [langs:] keeps declared tags and appends what is missing", () => {
  const source = trackSource({ lang: "ja", langs: "fr", body: "[00:00.00]例\n[>en]Example\n[>ja-Latn]rei" });
  const synced = syncLangsHeader(source, parseXLRC(source));

  assert.equal(readHeaders(synced).langs, "fr,ja,en,ja-Latn");
  assert.deepEqual(validate(synced), []);
});

test("a missing [langs:] header can be filled from [lang:]", () => {
  const source = "[ti:Example]\n[ar:Artist]\n[length:00:10]\n[lang:en]\n\n[00:00.00]Lyrics\n";
  const [issue] = validateLanguageMetadata(parseXLRC(source), source);

  assert.equal(issue.code, "missing-langs");
  assert.deepEqual(issue.fix, { kind: "sync-langs" });
  assert.equal(readHeaders(applyFix(source, parseXLRC(source), issue.fix)).langs, "en");
});

test("replacing a language tag rewrites headers and translation lines only", () => {
  const source = "[lang:ja]\n[langs:ja, english]\n\n[00:00.00]english words\n[>english]Words\n[>EN]Other\n";
  assert.equal(
    replaceLanguageTag(source, "english", "en"),
    "[lang:ja]\n[langs:ja,en]\n\n[00:00.00]english words\n[>en]Words\n[>EN]Other\n"
  );
});

test("timing lint flags out-of-order, duplicate, and past-the-end lines", () => {
  const source = trackSource({
    body: [
      "[00:05.00]one",
      "[00:03.00]two",
      "[00:03.00]three",
      "[00:03.00][v:B]duet",
      "[00:20.00]late",
      "[00:30.00]later"
    ].join("\n")
  });
  const warnings = lintTiming(parseXLRC(source), { endMs: 10000 });

  assert.deepEqual(warnings.map(({ code, line }) => [code, line]), [
    ["timestamp-order", 8],
    ["timestamp-duplicate", 9],
    ["past-end", 11]
  ]);
  assert.deepEqual(warnings[2].lines, [11, 12]);
});

test("timing lint ignores the repeat timestamps of a multi-timestamp line", () => {
  const source = trackSource({ body: "[00:01.00][00:30.00]chorus\n[00:05.00]verse" });
  assert.deepEqual(lintTiming(parseXLRC(source)), []);
});

test("timing lint flags word timing that runs backwards or before its line", () => {
  const source = trackSource({ body: "[00:01.00]<00:00.50>early<00:01.20>ok\n[00:02.00]<00:02.50>a<00:02.10>b" });
  const warnings = lintTiming(parseXLRC(source));

  assert.deepEqual(warnings.map(({ code, line }) => [code, line]), [["word-timing", 7], ["word-timing", 8]]);
});

test("empty translations are one grouped warning with a removal fix", () => {
  const source = trackSource({ langs: "en,ja", body: "[00:00.00]a\n[>ja]\n[00:01.00]b\n[>ja]   \n[00:02.00]c\n[>ja]し" });
  const [warning] = lintTiming(parseXLRC(source));

  assert.equal(warning.code, "empty-translation");
  assert.deepEqual(warning.lines, [8, 10]);
  assert.equal(removeEmptyTranslations(source).includes("[>ja]\n"), false);
  assert.match(removeEmptyTranslations(source), /\[>ja\]し/u);
});

test("length lint compares [length:] with the loaded audio", () => {
  assert.deepEqual(lintLength({ lengthSeconds: 210, audioSeconds: 211.4 }), []);
  const [warning] = lintLength({ lengthSeconds: 210, audioSeconds: 221.6, line: 3 });
  assert.equal(warning.code, "length-mismatch");
  assert.deepEqual(warning.fix, { kind: "set-length", value: "03:42" });
});

test("untimed lines are found the same way the parser rejects them", () => {
  const source = "[ti:A]\n\nfirst line\n[00:01.00]timed\n  second line\n[>en]tr\n";
  assert.deepEqual(findUntimedLines(source), [3, 5]);
});

test("a set-header fix rewrites just that header", () => {
  const source = "[ti:A]\n[ar:K - DA]\n\n[00:00.00]x\n";
  const fixed = applyFix(source, parseXLRC(source), { kind: "set-header", key: "ar", value: "K/DA" });
  assert.equal(fixed, "[ti:A]\n[ar:K/DA]\n\n[00:00.00]x\n");
});

test("an invalid tag with an obvious replacement doesn't also raise a coverage error", () => {
  const source = trackSource({ lang: "en", langs: "english,ko", body: "[00:00.00]Lyrics\n[>ko]가사" });
  const issues = validateLanguageMetadata(parseXLRC(source), source);

  assert.deepEqual(codes(issues), ["invalid-language"]);
  assert.equal(readHeaders(applyFix(source, parseXLRC(source), issues[0].fix)).langs, "en,ko");
});

test("language fixes give the same result in either order", () => {
  const source = trackSource({ lang: "ja", langs: "english", body: "[00:00.00]例\n[>en]Example" });
  const parsed = parseXLRC(source);
  const issues = validateLanguageMetadata(parsed, source);
  const invalid = issues.find((issue) => issue.code === "invalid-language");
  const coverage = issues.find((issue) => issue.code === "langs-coverage");
  assert.ok(invalid && coverage, "both errors present (ja is genuinely missing)");

  const run = (first, second) => {
    const a = applyFix(source, parsed, first.fix);
    const b = applyFix(a, parseXLRC(a), second.fix);
    return readHeaders(b).langs;
  };
  assert.equal(run(invalid, coverage), "en,ja");
  assert.equal(run(coverage, invalid), "en,ja");
});

test("replacing a tag never leaves a duplicate in [langs:]", () => {
  assert.equal(replaceLanguageTag("[langs:english,ko,en]\n", "english", "en"), "[langs:en,ko]\n");
});
