import test from "node:test";
import assert from "node:assert/strict";
import { parseXLRC } from "../xlrc/assets/xlrc.js";
import {
  autoCuts,
  clearLineWords,
  cutPoints,
  furiganaParts,
  lineWords,
  setWordTag,
  splitLine,
  splitRepeatedLine,
  stampWord,
  wordTags,
  writeLineWords
} from "./word-timing.js";
import { nudgeLineTimestamp, setLineTimestamp } from "./editor-transforms.js";

const pieces = (raw, lang) => lineWords(raw, { lang }).chips.map((chip) => chip.source);

test("the head is timestamps, voice tag and leading spaces", () => {
  assert.deepEqual(splitLine("[00:32.10][v:A] 君は").head, "[00:32.10][v:A] ");
  assert.equal(splitLine("plain text").head, "");
});

test("Latin splits at spaces; spaces and closing punctuation stay with their word", () => {
  assert.deepEqual(pieces("[00:12.40]I'm a fire-starter (yeah)", "en"), ["I'm ", "a ", "fire-", "starter ", "(yeah)"]);
  assert.deepEqual(pieces("[00:12.40] 준비됐어 난, 너는?", "ko"), ["준비됐어 ", "난, ", "너는?"]);
});

test("Japanese splits into words and keeps a kanji with its reading (the spec's example)", () => {
  assert.deepEqual(pieces("[00:12.40]私[わたし]が歌[うた]う", "ja"), ["私[わたし]", "が", "歌[うた]う"]);
  // Never inside a kanji span that has a reading.
  for (const cut of autoCuts("大切[たいせつ]な人", "ja")) assert.ok(cut === 0 || cut >= "大切[たいせつ]".length);
  assert.deepEqual(cutPoints("大切[たいせつ]な人").map((p) => p.offset), [8, 9]);
});

test("kana runs split into syllables, small kana and ー stay attached", () => {
  assert.deepEqual(pieces("[00:12.40]うっせぇわ", "ja"), ["うっ", "せぇ", "わ"]);
  assert.ok(pieces("[00:01.00]スーパー", "ja").every((p) => !/^[ーァィゥェォッャュョ]/u.test(p)));
});

test("existing word tags are chip starts and keep their times", () => {
  const raw = "[00:12.40]<00:12.40>うっせぇ<00:12.80>うっせぇ<00:13.10>うっせぇわ";
  const { chips } = lineWords(raw, { lang: "ja" });
  assert.deepEqual(chips.map((c) => [c.source, c.ms]), [["うっせぇ", 12400], ["うっせぇ", 12800], ["うっせぇわ", 13100]]);
  // Untagged text before the first tag isn't a timed word yet; it's split like untimed text.
  assert.deepEqual(lineWords("[00:01.00]hello there <00:02.00>world", { lang: "en" }).chips.map((c) => [c.source, c.ms]), [["hello ", null], ["there ", null], ["world", 2000]]);
});

test("the user's own splits win over the automatic ones, tags still count", () => {
  const raw = "[00:12.40]<00:12.40>firestarter now";
  const cuts = [4];
  assert.deepEqual(lineWords(raw, { cuts }).chips.map((c) => c.source), ["fire", "starter now"]);
  assert.deepEqual(lineWords("[00:12.40]a <00:13.00>b", { cuts: [] }).chips.map((c) => c.source), ["a ", "b"]);
});

test("stamping the first word also sets the line's timestamp, without moving other words", () => {
  let src = "[ti:x]\nI am here\n[00:15.00]next";
  const { chips } = lineWords("I am here", { lang: "en" });
  src = stampWord(src, 2, chips, 0, 12500);
  assert.equal(src.split("\n")[1], "[00:12.50]<00:12.50>I am here");
  src = stampWord(src, 2, chips.map((c, i) => (i === 0 ? { ...c, ms: 12500 } : c)), 1, 12900);
  assert.equal(src.split("\n")[1], "[00:12.50]<00:12.50>I <00:12.90>am here");
  const parsed = parseXLRC(src);
  assert.deepEqual(parsed.lines[0].words.map((w) => [w.text, w.timestamp]), [["I ", 12500], ["am here", 12900]]);
});

test("stamping refuses chips that no longer match the line", () => {
  const src = "[00:01.00]one two";
  const stale = lineWords("[00:01.00]one too").chips;
  assert.equal(stampWord(src, 1, stale, 1, 1500), src);
  assert.equal(writeLineWords(src, 1, stale), src);
});

test("moving a word tag; the first one takes the line along when they matched", () => {
  const src = "[00:12.50]<00:12.50>I <00:12.90>am";
  assert.equal(setWordTag(src, 1, 1, 13000), "[00:12.50]<00:12.50>I <00:13.00>am");
  assert.equal(setWordTag(src, 1, 0, 12300), "[00:12.30]<00:12.30>I <00:12.90>am");
  assert.equal(setWordTag("[00:12.00]<00:12.50>I", 1, 0, 12300), "[00:12.00]<00:12.30>I");
  assert.deepEqual(wordTags("[00:12.50]<00:12.50>私[わたし] <00:12.90>が"), [{ ms: 12500, label: "私" }, { ms: 12900, label: "が" }]);
});

test("retiming a line moves its words with it (but not on repeated lines)", () => {
  const src = "[00:12.50]<00:12.50>I <00:12.90>am";
  assert.equal(setLineTimestamp(src, 1, 13000), "[00:13.00]<00:13.00>I <00:13.40>am");
  assert.equal(nudgeLineTimestamp(src, 1, -50), "[00:12.45]<00:12.45>I <00:12.85>am");
  assert.equal(setLineTimestamp(src, 1, 13000, 0, { moveWords: false }), "[00:13.00]<00:12.50>I <00:12.90>am");
  assert.equal(setLineTimestamp("[00:10.00][00:20.00]<00:10.00>x", 1, 11000), "[00:11.00][00:20.00]<00:10.00>x");
});

test("clearing a line's word timing", () => {
  assert.equal(clearLineWords("[00:12.50][v:A]<00:12.50>I <00:12.90>am", 1), "[00:12.50][v:A]I am");
});

test("a repeated line becomes one line per time, in time order, words shifted", () => {
  const src = [
    "[00:10.00][01:10.00]<00:10.00>la <00:10.50>la",
    "[>en]x",
    "[00:20.00]mid",
    "[01:20.00]late",
    "[02:00.00]"
  ].join("\n");
  const result = splitRepeatedLine(src, 1);
  assert.deepEqual(result.text.split("\n"), [
    "[00:10.00]<00:10.00>la <00:10.50>la",
    "[>en]x",
    "[00:20.00]mid",
    "[01:10.00]<01:10.00>la <01:10.50>la",
    "[>en]x",
    "[01:20.00]late",
    "[02:00.00]"
  ]);
  assert.deepEqual(result.lines, [1, 4]);
  assert.equal(splitRepeatedLine("[00:10.00]once", 1), null);
});

test("furigana parts for drawing a chip", () => {
  assert.deepEqual(furiganaParts("食[た]べる"), [{ text: "食", reading: "た" }, { text: "べる" }]);
});
