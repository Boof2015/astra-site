// Pure source-text transforms for timing work (no DOM, unit-tested in node).
// Line numbers are 1-based source lines; times are milliseconds.

import { formatTimestamp } from "./render.js";

const TIMESTAMP = /^\[(\d+):(\d{2})(?:\.(\d{1,3}))?\]/u;
const TRANSLATION = /^\[>([^\]]+)\](.*)$/u;
const VOICE = /^\[v:[^\]]*\]/u;
const WORD_TIMESTAMP = /<\d+:\d{2}(?:\.\d{1,3})?>/gu;

// The leading [mm:ss.xx] stamps of one raw line, with their character spans.
export function leadingTimestamps(raw) {
  const out = [];
  let cursor = 0;
  for (;;) {
    const match = raw.slice(cursor).match(TIMESTAMP);
    if (!match) break;
    const [, minutes, seconds, fraction = ""] = match;
    out.push({
      ms: Number(minutes) * 60000 + Number(seconds) * 1000 + (fraction ? Number(fraction.padEnd(3, "0")) : 0),
      start: cursor,
      end: cursor + match[0].length
    });
    cursor += match[0].length;
  }
  return out;
}

// Set the tsIndex-th leading timestamp of a line (adding one if the line has none).
export function setLineTimestamp(source, lineNumber, ms, tsIndex = 0) {
  const lines = source.split("\n");
  const raw = lines[lineNumber - 1];
  if (raw === undefined) return source;
  const stamp = `[${formatTimestamp(Math.max(0, Math.round(ms)))}]`;
  const stamps = leadingTimestamps(raw);
  const target = stamps[tsIndex];
  if (target) {
    lines[lineNumber - 1] = raw.slice(0, target.start) + stamp + raw.slice(target.end);
  } else if (stamps.length) {
    const end = stamps[stamps.length - 1].end;
    lines[lineNumber - 1] = raw.slice(0, end) + stamp + raw.slice(end);
  } else {
    lines[lineNumber - 1] = stamp + raw.replace(/^\s+/u, "");
  }
  return lines.join("\n");
}

// Shift one timestamp by deltaMs (never below zero). Lines without a timestamp are unchanged.
export function nudgeLineTimestamp(source, lineNumber, deltaMs, tsIndex = 0) {
  const raw = source.split("\n")[lineNumber - 1];
  const stamp = raw === undefined ? null : leadingTimestamps(raw)[tsIndex];
  if (!stamp) return source;
  return setLineTimestamp(source, lineNumber, stamp.ms + deltaMs, tsIndex);
}

export function insertLineBefore(source, lineNumber, text) {
  const lines = source.split("\n");
  lines.splice(Math.max(0, lineNumber - 1), 0, text);
  return lines.join("\n");
}

// Lines tap-to-time steps through: timed lines (including empty gap / end markers) and plain
// pasted text. Headers, translations, other tags and blank lines are skipped.
export function syncCandidates(source) {
  const out = [];
  source.split("\n").forEach((raw, index) => {
    const line = raw.replace(/\r$/u, "");
    if (line.trim() === "") return;
    if (TIMESTAMP.test(line) || !line.startsWith("[")) out.push(index + 1);
  });
  return out;
}

// What a reader sees on a line: no timestamps, voice tag or word timing.
export function displayText(raw) {
  let rest = raw.replace(/\r$/u, "");
  const stamps = leadingTimestamps(rest);
  if (stamps.length) rest = rest.slice(stamps[stamps.length - 1].end);
  return rest.replace(VOICE, "").replace(WORD_TIMESTAMP, "").trim();
}

// Add an empty [>tag] line to every lyric line that doesn't have one yet, at the end of its
// translation block. Gap / end markers (timed lines with no text) are skipped.
export function addTranslationLane(source, tag) {
  const want = tag.trim().toLowerCase();
  const lines = source.split("\n");
  const out = [];
  let block = null; // { has: boolean } for the current lyric line

  const closeBlock = () => {
    if (block && !block.has) out.splice(block.insertAt, 0, `[>${tag.trim()}]`);
    block = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/u, "");
    const translation = line.match(TRANSLATION);
    if (translation) {
      if (block) {
        if (translation[1].trim().toLowerCase() === want) block.has = true;
        out.push(raw);
        block.insertAt = out.length;
        continue;
      }
      out.push(raw);
      continue;
    }
    if (line.trim() === "") {
      // The parser skips blank lines without ending the block; insert before them.
      out.push(raw);
      continue;
    }
    closeBlock();
    out.push(raw);
    const isLyric = (TIMESTAMP.test(line) || !line.startsWith("[")) && displayText(line) !== "";
    if (isLyric) block = { has: false, insertAt: out.length };
  }
  closeBlock();
  return out.join("\n");
}

// The next [>tag] line with no text after fromLine (wrapping), or 0.
export function nextEmptyTranslation(source, fromLine) {
  const lines = source.split("\n");
  const total = lines.length;
  for (let step = 1; step <= total; step++) {
    const index = (fromLine - 1 + step) % total;
    const match = lines[index].replace(/\r$/u, "").match(TRANSLATION);
    if (match && match[2].trim() === "") return index + 1;
  }
  return 0;
}

// Parsed lyric lines in playback order, each tagged with where it lives in the source:
// idx (into parsed.lines), line (source line) and tsIndex (which of that line's leading
// timestamps, for multi-timestamp LRC lines). Stable for equal times.
export function playbackOrder(parsed) {
  const seen = new Map();
  return (parsed?.lines ?? [])
    .map((line, idx) => {
      const tsIndex = seen.get(line.line) ?? 0;
      seen.set(line.line, tsIndex + 1);
      return { idx, line: line.line, tsIndex, timestamp: line.timestamp, text: line.text, isEmpty: line.isEmpty };
    })
    .sort((a, b) => a.timestamp - b.timestamp || a.idx - b.idx);
}

// Keep a selection pointing at the same text across a programmatic edit: positions after the
// changed region shift by the length difference, positions inside it clamp to its new end.
export function adjustSelection(before, after, start, end) {
  if (before === after) return { start, end };
  let prefix = 0;
  const max = Math.min(before.length, after.length);
  while (prefix < max && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix++;
  const oldEnd = before.length - suffix;
  const newEnd = after.length - suffix;
  const map = (pos) => {
    if (pos <= prefix) return pos;
    if (pos >= oldEnd) return pos + (newEnd - oldEnd);
    return newEnd;
  };
  return { start: map(start), end: map(end) };
}

const HEADER_LINE = /^\[[A-Za-z][\w-]*:[^\]]*\]\s*$/u;

// Does the file have any lyric text yet (timed or not)? Empty gap markers don't count.
export function hasLyricText(source) {
  const lines = source.split("\n");
  return syncCandidates(source).some((n) => displayText(lines[n - 1]) !== "");
}

// Put lyrics (pasted, or from the audio file's tags) under the existing headers.
// An empty body (the starter "[00:00.00]") is replaced; real lyrics are kept and the new
// ones go after them. Incoming header lines are dropped when the file already has headers,
// so the user's [ti:] / [ar:] win. Returns the text and the line the lyrics start on.
export function insertLyrics(source, incoming) {
  const clean = incoming.replace(/^﻿/u, "").replace(/\r\n?/gu, "\n").replace(/\s+$/u, "");
  const lines = source.replace(/\r\n?/gu, "\n").replace(/\n+$/u, "").split("\n");

  let headerEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (!HEADER_LINE.test(lines[i]) || leadingTimestamps(lines[i]).length) break;
    headerEnd = i + 1;
  }
  const headers = lines.slice(0, headerEnd);
  const body = lines.slice(headerEnd);

  let incomingLines = clean ? clean.split("\n") : [];
  if (headers.length) {
    let skip = 0;
    while (skip < incomingLines.length && (incomingLines[skip].trim() === "" || (HEADER_LINE.test(incomingLines[skip]) && !leadingTimestamps(incomingLines[skip]).length))) skip++;
    incomingLines = incomingLines.slice(skip);
  }
  if (!incomingLines.length) incomingLines = [""];

  const keep = hasLyricText(body.join("\n"));
  const kept = keep ? body.join("\n").replace(/\s+$/u, "").split("\n") : [];
  const out = [...headers];
  if (headers.length) out.push("");
  if (keep) out.push(...kept.filter((_, i) => i > 0 || kept[0].trim() !== ""), "");
  const start = out.length + 1;
  out.push(...incomingLines);
  return { text: `${out.join("\n")}\n`, line: start };
}
