import test from "node:test";
import assert from "node:assert/strict";
import { parseXLRC } from "../xlrc/assets/xlrc.js";
import { summarizeSubmission, translationScript } from "./review-sheet.js";

test("summarizes timing, translation coverage and extras", () => {
  const source = [
    "[ti:A]", "[ar:B]", "[length:00:30]", "[lang:ja]", "[langs:ja,en]", "",
    "[00:01.00][v:A]私[わたし]",
    "[>en]I",
    "[00:03.00][00:20.00]<00:03.00>サビ<00:03.50>だ",
    "[>en]",
    "[00:05.00][v:B]君",
    "[00:10.00]",
    "untimed line",
    ""
  ].join("\n");
  const summary = summarizeSubmission(parseXLRC(source), source);

  assert.equal(summary.lyricLines, 3, "the repeated chorus timestamp counts once");
  assert.equal(summary.untimed, 1);
  assert.equal(summary.gaps, 1);
  assert.equal(summary.endsAt, 20000);
  // The two Japanese-script lines need English; the empty [>en] doesn't count as done.
  assert.deepEqual(summary.translations, [{ lang: "en", count: 1, total: 3, script: null, firstMissing: 9 }]);
  assert.equal(summary.furigana, true);
  assert.equal(summary.wordTiming, true);
  assert.deepEqual(summary.voices, ["A", "B"]);
});

test("a plain file has no extras", () => {
  const source = "[ti:A]\n\n[00:01.00]hello\n";
  const summary = summarizeSubmission(parseXLRC(source), source);
  assert.deepEqual(
    [summary.lyricLines, summary.translations.length, summary.furigana, summary.wordTiming, summary.voices.length],
    [1, 0, false, false, 0]
  );
});

test("translation coverage only counts lines not already in that script", () => {
  const source = [
    "[ti:A]", "[lang:en]", "[langs:en,ko]", "",
    "[00:01.00]I'm a fire starter",
    "[00:02.00]Work a lil harder",
    "[00:03.00]준비됐어 난",
    "[>en]I'm ready",
    "[00:04.00]붉게 물들일 이 순간",
    "[>en]This is the moment",
    ""
  ].join("\n");
  const { translations } = summarizeSubmission(parseXLRC(source), source);
  assert.deepEqual(translations, [{ lang: "en", count: 2, total: 2, script: "Latn", firstMissing: 0 }]);
});

test("romaji is expected on Japanese-script lines only", () => {
  const source = [
    "[ti:A]", "[lang:ja]", "[langs:ja,ja-Latn]", "",
    "[00:01.00]私[わたし]が歌[うた]う", "[>ja-Latn]watashi ga utau",
    "[00:02.00]Hello world",
    "[00:03.00]君は", "",
  ].join("\n");
  const { translations } = summarizeSubmission(parseXLRC(source), source);
  assert.deepEqual(translations, [{ lang: "ja-Latn", count: 1, total: 2, script: "Latn", firstMissing: 8 }]);
});

test("same-script translations count every line", () => {
  const source = "[ti:A]\n[lang:en]\n[langs:en,es]\n\n[00:01.00]Hello\n[>es]Hola\n[00:02.00]Bye\n";
  const { translations } = summarizeSubmission(parseXLRC(source), source);
  assert.deepEqual(translations, [{ lang: "es", count: 1, total: 2, script: null, firstMissing: 7 }]);
});

test("translation scripts come from locale data", () => {
  assert.equal(translationScript("en").code, "Latn");
  assert.equal(translationScript("ko").code, "Kore");
  assert.equal(translationScript("ja-Latn").code, "Latn");
  assert.equal(translationScript("zh-Hant").code, "Hant");
});
