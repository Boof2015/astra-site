import test from "node:test";
import assert from "node:assert/strict";
import { parseXLRC } from "../xlrc/assets/xlrc.js";
import {
  addTranslationLane,
  adjustSelection,
  displayText,
  insertLineBefore,
  leadingTimestamps,
  nextEmptyTranslation,
  nudgeLineTimestamp,
  playbackOrder,
  setLineTimestamp,
  syncCandidates
} from "./editor-transforms.js";
import { createHistory } from "./history.js";

test("reads leading timestamps with their spans", () => {
  assert.deepEqual(leadingTimestamps("[00:01.50][01:02.3]chorus"), [
    { ms: 1500, start: 0, end: 10 },
    { ms: 62300, start: 10, end: 19 }
  ]);
  assert.deepEqual(leadingTimestamps("plain"), []);
});

test("sets, adds and nudges timestamps", () => {
  const source = "[ti:A]\n[00:01.00]one\ntwo\n[00:05.00][00:30.00]chorus";
  assert.equal(setLineTimestamp(source, 2, 1234).split("\n")[1], "[00:01.23]one");
  assert.equal(setLineTimestamp(source, 3, 2500).split("\n")[2], "[00:02.50]two");
  assert.equal(setLineTimestamp(source, 4, 31000, 1).split("\n")[3], "[00:05.00][00:31.00]chorus");
  assert.equal(nudgeLineTimestamp(source, 2, -50).split("\n")[1], "[00:00.95]one");
  assert.equal(nudgeLineTimestamp(source, 2, -5000).split("\n")[1], "[00:00.00]one");
  assert.equal(nudgeLineTimestamp(source, 3, 50), source, "untimed lines are left alone");
});

test("tap-to-time candidates skip headers, translations and blank lines", () => {
  const source = "[ti:A]\n[ar:B]\n\n[00:01.00]one\n[>en]tr\nplain pasted\n[00:09.00]\n[v:A]odd";
  assert.deepEqual(syncCandidates(source), [4, 6, 7]);
});

test("display text drops timestamps, voice tags and word timing", () => {
  assert.equal(displayText("[00:01.00][v:A]<00:01.00>私[わたし]<00:01.50>が"), "私[わたし]が");
  assert.equal(displayText("[00:09.00]"), "");
});

test("translation lanes go at the end of each block, skipping gaps", () => {
  const source = [
    "[ti:A]",
    "",
    "[00:01.00]one",
    "[>ja]いち",
    "[00:02.00]two",
    "[>en]two (already)",
    "[00:03.00]",
    "pasted",
    "",
    "[00:04.00]four"
  ].join("\n");
  assert.equal(addTranslationLane(source, "en"), [
    "[ti:A]",
    "",
    "[00:01.00]one",
    "[>ja]いち",
    "[>en]",
    "[00:02.00]two",
    "[>en]two (already)",
    "[00:03.00]",
    "pasted",
    "[>en]",
    "",
    "[00:04.00]four",
    "[>en]"
  ].join("\n"));
});

test("finds the next empty translation, wrapping around", () => {
  const source = "[00:01.00]a\n[>en]\n[00:02.00]b\n[>en]done\n[00:03.00]c\n[>en] ";
  assert.equal(nextEmptyTranslation(source, 2), 6);
  assert.equal(nextEmptyTranslation(source, 6), 2);
  assert.equal(nextEmptyTranslation("[00:01.00]a", 1), 0);
});

test("insertLineBefore", () => {
  assert.equal(insertLineBefore("a\nb", 2, "[00:01.00]"), "a\n[00:01.00]\nb");
});

test("playback order sorts by time and keeps source identity", () => {
  const source = "[00:10.00][00:01.00]chorus\n[00:05.00]verse";
  const order = playbackOrder(parseXLRC(source));
  assert.deepEqual(order.map(({ timestamp, line, tsIndex }) => [timestamp, line, tsIndex]), [
    [1000, 1, 1],
    [5000, 2, 0],
    [10000, 1, 0]
  ]);
});

test("selections follow the text across an edit", () => {
  const before = "[00:01.00]one\n[00:02.00]two";
  const after = "[00:01.23]one\n[00:02.00]two";
  assert.deepEqual(adjustSelection(before, after, 20, 20), { start: 20, end: 20 });
  const longer = "[00:01.00]one\n[>en]\n[00:02.00]two";
  assert.deepEqual(adjustSelection(before, longer, 20, 20), { start: 26, end: 26 });
  assert.deepEqual(adjustSelection(before, longer, 2, 2), { start: 2, end: 2 });
});

test("history coalesces typing and gestures, never stamps", () => {
  const h = createHistory({ groupMs: 1000 });
  const snap = (text) => ({ text, start: text.length, end: text.length });
  h.reset(snap(""));
  h.commit(snap("a"), "type", 0);
  h.commit(snap("ab"), "type", 200);
  h.commit(snap("ab[00:01.00]"), "stamp", 300);
  h.commit(snap("ab[00:02.00]"), "stamp", 400);
  h.commit(snap("ab[00:02.10]"), "drag:1", 500);
  h.commit(snap("ab[00:02.20]"), "drag:1", 600);

  assert.equal(h.undo().text, "ab[00:02.00]", "the whole drag is one step");
  assert.equal(h.undo().text, "ab[00:01.00]", "each stamp is its own step");
  assert.equal(h.undo().text, "ab");
  assert.equal(h.undo().text, "", "the typing burst is one step");
  assert.equal(h.undo(), null);
  assert.equal(h.redo().text, "ab");
  h.commit(snap("abc"), "type", 5000);
  assert.equal(h.redo(), null, "a new edit clears redo");
});

test("history starts a new typing step after a pause", () => {
  const h = createHistory({ groupMs: 1000 });
  const snap = (text) => ({ text, start: 0, end: 0 });
  h.reset(snap(""));
  h.commit(snap("a"), "type", 0);
  h.commit(snap("ab"), "type", 2000);
  assert.equal(h.undo().text, "a");
});

test("lyrics go under the headers, replacing the empty starter body", async () => {
  const { insertLyrics, hasLyricText } = await import("./editor-transforms.js");
  const starter = "[ti:]\n[ar:]\n[length:]\n[lang:]\n[langs:]\n\n[00:00.00]\n";
  const { text, line } = insertLyrics(starter, "first line\r\nsecond line\n");
  assert.equal(text, "[ti:]\n[ar:]\n[length:]\n[lang:]\n[langs:]\n\nfirst line\nsecond line\n");
  assert.equal(line, 7);
  assert.equal(hasLyricText(starter), false);
  assert.equal(hasLyricText(text), true);
});

test("pasted lyrics keep the user's headers and drop the incoming ones", async () => {
  const { insertLyrics } = await import("./editor-transforms.js");
  const source = "[ti:Mine]\n[ar:Me]\n";
  const { text } = insertLyrics(source, "[ti:Theirs]\n[ar:Them]\n\n[00:01.00]timed already\n");
  assert.equal(text, "[ti:Mine]\n[ar:Me]\n\n[00:01.00]timed already\n");
});

test("existing lyrics are kept; new ones go after them", async () => {
  const { insertLyrics } = await import("./editor-transforms.js");
  const { text, line } = insertLyrics("[ti:A]\n\n[00:01.00]one\n\n", "two");
  assert.equal(text, "[ti:A]\n\n[00:01.00]one\n\ntwo\n");
  assert.equal(line, 5);
});

test("an empty paste just opens a line under the headers", async () => {
  const { insertLyrics } = await import("./editor-transforms.js");
  const { text, line } = insertLyrics("[ti:A]\n[ar:B]\n\n[00:00.00]\n", "");
  assert.equal(text, "[ti:A]\n[ar:B]\n\n\n");
  assert.equal(line, 4);
});
