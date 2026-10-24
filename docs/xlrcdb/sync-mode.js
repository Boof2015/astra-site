// Tap to time: play the song and press one key as each line starts. Lines come straight
// from the source (timed, untimed pasted text, and gap markers), so it works on freshly
// pasted lyrics. Every action is also a button, with its key shown, for mouse and touch.
//
// hooks: {
//   getSource(): string,
//   stamp(lineNumber, ms), insertGap(lineNumber, ms), undo(),
//   timeMs(): playhead in lyric time, seekLyric(ms), toggle(), isPlaying(), hasAudio(),
//   pickAudio(), pasteLyrics(), typeLyrics(), showLine(lineNumber), onClose()
// }

import { displayText, hasLyricText, leadingTimestamps, syncCandidates } from "./editor-transforms.js";

const LATENCY_KEY = "xlrcdb-tap-latency";
const LATENCIES = [0, 100, 150, 200, 300];

export function createSyncMode(host, hooks) {
  let open = false;
  let cursor = 0; // source line number
  let stack = []; // [{ type: "stamp" | "gap", line, atMs }]
  let latency = readLatency();

  host.innerHTML = `
    <div class="sync-head">
      <span class="sync-title">Tap to time</span>
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
    <div class="sync-end"></div>
    <button class="sync-tap" type="button" data-act="stamp">Stamp this line <kbd>Space</kbd></button>
    <div class="sync-keys">
      <button type="button" data-act="play"><kbd>K</kbd>Play / pause</button>
      <button type="button" data-act="undo"><kbd>⌫</kbd>Undo stamp</button>
      <button type="button" data-act="up"><kbd>↑</kbd>Previous line</button>
      <button type="button" data-act="down"><kbd>↓</kbd>Next line</button>
      <button type="button" data-act="back"><kbd>←</kbd>Back 2s</button>
      <button type="button" data-act="fwd"><kbd>→</kbd>Ahead 2s</button>
      <button type="button" data-act="gap"><kbd>.</kbd>Mark a gap</button>
    </div>`;
  host.tabIndex = -1;
  const linesEl = host.querySelector(".sync-lines");
  const progressEl = host.querySelector(".sync-progress");
  const endEl = host.querySelector(".sync-end");
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
    const button = e.target.closest("[data-act]");
    if (button) act(button.dataset.act);
  });
  // Clicking an overlay button shouldn't focus it: a focused button presses itself on
  // Space / Enter, on top of the tap-to-time action (a double stamp, or a pause).
  host.addEventListener("mousedown", (e) => {
    if (e.target.closest("button")) e.preventDefault();
  });

  function act(name) {
    switch (name) {
      case "stamp": return stamp();
      case "undo": return undo();
      case "up": return move(-1);
      case "down": return move(1);
      case "back": return hooks.seekLyric(hooks.timeMs() - 2000);
      case "fwd": return hooks.seekLyric(hooks.timeMs() + 2000);
      case "play": return hooks.toggle();
      case "gap": return gap();
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
    let handled = true;
    if (key === " " || key === "Enter") {
      if (!e.repeat) stamp();
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
    } else if (key === "Escape") {
      close();
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

  function lines() {
    return hooks.getSource().split("\n");
  }

  function stamp() {
    if (!hooks.hasAudio() || !cursor) return;
    const ms = Math.max(0, hooks.timeMs() - latency);
    const line = cursor;
    hooks.stamp(line, ms);
    stack.push({ type: "stamp", line, atMs: ms });
    const candidates = syncCandidates(hooks.getSource());
    const next = candidates.find((n) => n > line);
    if (next) setCursor(next);
    else render();
  }

  // A timed empty line before the current one: an instrumental break, or the end marker.
  function gap() {
    if (!hooks.hasAudio() || !cursor) return;
    const ms = Math.max(0, hooks.timeMs() - latency);
    const line = cursor;
    hooks.insertGap(line, ms);
    stack.push({ type: "gap", line, atMs: ms });
    setCursor(line + 1);
  }

  function undo() {
    const last = stack.pop();
    if (!last) return;
    hooks.undo();
    setCursor(last.line);
    hooks.seekLyric(Math.max(0, last.atMs - 2000));
  }

  function move(direction) {
    const candidates = syncCandidates(hooks.getSource());
    if (!candidates.length) return;
    const index = candidates.indexOf(cursor);
    const next = candidates[Math.min(candidates.length - 1, Math.max(0, (index < 0 ? 0 : index) + direction))];
    setCursor(next);
  }

  function setCursor(line) {
    cursor = line;
    render();
    hooks.showLine(line);
  }

  function describe(raw) {
    const text = displayText(raw);
    const [first] = leadingTimestamps(raw.replace(/\r$/u, ""));
    return { text, ms: first ? first.ms : null };
  }

  function render() {
    if (!open) return;
    const source = hooks.getSource();
    const noLyrics = !hasLyricText(source);
    host.classList.toggle("no-lyrics", noLyrics);
    host.classList.toggle("no-audio", !noLyrics && !hooks.hasAudio());
    const all = source.split("\n");
    const candidates = syncCandidates(source);
    if (noLyrics || !candidates.length) {
      linesEl.innerHTML = "";
      progressEl.textContent = "";
      endEl.textContent = "";
      return;
    }
    if (!candidates.includes(cursor)) cursor = candidates.find((n) => n >= cursor) ?? candidates[candidates.length - 1];
    const index = candidates.indexOf(cursor);
    const timed = candidates.filter((n) => leadingTimestamps(all[n - 1]).length > 0).length;
    progressEl.textContent = `${timed} / ${candidates.length} timed`;

    const rows = [-2, -1, 0, 1, 2].map((offset) => {
      const n = candidates[index + offset];
      if (!n) return `<div class="sync-line pad"></div>`;
      const { text, ms } = describe(all[n - 1]);
      const cls = offset === 0 ? "cur" : Math.abs(offset) === 1 ? "near" : "far";
      const time = ms === null ? '<span class="sync-ts none">not timed</span>' : `<span class="sync-ts">${formatMs(ms)}</span>`;
      const body = text ? escapeHtml(text) : '<span class="sync-gap">♪ gap / end</span>';
      return `<div class="sync-line ${cls}">${time}<span class="sync-text">${body}</span></div>`;
    });
    linesEl.innerHTML = rows.join("");
    const last = index === candidates.length - 1;
    endEl.textContent = last ? "Last line. After the final word, press . to mark where the song's lyrics end." : "";
  }

  function openAt(lineNumber) {
    open = true;
    stack = [];
    host.hidden = false;
    const source = hooks.getSource();
    const candidates = syncCandidates(source);
    const all = source.split("\n");
    // Pick up where the timing stops (the first untimed line). Only a fully timed file, where
    // this is re-timing, starts from the caret's line.
    const untimed = candidates.find((n) => leadingTimestamps(all[n - 1]).length === 0);
    cursor = untimed ?? (candidates.includes(lineNumber) ? lineNumber : candidates[0] ?? 0);
    // Start a little before the line so there's time to react.
    if (hooks.hasAudio() && !hooks.isPlaying()) {
      const before = [...candidates].reverse().find((n) => n < cursor && leadingTimestamps(all[n - 1]).length);
      if (before) hooks.seekLyric(Math.max(0, leadingTimestamps(all[before - 1])[0].ms - 1500));
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
    destroy() {
      document.removeEventListener("keydown", onKeydown, true);
      document.removeEventListener("keyup", onKeyup, true);
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
