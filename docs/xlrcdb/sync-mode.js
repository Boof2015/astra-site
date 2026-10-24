// Tap to time: play the song and press one key as each line starts. Lines come straight
// from the source (timed, untimed pasted text, and gap markers), so it works on freshly
// pasted lyrics. Every action is also a button, with its key shown, for mouse and touch.
//
// Words mode is the same thing one level down: the current line is shown as words (chips) and
// each tap stamps the next one with a <mm:ss.xx> tag. How a line is split follows the XLRC
// spec (see word-timing.js); the contributor can split a word into syllables or join words.
// The split a line was shown with is remembered (per line text) so it survives stamping,
// since only stamped words are written to the file. Lines can be skipped (left timed by line
// only, which the spec allows): a skipped line is remembered too, and tapping passes it by.
//
// hooks: {
//   getSource(): string, lang(): main language tag,
//   stamp(lineNumber, ms), insertGap(lineNumber, ms), undo(),
//   stampWord(lineNumber, chips, index, ms), setWords(lineNumber, chips),
//   clearWords(lineNumber), splitRepeat(lineNumber),
//   timeMs(): playhead in lyric time, seekLyric(ms), toggle(), isPlaying(), hasAudio(),
//   pickAudio(), pasteLyrics(), typeLyrics(), showLine(lineNumber), onClose()
// }

import { displayText, hasLyricText, leadingTimestamps, syncCandidates } from "./editor-transforms.js";
import { cutPoints, furiganaParts, lineText, lineWords } from "./word-timing.js";

const LATENCY_KEY = "xlrcdb-tap-latency";
const MODE_KEY = "xlrcdb-tap-mode";
const CUTS_KEY = "xlrcdb-word-cuts";
const SKIPS_KEY = "xlrcdb-word-skips";
const MAX_REMEMBERED = 400;
const LATENCIES = [0, 100, 150, 200, 300];

export function createSyncMode(host, hooks) {
  let open = false;
  let mode = readMode();
  let cursor = 0; // source line number
  let wordIndex = 0; // the next chip to stamp, in words mode
  let adjusting = false; // words mode: splitting / joining instead of tapping
  let sessionEdits = 0; // changes made since opening, so ⌫ never undoes earlier typing
  let latency = readLatency();
  const cutStore = readStore(CUTS_KEY, (value) => Array.isArray(value));
  const skipStore = readStore(SKIPS_KEY, (value) => value === true);
  let live = { chips: [], endMs: Infinity, lit: -2 }; // for tick(): the current line's chips

  host.innerHTML = `
    <div class="sync-head">
      <span class="sync-title">Tap to time</span>
      <div class="sync-switch" role="group" aria-label="What each tap stamps">
        <button type="button" data-act="mode-lines">Lines</button>
        <button type="button" data-act="mode-words">Words</button>
      </div>
      <span class="sync-progress"></span>
      <label class="sync-latency" title="Most people tap a little late. This makes every stamp earlier by a fixed amount.">
        <span>Tap early by</span>
        <select>${LATENCIES.map((ms) => `<option value="${ms}">${ms ? `${ms / 1000}s` : "0s"}</option>`).join("")}</select>
      </label>
      <button class="sync-exit" type="button" data-act="close">Done <kbd>Esc</kbd></button>
    </div>
    <div class="sync-noaudio">
      <p>Load the song's audio, then press <kbd>K</kbd> to play and <kbd>Space</kbd> as each line starts.</p>
      <button class="sync-load" type="button" data-act="load">Load audio</button>
    </div>
    <div class="sync-nolyrics">
      <p><strong>Tap to time needs the lyrics first.</strong> Put the words in, one line of the song per line, then play the song and tap as each line starts.</p>
      <div class="sync-nolyrics-actions">
        <button class="sync-load" type="button" data-act="paste">Paste lyrics</button>
        <button class="sync-secondary" type="button" data-act="type">Type them</button>
      </div>
    </div>
    <div class="sync-lines" aria-live="polite"></div>
    <div class="sync-hint"></div>
    <button class="sync-tap" type="button" data-act="stamp"><span class="for-lines">Stamp this line</span><span class="for-words">Stamp next word</span> <kbd>Space</kbd></button>
    <div class="sync-keys">
      <button type="button" data-act="play"><kbd>K</kbd>Play / pause</button>
      <button type="button" data-act="undo"><kbd>⌫</kbd>Undo stamp</button>
      <button type="button" data-act="up"><kbd>↑</kbd>Previous line</button>
      <button type="button" data-act="down"><kbd>↓</kbd>Next line</button>
      <button type="button" data-act="back"><kbd>←</kbd>Back 2s</button>
      <button type="button" data-act="fwd"><kbd>→</kbd>Ahead 2s</button>
      <button type="button" class="for-lines" data-act="gap"><kbd>.</kbd>Mark a gap</button>
      <button type="button" class="for-words" data-act="replay"><kbd>R</kbd>Replay line</button>
      <button type="button" class="for-words" data-act="adjust"><kbd>S</kbd>Split / join</button>
      <button type="button" class="for-words sync-skip" data-act="skip"><kbd>Tab</kbd><span>Skip line</span></button>
    </div>`;
  host.tabIndex = -1;
  const linesEl = host.querySelector(".sync-lines");
  const progressEl = host.querySelector(".sync-progress");
  const hintEl = host.querySelector(".sync-hint");
  const latencySelect = host.querySelector(".sync-latency select");
  latencySelect.value = String(latency);

  latencySelect.addEventListener("change", () => {
    latency = Number(latencySelect.value) || 0;
    try {
      localStorage.setItem(LATENCY_KEY, String(latency));
    } catch (_) {}
    // Hand focus back, or Space would keep reopening the dropdown instead of stamping.
    host.focus({ preventScroll: true });
  });
  host.addEventListener("click", (e) => {
    const cut = e.target.closest("[data-cut]");
    if (cut) return toggleCut(Number(cut.dataset.cut));
    const chip = e.target.closest("[data-chip]");
    if (chip) return pickChip(Number(chip.dataset.chip));
    const button = e.target.closest("[data-act]");
    if (button) act(button.dataset.act);
    return undefined;
  });
  // Clicking an overlay button shouldn't focus it: a focused button presses itself on
  // Space / Enter, on top of the tap-to-time action (a double stamp, or a pause).
  host.addEventListener("mousedown", (e) => {
    if (e.target.closest("button")) e.preventDefault();
  });

  function act(name) {
    switch (name) {
      case "stamp": return mode === "words" ? stampWordNow() : stamp();
      case "undo": return undo();
      case "up": return move(-1);
      case "down": return move(1);
      case "back": return hooks.seekLyric(hooks.timeMs() - 2000);
      case "fwd": return hooks.seekLyric(hooks.timeMs() + 2000);
      case "play": return hooks.toggle();
      case "gap": return gap();
      case "replay": return replay();
      case "adjust": return setAdjusting(!adjusting);
      case "skip": return skipLine();
      case "unskip": return unskip();
      case "clear-words": return clearWords();
      case "split-repeat": return splitRepeat();
      case "mode-lines": return setMode("lines");
      case "mode-words": return setMode("words");
      case "load": return hooks.pickAudio();
      case "paste": return hooks.pasteLyrics();
      case "type": return hooks.typeLyrics();
      case "close": return close();
      default: return undefined;
    }
  }

  function onKeydown(e) {
    if (!open || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.("input, textarea, select")) return;
    // Same problem for buttons outside the overlay (the play button, toolbar): take focus
    // before the key's keyup can press whatever was clicked last.
    if (document.activeElement !== host) host.focus({ preventScroll: true });
    const key = e.key;
    const words = mode === "words";
    let handled = true;
    if (key === " " || key === "Enter") {
      if (!e.repeat) act("stamp");
    } else if (key === "Backspace") {
      undo();
    } else if (key === "ArrowUp") {
      move(-1);
    } else if (key === "ArrowDown") {
      move(1);
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      const step = e.shiftKey ? 500 : 2000;
      hooks.seekLyric(hooks.timeMs() + (key === "ArrowLeft" ? -step : step));
    } else if (key === "k" || key === "K") {
      hooks.toggle();
    } else if (key === ".") {
      gap();
    } else if (key === "w" || key === "W") {
      setMode(words ? "lines" : "words");
    } else if (words && (key === "r" || key === "R")) {
      replay();
    } else if (words && key === "Tab" && !e.shiftKey) {
      skipLine();
    } else if (words && (key === "s" || key === "S")) {
      setAdjusting(!adjusting);
    } else if (key === "Escape") {
      if (adjusting) setAdjusting(false);
      else close();
    } else {
      handled = false;
    }
    if (handled) e.preventDefault();
  }
  // Buttons press on Space's keyup; swallow it while tapping.
  function onKeyup(e) {
    if (open && e.key === " " && !e.target.closest?.("input, textarea, select")) e.preventDefault();
  }
  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("keyup", onKeyup, true);
  const onResize = () => {
    if (open) fit();
  };
  window.addEventListener("resize", onResize);

  function lines() {
    return hooks.getSource().split("\n");
  }

  // Lines words mode steps through: lyric lines with text (gap markers have no words).
  function wordLines(source = hooks.getSource()) {
    const all = source.split("\n");
    return syncCandidates(source).filter((n) => displayText(all[n - 1]) !== "");
  }

  function candidates(source = hooks.getSource()) {
    return mode === "words" ? wordLines(source) : syncCandidates(source);
  }

  // ── lines ──

  function stamp() {
    if (!hooks.hasAudio() || !cursor) return;
    const ms = Math.max(0, hooks.timeMs() - latency);
    const line = cursor;
    hooks.stamp(line, ms);
    sessionEdits++;
    const next = syncCandidates(hooks.getSource()).find((n) => n > line);
    if (next) setCursor(next);
    else render();
  }

  // A timed empty line before the current one: an instrumental break, or the end marker.
  function gap() {
    if (!hooks.hasAudio() || !cursor) return;
    const ms = Math.max(0, hooks.timeMs() - latency);
    const line = cursor;
    hooks.insertGap(line, ms);
    sessionEdits++;
    setCursor(line + 1, 0);
  }

  // ── words ──

  function cutsFor(text) {
    return cutStore.get(text);
  }

  // The current line as chips (with the remembered split), or null.
  function currentWords() {
    if (!cursor) return null;
    const raw = lines()[cursor - 1];
    if (raw === undefined) return null;
    const info = lineWords(raw, { lang: hooks.lang(), cuts: cutsFor });
    return { ...info, repeat: info.stamps.length > 1 };
  }

  // Remember the split a line is shown with, so it stays put once some words are stamped.
  function remember(info, bounds = info.chips.slice(1).map((chip) => chip.start)) {
    const key = info.text;
    const same = JSON.stringify(cutStore.get(key)) === JSON.stringify(bounds);
    if (same) return;
    cutStore.delete(key);
    cutStore.set(key, bounds);
    saveStore(CUTS_KEY, cutStore);
  }

  function isSkipped(raw) {
    return skipStore.has(lineText(raw ?? ""));
  }

  // Skip: leave this line timed by line only and go on to the next line that isn't skipped.
  // On a line that's already skipped it unskips instead, and stays there to be timed.
  function skipLine() {
    if (mode !== "words" || !cursor) return;
    const all = lines();
    if (isSkipped(all[cursor - 1])) return unskip();
    const key = lineText(all[cursor - 1] ?? "");
    if (key.trim()) {
      skipStore.delete(key);
      skipStore.set(key, true);
      saveStore(SKIPS_KEY, skipStore);
    }
    const next = wordLines().find((n) => n > cursor && !isSkipped(all[n - 1]));
    if (next) setCursor(next);
    else render();
  }

  function unskip() {
    if (!cursor) return;
    if (skipStore.delete(lineText(lines()[cursor - 1] ?? ""))) saveStore(SKIPS_KEY, skipStore);
    render();
  }

  // The first line that isn't timed yet (lines), or isn't fully word-timed (words).
  function firstUnfinished(list) {
    const all = lines();
    if (mode !== "words") return list.find((n) => leadingTimestamps(all[n - 1]).length === 0);
    const lang = hooks.lang();
    return list.find((n) => !isSkipped(all[n - 1]) && lineWords(all[n - 1], { lang, cuts: cutsFor }).chips.some((chip) => chip.ms === null));
  }

  function firstUnstamped(info) {
    if (!info || !info.chips.length) return 0;
    const index = info.chips.findIndex((chip) => chip.ms === null);
    return index < 0 ? 0 : index;
  }

  function stampWordNow() {
    if (!hooks.hasAudio() || !cursor) return;
    adjusting = false;
    const info = currentWords();
    if (!info || info.repeat || !info.chips.length || wordIndex >= info.chips.length) return;
    const index = wordIndex;
    const ms = Math.max(0, hooks.timeMs() - latency);
    const line = cursor;
    remember(info);
    // Timing a word on a skipped line means it's wanted after all.
    if (skipStore.delete(info.text)) saveStore(SKIPS_KEY, skipStore);
    hooks.stampWord(line, info.chips, index, ms);
    sessionEdits++;
    if (index + 1 < info.chips.length) {
      wordIndex = index + 1;
      render();
      return;
    }
    // Last word of the line: carry on with the next line that isn't skipped, from its first word.
    const all = lines();
    const next = wordLines().find((n) => n > line && !isSkipped(all[n - 1]));
    if (next) setCursor(next, 0);
    else {
      wordIndex = info.chips.length;
      render();
    }
  }

  function pickChip(index) {
    if (mode !== "words" || adjusting) return;
    wordIndex = index;
    render();
  }

  // Hear the line again from just before it starts, and tap it from the first word.
  function replay() {
    if (!hooks.hasAudio() || !cursor) return;
    const all = lines();
    let start = leadingTimestamps(all[cursor - 1].replace(/\r$/u, ""))[0]?.ms;
    if (start === undefined) {
      const before = [...syncCandidates(hooks.getSource())].reverse().find((n) => n < cursor && leadingTimestamps(all[n - 1]).length);
      start = before ? leadingTimestamps(all[before - 1])[0].ms : 0;
    }
    hooks.seekLyric(Math.max(0, start - 1500));
    if (!hooks.isPlaying()) hooks.toggle();
    setAdjusting(false);
    wordIndex = 0;
    render();
  }

  function setAdjusting(on) {
    if (mode !== "words") return;
    adjusting = on;
    render();
  }

  // Split / join: a cut that is a chip start goes away (the two words join; if the second was
  // stamped its tag is removed), otherwise the chip is split there.
  function toggleCut(offset) {
    const info = currentWords();
    if (!info) return;
    const bounds = new Set(info.chips.slice(1).map((chip) => chip.start));
    if (bounds.has(offset)) {
      bounds.delete(offset);
      const at = info.chips.findIndex((chip) => chip.start === offset);
      remember(info, [...bounds].sort((a, b) => a - b));
      if (at > 0 && info.chips[at].ms !== null) {
        const joined = info.chips.map((chip) => ({ ...chip }));
        joined[at - 1] = { ...joined[at - 1], end: joined[at].end, source: joined[at - 1].source + joined[at].source };
        joined.splice(at, 1);
        hooks.setWords(cursor, joined);
        sessionEdits++;
      }
      if (wordIndex >= at && wordIndex > 0) wordIndex--;
    } else {
      bounds.add(offset);
      remember(info, [...bounds].sort((a, b) => a - b));
      // Keep pointing at the same word when the split lands before it.
      if (info.chips[wordIndex] && offset < info.chips[wordIndex].start) wordIndex++;
    }
    render();
  }

  function clearWords() {
    if (!cursor) return;
    const info = currentWords();
    if (!info || !info.chips.some((chip) => chip.ms !== null)) return;
    hooks.clearWords(cursor);
    sessionEdits++;
    wordIndex = 0;
    render();
  }

  function splitRepeat() {
    if (!cursor) return;
    hooks.splitRepeat(cursor);
    sessionEdits++;
    wordIndex = 0;
    render();
  }

  // ── shared ──

  // The editor calls followChange() after the undo, as it does for Cmd+Z.
  function undo() {
    if (sessionEdits > 0) hooks.undo();
  }

  // The source went back (or forward) through undo / redo, from ⌫ here or the editor's own
  // Cmd+Z: go to the line that changed, on the word that changed, and seek to just before
  // that stamp so it can be tapped again.
  function followChange(before, after, direction) {
    if (!open) return;
    sessionEdits = Math.max(0, sessionEdits + (direction === "redo" ? 1 : -1));
    const was = before.split("\n");
    const now = after.split("\n");
    let i = 0;
    while (i < was.length && i < now.length && was[i] === now[i]) i++;
    const line = i + 1;
    if (!candidates(after).includes(line)) {
      render();
      return;
    }
    const oldRaw = was[i] ?? "";
    const newRaw = now[i] ?? "";
    let index = -1;
    let ms = null;
    if (mode === "words") {
      const lang = hooks.lang();
      const old = lineWords(oldRaw, { lang, cuts: cutsFor });
      const cur = lineWords(newRaw, { lang, cuts: cutsFor });
      if (old.text === cur.text) {
        const oldMs = new Map(old.chips.map((chip) => [chip.start, chip.ms]));
        index = cur.chips.findIndex((chip) => (oldMs.get(chip.start) ?? null) !== chip.ms);
        if (index >= 0) ms = oldMs.get(cur.chips[index].start) ?? cur.chips[index].ms;
        // A redone stamp is done again: carry on from the word after it.
        if (index >= 0 && direction === "redo" && index + 1 < cur.chips.length) index++;
      }
    }
    if (ms === null) ms = leadingTimestamps(direction === "redo" ? newRaw : oldRaw)[0]?.ms ?? null;
    setCursor(line, index >= 0 ? index : undefined);
    if (ms !== null && hooks.hasAudio()) hooks.seekLyric(Math.max(0, ms - 2000));
  }

  function move(direction) {
    const list = candidates();
    if (!list.length) return;
    const index = list.indexOf(cursor);
    const at = index < 0 ? list.findIndex((n) => n > cursor) : index + direction;
    setCursor(list[Math.min(list.length - 1, Math.max(0, at < 0 ? list.length - 1 : at))]);
  }

  // index: the chip to start from (words mode); defaults to the first unstamped one.
  function setCursor(line, index) {
    cursor = line;
    adjusting = false;
    wordIndex = index ?? firstUnstamped(currentWords());
    render();
    hooks.showLine(line);
  }

  function setMode(next, { quiet = false } = {}) {
    if (next === mode) return;
    mode = next;
    adjusting = false;
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch (_) {}
    if (quiet) return;
    const list = candidates();
    if (!list.includes(cursor)) cursor = firstUnfinished(list) ?? list.find((n) => n > cursor) ?? list[list.length - 1] ?? 0;
    wordIndex = firstUnstamped(currentWords());
    render();
    if (cursor) hooks.showLine(cursor);
  }

  // ── drawing ──

  function render() {
    if (!open) return;
    const source = hooks.getSource();
    const noLyrics = !hasLyricText(source);
    const words = mode === "words";
    host.classList.toggle("no-lyrics", noLyrics);
    host.classList.toggle("no-audio", !noLyrics && !hooks.hasAudio());
    host.classList.toggle("words", words);
    host.classList.toggle("adjusting", words && adjusting);
    for (const button of host.querySelectorAll(".sync-switch button")) {
      button.classList.toggle("active", button.dataset.act === `mode-${mode}`);
      button.setAttribute("aria-pressed", String(button.dataset.act === `mode-${mode}`));
    }
    host.querySelector('[data-act="adjust"]').classList.toggle("active", adjusting);
    const skipHere = words && cursor > 0 && isSkipped(source.split("\n")[cursor - 1]);
    host.querySelector(".sync-skip span").textContent = skipHere ? "Unskip line" : "Skip line";
    const all = source.split("\n");
    const list = candidates(source);
    live = { chips: [], endMs: Infinity, lit: -2 };
    if (noLyrics || !list.length) {
      linesEl.innerHTML = "";
      progressEl.textContent = "";
      hintEl.textContent = "";
      fit();
      return;
    }
    if (!list.includes(cursor)) cursor = list.find((n) => n >= cursor) ?? list[list.length - 1];
    const index = list.indexOf(cursor);
    const info = words ? currentWords() : null;
    if (info && !info.repeat) {
      remember(info);
      wordIndex = Math.min(wordIndex, info.chips.length);
    }

    if (words) {
      const lang = hooks.lang();
      let done = 0;
      let skipped = 0;
      for (const n of list) {
        const { chips } = lineWords(all[n - 1], { lang, cuts: cutsFor });
        if (chips.length > 0 && chips.every((chip) => chip.ms !== null)) done++;
        else if (isSkipped(all[n - 1])) skipped++;
      }
      progressEl.textContent = `${done} / ${list.length} word-timed${skipped ? ` · ${skipped} skipped` : ""}`;
    } else {
      const timed = list.filter((n) => leadingTimestamps(all[n - 1]).length > 0).length;
      progressEl.textContent = `${timed} / ${list.length} timed`;
    }

    const rows = [-2, -1, 0, 1, 2].map((offset) => {
      const n = list[index + offset];
      if (!n) return `<div class="sync-line pad${Math.abs(offset) === 2 ? " far" : ""}"></div>`;
      const { text, ms } = describe(all[n - 1]);
      const time = ms === null ? '<span class="sync-ts none">not timed</span>' : `<span class="sync-ts">${formatMs(ms)}</span>`;
      const skipped = words && isSkipped(all[n - 1]);
      if (offset === 0 && info) {
        return `<div class="sync-line cur words${skipped ? " skipped" : ""}">${time}${info.repeat ? repeatHtml(info) : adjusting ? adjustHtml(info) : chipsHtml(info)}</div>`;
      }
      const cls = offset === 0 ? "cur" : Math.abs(offset) === 1 ? "near" : "far";
      const body = text ? partsHtml(text) : '<span class="sync-gap">♪ gap / end</span>';
      const mark = skipped ? '<span class="sync-skipped">skipped</span>' : "";
      return `<div class="sync-line ${cls}">${time}<span class="sync-text">${body}</span>${mark}</div>`;
    });
    linesEl.innerHTML = rows.join("");

    // One short line of guidance; at the very end it says how to mark where the lyrics end.
    const last = index === list.length - 1;
    let hint = "";
    let end = false;
    if (words) {
      const skippedHere = cursor && isSkipped(all[cursor - 1]);
      const finished = info && wordIndex >= info.chips.length;
      if (info?.repeat) hint = "";
      else if (adjusting) hint = 'Click between letters to split, or on a divider to join. <kbd>Esc</kbd> when done. <button type="button" class="sync-link" data-act="clear-words">Clear word times</button>';
      else if (last && finished) (hint = "Last word stamped. Press <kbd>.</kbd> to mark where the lyrics end."), (end = true);
      else if (skippedHere) hint = 'Skipped: keeps its line time, no word timing. <kbd>Tab</kbd> to <button type="button" class="sync-link" data-act="unskip">unskip</button>, or stamp a word.';
      else hint = "Press <kbd>Space</kbd> as each word starts. Click a word to start there. <kbd>Tab</kbd> skips a line.";
    } else if (last) {
      hint = "Last line. After its final word, press <kbd>.</kbd> to mark where the lyrics end.";
      end = true;
    } else {
      hint = "Press <kbd>Space</kbd> as each line starts.";
    }
    hintEl.innerHTML = hint;
    hintEl.classList.toggle("end", end);

    if (words) {
      if (info && !info.repeat && !adjusting) {
        const nextLine = list[index + 1];
        const nextStart = nextLine ? leadingTimestamps(all[nextLine - 1])[0]?.ms : undefined;
        live = {
          chips: [...linesEl.querySelectorAll(".sync-chip")],
          times: info.chips.map((chip) => chip.ms),
          endMs: nextStart ?? Infinity,
          lit: -2
        };
        tick();
      }
    }
    fit();
  }

  // Keep everything on screen without scrolling where possible: in a short window, drop the
  // outer lines above and below first, then the hint. Measured after each render, before
  // paint, so nothing flickers.
  function fit() {
    host.classList.remove("tight", "tighter");
    const fits = () => host.scrollHeight <= host.clientHeight + 1; // allow a pixel of rounding
    if (host.hidden || fits()) return;
    host.classList.add("tight");
    if (fits()) return;
    host.classList.add("tighter");
  }

  function chipsHtml(info) {
    if (!info.chips.length) return '<span class="sync-text"><span class="sync-gap">No words on this line</span></span>';
    const chips = info.chips.map((chip, i) => {
      const cls = ["sync-chip", chip.ms !== null ? "stamped" : "", i === wordIndex ? "next" : ""].filter(Boolean).join(" ");
      const ts = chip.ms !== null ? formatMs(chip.ms) : "–";
      return `<button type="button" class="${cls}" data-chip="${i}"><span class="chip-text">${partsHtml(chip.source.trim() || chip.source)}</span><span class="chip-ts">${ts}</span></button>`;
    });
    return `<div class="sync-chips">${chips.join("")}</div>`;
  }

  // The whole line letter by letter, with a slot wherever a word may be split. Each word stays
  // together on one row; the slots between words show as dividers (click to join).
  function adjustHtml(info) {
    const allowed = new Map(cutPoints(info.text).map((point) => [point.display, point.offset]));
    const starts = new Set(info.chips.slice(1).map((chip) => chip.start));
    const stampedStarts = new Set(info.chips.filter((chip) => chip.ms !== null).map((chip) => chip.start));
    const slot = (offset) => {
      const on = starts.has(offset);
      const title = on ? (stampedStarts.has(offset) ? "Join (removes this word's time)" : "Join these") : "Split here";
      return `<button type="button" class="sync-cut${on ? " on" : ""}" data-cut="${offset}" title="${title}" aria-label="${title}"></button>`;
    };
    let d = 0;
    let html = '<span class="sync-chunk">';
    for (const part of furiganaParts(info.text)) {
      const atoms = part.reading ? [part.text] : Array.from(part.text);
      for (const atom of atoms) {
        if (d > 0 && allowed.has(d)) {
          const offset = allowed.get(d);
          html += starts.has(offset) ? `</span>${slot(offset)}<span class="sync-chunk">` : slot(offset);
        }
        const body = part.reading
          ? `<ruby>${escapeHtml(atom)}<rt>${escapeHtml(part.reading)}</rt></ruby>`
          : /\s/u.test(atom) ? "&nbsp;" : escapeHtml(atom);
        html += `<span class="sync-atom">${body}</span>`;
        d += atom.length;
      }
    }
    return `<div class="sync-chips adjust">${html}</span></div>`;
  }

  function repeatHtml(info) {
    const times = info.stamps.map((stamp) => formatMs(stamp.ms)).join(", ");
    return `<div class="sync-repeat">
      <p><strong>This line is sung ${info.stamps.length} times</strong> (${times}). Word times are exact, so each time needs its own line.</p>
      <button type="button" class="sync-secondary" data-act="split-repeat">Give each its own line</button>
    </div>`;
  }

  function partsHtml(source) {
    return furiganaParts(source).map((part) => (
      part.reading ? `<ruby>${escapeHtml(part.text)}<rt>${escapeHtml(part.reading)}</rt></ruby>` : escapeHtml(part.text)
    )).join("");
  }

  function describe(raw) {
    const text = displayText(raw);
    const [first] = leadingTimestamps(raw.replace(/\r$/u, ""));
    return { text, ms: first ? first.ms : null };
  }

  // Every playback frame: light the word being sung on the current line.
  function tick() {
    if (!open || !live.chips.length) return;
    const now = hooks.timeMs();
    let lit = -1;
    if (now < live.endMs) {
      live.times.forEach((ms, i) => {
        if (ms !== null && ms <= now) lit = i;
      });
    }
    if (lit === live.lit) return;
    live.lit = lit;
    live.chips.forEach((chip, i) => chip.classList.toggle("now", i === lit));
  }

  function openAt(lineNumber) {
    open = true;
    sessionEdits = 0;
    adjusting = false;
    host.hidden = false;
    const source = hooks.getSource();
    const list = candidates(source);
    const all = source.split("\n");
    // Pick up where the timing stops. Only a fully timed file, where this is re-timing,
    // starts from the caret's line.
    cursor = firstUnfinished(list) ?? (list.includes(lineNumber) ? lineNumber : list[0] ?? 0);
    wordIndex = firstUnstamped(currentWords());
    // Start a little before the line so there's time to react: before the line itself when
    // it's timed (words mode), else before the line above.
    if (hooks.hasAudio() && !hooks.isPlaying() && cursor) {
      const own = mode === "words" ? leadingTimestamps(all[cursor - 1])[0] : null;
      const before = [...list].reverse().find((n) => n < cursor && leadingTimestamps(all[n - 1]).length);
      const from = own?.ms ?? (before ? leadingTimestamps(all[before - 1])[0].ms : null);
      if (from !== null) hooks.seekLyric(Math.max(0, from - 1500));
    }
    render();
    if (cursor) hooks.showLine(cursor);
    host.focus({ preventScroll: true });
  }

  function close() {
    if (!open) return;
    open = false;
    host.hidden = true;
    hooks.onClose();
  }

  return {
    open: openAt,
    close,
    isOpen: () => open,
    refresh: render,
    followChange,
    tick,
    destroy() {
      document.removeEventListener("keydown", onKeydown, true);
      document.removeEventListener("keyup", onKeyup, true);
      window.removeEventListener("resize", onResize);
    }
  };
}

function readLatency() {
  try {
    const value = Number(localStorage.getItem(LATENCY_KEY));
    return LATENCIES.includes(value) ? value : 0;
  } catch (_) {
    return 0;
  }
}

function readMode() {
  try {
    return localStorage.getItem(MODE_KEY) === "words" ? "words" : "lines";
  } catch (_) {
    return "lines";
  }
}

// Per-line-text memory (word splits, skipped lines) kept in this browser, newest last.
function readStore(key, valid) {
  try {
    const stored = JSON.parse(localStorage.getItem(key) || "[]");
    return new Map(Array.isArray(stored) ? stored.filter((entry) => Array.isArray(entry) && typeof entry[0] === "string" && valid(entry[1])) : []);
  } catch (_) {
    return new Map();
  }
}

function saveStore(key, store) {
  while (store.size > MAX_REMEMBERED) store.delete(store.keys().next().value);
  try {
    localStorage.setItem(key, JSON.stringify([...store]));
  } catch (_) {}
}

function formatMs(ms) {
  const total = Math.max(0, Math.round(ms));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}
