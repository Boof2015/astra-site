// The xlrcdb editor controller. One mountable component used for both creating
// a new track and editing an existing one. Owns the source textarea (single
// source of truth), syntax highlight overlay, meta fields, audio engine + timing
// authoring, live validation, artist disambiguation, and the submit handoff.

import { parseXLRC, validateXLRC } from "../xlrc/assets/xlrc.js";
import {
  buildHighlight,
  renderLyrics,
  detectedLangs,
  formatTimestamp,
  mapScrollOffset,
  LANG_LABELS
} from "./render.js";
import { createAudioEngine } from "./audio.js";
import { createTimeline } from "./timeline.js";
import { createSyncMode } from "./sync-mode.js";
import { createHistory } from "./history.js";
import { clearLineWords, setWordTag, splitRepeatedLine, stampWord, wordTags, writeLineWords } from "./word-timing.js";
import {
  addTranslationLane,
  adjustSelection,
  displayText,
  hasLyricText,
  insertLineBefore,
  insertLyrics,
  nextEmptyTranslation,
  nudgeLineTimestamp,
  playbackOrder,
  setLineTimestamp,
  syncCandidates
} from "./editor-transforms.js";
import {
  clearTextDraft,
  draftKey,
  fingerprint,
  loadAudio,
  loadTextDraft,
  saveAudio,
  saveTextDraft
} from "./drafts.js";
import {
  CONTRIBUTING_URL,
  formatDuration,
  findSimilarArtists,
  getAllTracks,
  getDirectory,
  matchKey,
  resolveArtist
} from "./data.js";
import {
  applyFix,
  findHeaderLine,
  findUntimedLines,
  fixLabel,
  lintLanguages,
  lintLength,
  lintTiming,
  patchHeader,
  readHeaders,
  syncLangsHeader,
  validateLanguageMetadata
} from "./editor-validation.js";
import { canonicalTag, isValidLanguageTag, languageName, suggestLanguages } from "./languages.js";
import { attachSuggest } from "./suggest.js";
import { createReviewSheet, summarizeSubmission } from "./review-sheet.js";
import { buildSearchIndex, search as searchDirectory } from "./search.js";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/u.test(navigator.platform || navigator.userAgent);
const ALT = IS_MAC ? "⌥" : "Alt+";
const MOD = IS_MAC ? "⌘" : "Ctrl+";
const LENGTH_PATTERN = /^(\d+):([0-5]\d)$/u;
const DEFAULT_SOURCE = "[ti:]\n[ar:]\n[length:]\n[lang:]\n[langs:]\n\n[00:00.00]\n";
// The package's shape-only language checks; languages.js is stricter and gives line numbers.
const SUPERSEDED_LANGUAGE_WARNINGS = new Set(["invalid-lang", "invalid-langs", "invalid-translation-lang"]);
const FIELD_LABELS = { ar: "Artist", ti: "Track", length: "Length", lang: "Primary language", langs: "All languages" };

const ICON_IMPORT = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 11 4 7h2.5V2h3v5H12L8 11Z"/><path d="M3 13h10v1H3z"/></svg>';
const ICON_AUDIO = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6 3v7.3A2.5 2.5 0 1 0 7 12V6h4V3H6Z"/></svg>';
const ICON_PLAY = '<svg class="i-play" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5-9-5.5Z"/></svg>';
const ICON_TRANSLATE = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h7v1.5H6.6c-.3 1.6-1 3-2 4.1.6.5 1.3.9 2 1.2l-.5 1.4c-.9-.4-1.7-.9-2.5-1.6-.8.7-1.7 1.2-2.7 1.6L.4 9.8c.9-.3 1.7-.8 2.4-1.4-.6-.8-1.1-1.6-1.4-2.5h1.6c.2.5.5 1 .9 1.5.6-.8 1.1-1.8 1.3-2.9H2V3Z"/><path d="M11 6h1.6L16 14h-1.6l-.8-2h-3.6l-.8 2H7.6L11 6Zm-.4 4.6h2.4l-1.2-3-1.2 3Z"/></svg>';
const ICON_PAUSE = '<svg class="i-pause" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z"/></svg>';

export function createEditor(container, options = {}) {
  const mode = options.mode === "edit" ? "edit" : "new";
  // Offline: the same editor for making files for yourself (where /xlrc/editor/ now points).
  // No submitting and no database lookups; only the XLRC format itself is enforced, and
  // xlrcdb's extra rules (required headers, real language codes) are suggestions.
  const offline = options.offline === true;
  const initial = options.initial || {};

  const state = {
    source: "",
    output: null,
    token: 0,
    activeIdx: -1,
    activeSrcLine: 0,
    curGutterEl: null,
    lineEls: [],
    parsed: { meta: {}, lines: [], warnings: [] },
    artistResolution: { status: "empty" },
    resolveToken: 0,
    audioSeconds: Number.NaN,
    order: [], // parsed lines in playback order (see playbackOrder), shared with audio + timeline
    words: [], // word tags for the timeline: { key, line, tag, time, label } sorted by time
    wordEl: null, // preview line whose words are lit
    wordLit: -2,
    activePos: -1,
    loopOn: false,
    trFilter: "",
    dragSeq: 0,
    audioName: "",
    embedded: null, // { text, name } lyrics found in the loaded audio file's tags
    draftKey: offline ? "offline" : draftKey(mode, initial.trackId),
    draftTimer: 0,
    // The published file this edit started from (null when it came from "Submit as an edit").
    original: typeof initial.original === "string" ? initial.original : null,
    popOpen: false,
    problemList: [],
    notes: [],
    newArtist: { latin: "", pronunciation: "" },
    // edit-mode context, carried through to the PR
    trackPath: initial.trackPath || null,
    trackSha: initial.trackSha || null,
    trackId: initial.trackId || null,
    artistId: initial.artistId || null,
    submitState: { kind: "idle", message: "" }
  };

  container.innerHTML = template(mode, offline);
  const root = container.querySelector(".submit-editor-app");

  const el = {
    importBtn: root.querySelector("#edImport"),
    importFile: root.querySelector("#edImportFile"),
    audioBtn: root.querySelector("#edAudioBtn"),
    audioFile: root.querySelector("#edAudioFile"),
    copyBtn: root.querySelector("#edCopy"),
    exportBtn: root.querySelector("#edExport"),
    submitBtn: root.querySelector("#edSubmit"),
    artist: root.querySelector("#edArtist"),
    title: root.querySelector("#edTitle"),
    length: root.querySelector("#edLength"),
    lang: root.querySelector("#edLang"),
    langs: root.querySelector("#edLangList"),
    langName: root.querySelector("#edLangName"),
    langsName: root.querySelector("#edLangsName"),
    statusPill: root.querySelector("#edStatusPill"),
    problemsPop: root.querySelector("#edProblemsPop"),
    notices: root.querySelector("#edNotices"),
    notes: root.querySelector("#edNotes"),
    disambig: root.querySelector("#edDisambig"),
    gutter: root.querySelector("#edGutter"),
    curline: root.querySelector("#edCurline"),
    activeline: root.querySelector("#edActiveline"),
    highlight: root.querySelector("#edHighlight"),
    area: root.querySelector("#edArea"),
    preview: root.querySelector("#edPreview"),
    transport: root.querySelector("#edTransport"),
    stamp: root.querySelector("#edStamp"),
    speed: root.querySelector("#edSpeed"),
    speedVal: root.querySelector("#edSpeedVal"),
    speedPresets: root.querySelector("#edSpeedPresets"),
    overviewHost: root.querySelector("#edOverview"),
    laneHost: root.querySelector("#edLane"),
    tlLoad: root.querySelector("#edTlLoad"),
    tlReload: root.querySelector("#edTlReload"),
    zoomIn: root.querySelector("#edZoomIn"),
    zoomOut: root.querySelector("#edZoomOut"),
    zoomFit: root.querySelector("#edZoomFit"),
    loopBtn: root.querySelector("#edLoop"),
    syncBtn: root.querySelector("#edSyncBtn"),
    keysBtn: root.querySelector("#edKeysBtn"),
    keysPop: root.querySelector("#edKeysPop"),
    sync: root.querySelector("#edSync"),
    trFilter: root.querySelector("#edTrFilter"),
    trBtn: root.querySelector("#edTrBtn"),
    trPop: root.querySelector("#edTrPop"),
    trLang: root.querySelector("#edTrLang"),
    trHint: root.querySelector("#edTrHint"),
    trAdd: root.querySelector("#edTrAdd"),
    banner: root.querySelector("#edBanner"),
    toSubmit: root.querySelector("#edToSubmit"),
    review: root.querySelector("#edReview"),
    audio: root.querySelector("#edAudio"),
    statusText: root.querySelector("#edStatusText"),
    pathText: root.querySelector("#edPath"),
    lineCount: root.querySelector("#edLineCount"),
    langSummary: root.querySelector("#edLangs"),
    drop: root.querySelector("#edDrop"),
    toast: root.querySelector("#edToast")
  };

  // Declared up here because the mount sequence below calls resolveArtistDebounced.
  let resolveTimer = 0;
  const suggests = [];

  const history = createHistory();

  // ── timeline + audio engine ──
  const timeline = createTimeline({ overview: el.overviewHost, lane: el.laneHost }, {
    getDuration: () => audio.duration(),
    getTime: () => audio.currentTime(),
    isPlaying: () => audio.isPlaying(),
    seek: (seconds) => audio.seek(seconds),
    getEntries: () => state.order,
    getActive: () => state.activePos,
    getLoop: () => audio.getLoop(),
    getWords: () => state.words,
    onRetime: retime,
    onRetimeWord: retimeWord,
    onPick: (entry) => jumpToLine(entry.line)
  });

  const audio = createAudioEngine(
    { audio: el.audio, playBtn: root.querySelector("#edPlay"), time: root.querySelector("#edTime") },
    {
      getOrder: () => state.order,
      getOffset: offsetMs,
      onActiveLine: onActivePos,
      onTick: () => {
        timeline.tick();
        sync.tick();
        updateWordHighlight();
      },
      onDuration: onAudioDuration,
      onPeaks: (peaks) => timeline.setPeaks(peaks),
      onEmbeddedLyrics: onEmbeddedLyrics
    }
  );

  const review = createReviewSheet(el.review, {
    onConfirm: () => options.onSubmit?.(buildSubmission()),
    onGoFix: (issue) => goToIssue(issue),
    onClose: () => {}
  });

  const sync = createSyncMode(el.sync, {
    getSource: () => el.area.value,
    lang: () => state.parsed.meta.lang || "",
    stamp: (line, ms) => applyEdit(setLineTimestamp(el.area.value, line, ms), { kind: "stamp" }),
    stampWord: (line, chips, index, ms) => applyEdit(stampWord(el.area.value, line, chips, index, ms), { kind: "stamp" }),
    setWords: (line, chips) => applyEdit(writeLineWords(el.area.value, line, chips), { kind: "edit" }),
    clearWords: (line) => applyEdit(clearLineWords(el.area.value, line), { kind: "edit" }),
    splitRepeat: (line) => {
      const result = splitRepeatedLine(el.area.value, line);
      if (result) applyEdit(result.text, { kind: "edit" });
    },
    insertGap: (line, ms) => applyEdit(insertLineBefore(el.area.value, line, `[${formatTimestamp(ms)}]`), { kind: "stamp" }),
    undo: () => undo(),
    timeMs: () => audio.currentTimeMs() - offsetMs(),
    seekLyric: (ms) => audio.seek((ms + offsetMs()) / 1000),
    toggle: () => audio.toggle(),
    isPlaying: () => audio.isPlaying(),
    hasAudio: () => audio.hasAudio(),
    pickAudio: () => el.audioFile.click(),
    pasteLyrics: () => pasteLyrics(),
    typeLyrics: () => typeLyrics(),
    showLine: showSourceLine,
    onClose: () => setPressed(el.syncBtn, false)
  });

  // ── initial source ──
  if (mode === "edit") {
    state.source = initial.source || "";
  } else if (typeof initial.source === "string") {
    state.source = initial.source;
  } else {
    const draft = loadTextDraft(offline ? "offline" : "new")?.text;
    if (initial.artist) {
      // "Create new track" arriving from search/artist: prefill [ar:] on a fresh body.
      state.source = patchHeader(DEFAULT_SOURCE, "ar", initial.artist);
      if (initial.title) state.source = patchHeader(state.source, "ti", initial.title);
    } else {
      state.source = draft || DEFAULT_SOURCE;
    }
  }
  el.area.value = state.source;
  history.reset(snapshot());

  syncMetaFromSource();
  wire();
  paint();
  resolveArtistDebounced(0);
  offerEditDraft();
  offerSavedAudio();

  // ─────────────────────────── wiring ───────────────────────────
  function wire() {
    el.area.addEventListener("input", onSourceInput);
    el.area.addEventListener("scroll", syncScroll);
    el.area.addEventListener("keydown", onAreaKeydown);
    el.area.addEventListener("beforeinput", onAreaBeforeInput);
    el.area.addEventListener("click", onCaretMove);
    el.area.addEventListener("keyup", onCaretMove);
    // Clicking into the source means editing it, so tap-to-time steps aside.
    el.area.addEventListener("focus", () => sync.isOpen() && sync.close());
    // On the document, not the editor: after clicking the timeline or the preview, focus
    // sits on <body>, and undo / shortcuts still have to work.
    document.addEventListener("keydown", onRootKeydown);

    for (const field of [el.artist, el.title, el.length, el.lang, el.langs]) {
      field.addEventListener("input", () => {
        const key = field.dataset.header;
        patchHeaderInPlace(key, field.value);
        history.commit(snapshot(), `field:${key}`);
        if (key === "ar") resolveArtistDebounced(180);
        persist();
        paint();
      });
    }

    wireLanguageFields();
    if (!offline) wireArtistSuggest();
    el.disambig.addEventListener("click", onDisambigClick);
    el.toSubmit?.addEventListener("click", () => options.onOpenInSubmit?.(ensureTrailingNewline(el.area.value)));

    el.statusPill.addEventListener("click", () => togglePop());
    for (const host of [el.problemsPop, el.notices, el.notes]) host.addEventListener("click", onIssueClick);
    document.addEventListener("pointerdown", onDocPointerDown);
    document.addEventListener("keydown", onDocKeydown);
    window.addEventListener("resize", positionNotes);

    el.importBtn.addEventListener("click", () => el.importFile.click());
    el.importFile.addEventListener("change", async () => {
      const file = el.importFile.files?.[0];
      if (!file) return;
      importText(await file.text());
      el.importFile.value = "";
    });

    el.audioBtn.addEventListener("click", () => el.audioFile.click());
    el.tlLoad.addEventListener("click", () => el.audioFile.click());
    el.audioFile.addEventListener("change", () => {
      if (el.audioFile.files?.[0]) loadAudioFile(el.audioFile.files[0]);
      el.audioFile.value = "";
    });

    el.stamp.addEventListener("click", stampAtPlayhead);
    el.speed.addEventListener("input", () => setSpeed(parseFloat(el.speed.value) || 1));
    el.speedPresets.addEventListener("click", (e) => {
      const button = e.target.closest("button[data-speed]");
      if (button) setSpeed(Number(button.dataset.speed));
    });
    el.zoomIn.addEventListener("click", () => timeline.zoomIn());
    el.zoomOut.addEventListener("click", () => timeline.zoomOut());
    el.zoomFit.addEventListener("click", () => timeline.fit());
    el.loopBtn.addEventListener("click", () => toggleLoop());
    el.syncBtn.addEventListener("click", () => toggleSync());
    el.keysBtn.addEventListener("click", () => toggleKeys());
    el.keysPop.innerHTML = shortcutsHtml();
    el.preview.addEventListener("click", onPreviewClick);
    el.trFilter.addEventListener("change", () => {
      state.trFilter = el.trFilter.value;
      render();
    });
    wireTranslationHelper();
    el.banner.addEventListener("click", onBannerClick);

    el.copyBtn.addEventListener("click", onCopy);
    el.exportBtn.addEventListener("click", onExport);
    if (options.onSubmit) {
      el.submitBtn.addEventListener("click", openReview);
    }

    // drag-drop (lyrics or audio) anywhere on the editor
    let depth = 0;
    const hasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    root.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      el.drop.classList.add("show");
    });
    root.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    root.addEventListener("dragleave", (e) => {
      if (!hasFiles(e)) return;
      depth--;
      if (depth <= 0) {
        depth = 0;
        el.drop.classList.remove("show");
      }
    });
    root.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      el.drop.classList.remove("show");
      handleFiles(e.dataTransfer.files);
    });
  }

  function handleFiles(files) {
    const arr = [...files];
    const audioFile = arr.find(isAudioFile);
    const lyricFile = arr.find((f) => !isAudioFile(f));
    if (audioFile) loadAudioFile(audioFile);
    if (lyricFile) lyricFile.text().then(importText);
  }

  function importText(text) {
    applyEdit(text, { kind: "import", selection: { start: 0, end: 0 } });
  }

  // ─────────────────────────── editing ───────────────────────────
  // Rewrite one header line without throwing the caret to the end of the file: everything
  // after the edited line shifts by the length difference.
  function patchHeaderInPlace(key, value) {
    const before = el.area.value;
    const after = patchHeader(before, key, value);
    let at = 0;
    while (at < before.length && before[at] === after[at]) at++;
    const delta = after.length - before.length;
    const shift = (offset) => (offset > at ? Math.max(at, offset + delta) : offset);
    const { selectionStart, selectionEnd } = el.area;
    el.area.value = after;
    el.area.setSelectionRange(shift(selectionStart), shift(selectionEnd));
    state.source = after;
  }

  // ── edit pipeline ──
  // Every change goes through here (or onSourceInput for typing) so it lands in history.
  function snapshot() {
    return { text: el.area.value, start: el.area.selectionStart, end: el.area.selectionEnd };
  }

  function applyEdit(text, { kind = "edit", selection } = {}) {
    const before = el.area.value;
    if (text === before) return;
    const sel = selection ?? adjustSelection(before, text, el.area.selectionStart, el.area.selectionEnd);
    el.area.value = text;
    el.area.setSelectionRange(sel.start, sel.end);
    history.commit(snapshot(), kind);
    afterEdit();
  }

  // Quick fixes replace the whole source; the caret stays on the same text.
  function setSource(text) {
    applyEdit(text, { kind: "fix" });
  }

  function onSourceInput() {
    history.commit(snapshot(), "type");
    afterEdit();
  }

  function afterEdit() {
    state.source = el.area.value;
    syncMetaFromSource();
    resolveArtistDebounced(180);
    persist();
    paint();
  }

  function restore(snap, direction) {
    if (!snap) return;
    const before = el.area.value;
    el.area.value = snap.text;
    el.area.setSelectionRange(snap.start, snap.end);
    afterEdit();
    revealCaret();
    // Tap to time follows any undo / redo back to the line (and word) it touched.
    if (sync.isOpen()) sync.followChange(before, snap.text, direction);
  }

  function undo() {
    restore(history.undo(), "undo");
  }

  function redo() {
    restore(history.redo(), "redo");
  }

  function onAreaBeforeInput(e) {
    // Edit menu / touch-shake undo would use the textarea's own (broken) history.
    if (e.inputType === "historyUndo" || e.inputType === "historyRedo") {
      e.preventDefault();
      if (e.inputType === "historyUndo") undo();
      else redo();
    }
  }

  function onAreaKeydown(e) {
    if (e.key === "Tab" && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const s = el.area.selectionStart;
      const en = el.area.selectionEnd;
      applyEdit(`${el.area.value.slice(0, s)}  ${el.area.value.slice(en)}`, {
        kind: "type",
        selection: { start: s + 2, end: s + 2 }
      });
    }
  }

  // Undo/redo anywhere in the editor, plus the Alt shortcuts (bound by e.code so macOS
  // Option characters like "˚" never reach the text).
  function onRootKeydown(e) {
    if (e.defaultPrevented || review.isOpen()) return;
    if (e.target !== document.body && !root.contains(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey && e.code === "KeyZ") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && e.code === "KeyY" && !IS_MAC) {
      e.preventDefault();
      redo();
      return;
    }
    if (!e.altKey || mod) return;
    const fine = e.shiftKey;
    switch (e.code) {
      case "Enter":
      case "NumpadEnter":
        stampAtPlayhead();
        break;
      case "KeyK":
        audio.toggle();
        break;
      case "KeyJ":
        audio.seek(audio.currentTime() - (fine ? 0.5 : 2));
        break;
      case "KeyL":
        audio.seek(audio.currentTime() + (fine ? 0.5 : 2));
        break;
      case "ArrowUp":
        nudgeCaretLine(fine ? -10 : -50);
        break;
      case "ArrowDown":
        nudgeCaretLine(fine ? 10 : 50);
        break;
      case "KeyR":
        toggleLoop();
        break;
      case "KeyN":
        goToNextEmptyTranslation();
        break;
      case "KeyT":
        toggleSync();
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  function caretLine() {
    return lineAt(el.area.value, el.area.selectionStart) + 1;
  }

  // The lyric line the caret belongs to: itself, or for a translation its parent.
  function caretLyricLine() {
    const line = caretLine();
    const candidates = syncCandidates(el.area.value);
    if (candidates.includes(line)) return line;
    return [...candidates].reverse().find((n) => n < line) ?? candidates.find((n) => n > line) ?? 0;
  }

  function revealCaret() {
    const lineHeight = parseFloat(getComputedStyle(el.area).lineHeight) || 21;
    const top = (caretLine() - 1) * lineHeight;
    if (top < el.area.scrollTop || top > el.area.scrollTop + el.area.clientHeight - lineHeight * 2) {
      el.area.scrollTop = Math.max(0, top - el.area.clientHeight / 3);
    }
    syncScroll();
  }

  // Caret moved by click or keys: remember it for undo, follow it in the preview, and keep a
  // running loop on the caret's line.
  function onCaretMove() {
    history.commit(snapshot());
    updateCurline();
    followCaretInPreview();
    if (state.loopOn) updateLoop();
  }

  function offsetMs() {
    return state.parsed.meta.offset || 0;
  }

  function syncScroll() {
    el.highlight.scrollTop = mapScrollOffset(
      el.area.scrollTop,
      el.area.scrollHeight,
      el.area.clientHeight,
      el.highlight.scrollHeight,
      el.highlight.clientHeight
    );
    el.highlight.scrollLeft = mapScrollOffset(
      el.area.scrollLeft,
      el.area.scrollWidth,
      el.area.clientWidth,
      el.highlight.scrollWidth,
      el.highlight.clientWidth
    );
    el.gutter.scrollTop = mapScrollOffset(
      el.area.scrollTop,
      el.area.scrollHeight,
      el.area.clientHeight,
      el.gutter.scrollHeight,
      el.gutter.clientHeight
    );
    updateCurline();
    positionActiveBand();
    positionNotes();
  }

  function updateCurline() {
    const caretLine = lineAt(el.area.value, el.area.selectionStart);
    positionRowBand(el.curline, caretLine + 1);
  }

  function positionRowBand(band, lineNumber) {
    const row = lineNumber ? el.highlight.children[lineNumber - 1] : null;
    if (!row) {
      band.style.display = "none";
      return;
    }
    band.style.top = `${row.offsetTop - el.highlight.scrollTop}px`;
    band.style.display = "block";
  }

  // ─────────────────────────── timing authoring ───────────────────────────
  // Stamp the caret's lyric line at the playhead and walk the caret down to the next line.
  function stampAtPlayhead() {
    if (!audio.hasAudio()) return;
    const line = caretLyricLine();
    if (!line) return;
    const text = setLineTimestamp(el.area.value, line, audio.currentTimeMs() - offsetMs());
    const next = syncCandidates(text).find((n) => n > line);
    const caret = offsetOfLine(text, (next ?? line + 1) - 1);
    applyEdit(text, { kind: "stamp", selection: { start: caret, end: caret } });
    el.area.focus({ preventScroll: true });
    revealCaret();
  }

  function nudgeCaretLine(deltaMs) {
    const line = caretLyricLine();
    if (!line) return;
    const text = nudgeLineTimestamp(el.area.value, line, deltaMs);
    if (text === el.area.value) return;
    applyEdit(text, { kind: `nudge:${line}` });
    // While paused, park the playhead on the new time so the change is visible.
    const entry = state.order.find((item) => item.line === line && item.tsIndex === 0);
    if (entry && audio.hasAudio() && !audio.isPlaying()) audio.seek(entry.time);
  }

  // A marker dragged on the timeline.
  function retime(entry, seconds, phase) {
    const ms = Math.round(seconds * 1000) - offsetMs();
    applyEdit(setLineTimestamp(el.area.value, entry.line, ms, entry.tsIndex), { kind: `drag:${state.dragSeq}` });
    if (phase === "end") state.dragSeq++;
  }

  // A word tick dragged on the timeline.
  function retimeWord(word, seconds, phase) {
    const ms = Math.round(seconds * 1000) - offsetMs();
    applyEdit(setWordTag(el.area.value, word.line, word.tag, ms), { kind: `drag:${state.dragSeq}` });
    if (phase === "end") state.dragSeq++;
  }

  function toggleLoop(force) {
    state.loopOn = typeof force === "boolean" ? force : !state.loopOn;
    setPressed(el.loopBtn, state.loopOn);
    updateLoop();
  }

  // Loop the caret's line (or the playing one) from its start to the next line's.
  function updateLoop() {
    if (!state.loopOn) {
      audio.setLoop(null);
      timeline.tick();
      return;
    }
    const line = caretLyricLine();
    let pos = state.order.findIndex((item) => item.line === line);
    if (pos < 0) pos = state.activePos;
    const entry = state.order[pos];
    if (!entry) {
      audio.setLoop(null);
      return;
    }
    const end = state.order[pos + 1]?.time ?? audio.duration();
    audio.setLoop({ start: entry.time, end });
    const now = audio.currentTime();
    if (now < entry.time || now >= end) audio.seek(entry.time);
    timeline.reveal(entry.time);
    timeline.tick();
  }

  function setSpeed(rate) {
    const value = Math.min(1, Math.max(0.1, rate));
    el.speed.value = String(value);
    audio.setRate(value);
    el.speedVal.textContent = `${value}x`;
    for (const button of el.speedPresets.querySelectorAll("button")) {
      button.classList.toggle("active", Number(button.dataset.speed) === value);
    }
  }

  function toggleSync() {
    if (sync.isOpen()) {
      sync.close();
      return;
    }
    toggleKeys(false);
    setPressed(el.syncBtn, true);
    sync.open(caretLyricLine());
  }

  // Tap-to-time moved to a line: show it in the source, the timeline and the preview.
  function showSourceLine(line) {
    const offset = offsetOfLine(el.area.value, line - 1);
    el.area.setSelectionRange(offset, offset);
    history.commit(snapshot());
    revealCaret();
    updateCurline();
    followCaretInPreview(true);
    const entry = state.order.find((item) => item.line === line);
    if (entry) timeline.reveal(entry.time);
  }

  function loadAudioFile(file) {
    el.transport.classList.remove("disabled");
    el.tlReload.hidden = true;
    el.stamp.disabled = false;
    // Switch the preview to karaoke dimming once audio is driving the active line.
    el.preview.classList.add("synced");
    state.audioName = file.name;
    audio.loadFile(file);
    saveAudio(state.draftKey, file);
    requestAnimationFrame(() => timeline.resize());
    sync.refresh();
  }

  // The last audio used for this draft, offered back after a refresh.
  async function offerSavedAudio() {
    const file = await loadAudio(state.draftKey);
    if (!file || audio.hasAudio()) return;
    el.tlReload.textContent = `Reload ${file.name}`;
    el.tlReload.hidden = false;
    el.tlReload.onclick = () => loadAudioFile(file);
  }

  function onAudioDuration(seconds) {
    state.audioSeconds = seconds;
    timeline.reset();
    // Auto-fill [length:] from the loaded audio (design-doc behaviour).
    const current = (state.parsed.meta.length || "").trim();
    if (!current) {
      el.length.value = formatDuration(seconds);
      patchHeaderInPlace("length", el.length.value);
      history.commit(snapshot(), "auto");
      persist();
    }
    // Re-lint either way: "past the end" and the length check depend on the audio.
    paint();
  }

  // Lyrics stored in the audio file's tags. A blank starter takes them straight away; a file
  // with headers but no lyrics gets an offer; real lyrics are never touched.
  function onEmbeddedLyrics(text, name) {
    const source = el.area.value;
    if (!source.trim() || source === DEFAULT_SOURCE) {
      if (/^\s*\[(?:ti|ar):[^\]]+\]/mu.test(text)) importText(text);
      else useLyrics(text);
      return;
    }
    if (hasLyricText(source)) return;
    state.embedded = { text, name };
    showBanner(`
      <span><strong>${escapeHtml(name)}</strong> has lyrics stored in it.</span>
      <button class="issue-fix primary" type="button" data-banner="use-embedded">Use them</button>
      <button class="issue-fix" type="button" data-banner="dismiss">No thanks</button>`);
  }

  // Lyrics in from the clipboard (or the audio's tags), under the existing headers.
  function useLyrics(text) {
    const result = insertLyrics(el.area.value, text);
    const caret = offsetOfLine(result.text, result.line - 1);
    applyEdit(result.text, { kind: "import", selection: { start: caret, end: caret } });
    revealCaret();
  }

  async function pasteLyrics() {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch (_) {}
    if (!text.trim()) {
      typeLyrics();
      showToast("info", escapeHtml(`Your browser didn't share the clipboard. Press ${MOD}V to paste into the editor.`), true);
      return;
    }
    useLyrics(text);
  }

  // Close tap-to-time and put the caret where the lyrics go, under the headers.
  function typeLyrics() {
    if (sync.isOpen()) sync.close();
    const result = insertLyrics(el.area.value, "");
    const caret = offsetOfLine(result.text, result.line - 1);
    if (!hasLyricText(el.area.value)) applyEdit(result.text, { kind: "edit", selection: { start: caret, end: caret } });
    el.area.focus({ preventScroll: true });
    if (!hasLyricText(el.area.value)) el.area.setSelectionRange(caret, caret);
    revealCaret();
    updateCurline();
  }

  // ─────────────────────────── validation + paint ───────────────────────────
  function paint() {
    // Editing clears any stale submit feedback (errors / "submitted" notice).
    if (state.submitState.kind !== "busy") {
      state.submitState = { kind: "idle", message: "" };
      hideToast();
    }
    render();
  }

  // Recompute and redraw everything derived from the source. Unlike paint() this keeps any
  // submit feedback, so it can run when an async lookup (artist resolution) lands.
  function render() {
    const output = computeOutput(el.area.value);
    state.output = output;
    state.parsed = output.parsed;

    const offset = output.parsed.meta.offset || 0;
    state.order = playbackOrder(output.parsed).map((entry) => ({
      ...entry,
      key: `${entry.line}:${entry.tsIndex}`,
      time: (entry.timestamp + offset) / 1000,
      label: entry.text
    }));
    // Word tags of each timed line (once per source line; a repeated line's words only fit
    // its first time).
    const sourceLines = el.area.value.split("\n");
    state.words = state.order
      .filter((entry) => entry.tsIndex === 0)
      .flatMap((entry) => wordTags(sourceLines[entry.line - 1] ?? "").map((word, tag) => ({
        key: `${entry.line}:${tag}`,
        line: entry.line,
        tag,
        time: (word.ms + offset) / 1000,
        label: word.label
      })))
      .sort((a, b) => a.time - b.time);

    buildHighlight(el.highlight, el.area.value, output.errorLines, output.warnLines);
    renderGutter(el.area.value, output.errorLines, output.warnLines);
    syncScroll();

    renderPreview(output.parsed);
    if (audio.hasAudio()) audio.refreshSync();
    else setActiveLine(-1);
    if (state.loopOn) updateLoop();
    timeline.refresh();
    sync.refresh();

    el.lineCount.textContent = `${output.lineCount} ${output.lineCount === 1 ? "line" : "lines"}`;
    el.pathText.textContent = output.targetPath;
    const langs = detectedLangs(output.parsed);
    el.langSummary.textContent = langs.length ? langs.map((l) => LANG_LABELS[l] || l).join(", ") : "—";

    renderLangHints();
    renderStatus(output);
    runDuplicateCheck(output);
  }

  function renderStatus(output, checking = false) {
    const sub = state.submitState;
    // Offline files are for yourself: never block getting them out.
    el.copyBtn.disabled = !offline && !output.valid;
    el.exportBtn.disabled = !offline && !output.valid;
    el.submitBtn.disabled = !output.valid || sub.kind === "busy";
    const errorCount = output.errors.length;
    el.submitBtn.title = errorCount ? `Fix ${errorCount} ${errorCount === 1 ? "error" : "errors"} first` : "";
    renderIssues(output);

    if (sub.kind === "busy") {
      el.statusPill.className = "submit-status-pill";
      el.statusPill.textContent = "Working";
      el.statusText.textContent = sub.message;
      return;
    }
    if (sub.kind === "done") {
      el.statusPill.className = "submit-status-pill valid";
      el.statusPill.textContent = "Submitted";
      el.statusText.innerHTML = sub.message;
      return;
    }
    if (checking) {
      el.statusPill.className = "submit-status-pill";
      el.statusPill.textContent = "Checking";
      el.statusText.textContent = "Checking live index for duplicates";
      return;
    }
    renderPill(output);
    // An idle note (config hint, submit error, post-sign-in flash) takes the line.
    if (sub.kind === "idle" && sub.message) {
      el.statusText.textContent = sub.message;
    } else if (output.valid) {
      el.statusText.textContent = offline ? "Ready to export" : mode === "edit" ? "Ready to open edit PR" : "Ready to submit";
    } else {
      el.statusText.textContent = output.errors[0] ? issueText(output.errors[0]) : "Needs changes";
    }
  }

  async function runDuplicateCheck(output) {
    const token = ++state.token;
    if (offline) return;
    if (!output.valid || output.lengthSeconds === undefined) return;
    renderStatus(output, true);
    const dup = await findDuplicate(output).catch(() => null);
    if (token !== state.token) return;
    if (dup) {
      output.issues.push({
        severity: "error",
        code: "duplicate",
        message: `Already in xlrcdb: ${dup.canonicalName} - ${dup.track.title} (${formatDuration(dup.track.length)})`,
        line: 0,
        field: "ti",
        link: { href: `#/track/${encodeURIComponent(dup.artistId)}/${encodeURIComponent(dup.track.id)}`, label: "View" },
        ...(mode === "new" && options.onOpenAsEdit ? {
          edit: { artistId: dup.artistId, canonicalName: dup.canonicalName, trackId: dup.track.id, trackPath: dup.track.path }
        } : {})
      });
      output.errors = output.issues.filter((issue) => issue.severity === "error");
      output.valid = false;
      state.output = output;
    }
    renderStatus(output);
  }

  // Mirrors the data repo's isSameRecording: artist and title compared by matchKey (so
  // punctuation and case don't matter) across every artist record, length within a second.
  async function findDuplicate(output) {
    const resolved = await resolveArtist(output.artist);
    const artistKey = matchKey(resolved ? resolved.canonicalName : output.artist);
    const titleKey = matchKey(output.title);
    const tracks = await getAllTracks();
    return tracks.find((entry) =>
      entry.track.id !== state.trackId &&
      matchKey(entry.canonicalName) === artistKey &&
      matchKey(entry.track.title) === titleKey &&
      Math.abs(entry.track.length - output.lengthSeconds) <= 1
    ) ?? null;
  }

  function computeOutput(rawSource) {
    const text = ensureTrailingNewline(rawSource);
    const issues = [];
    const add = (severity, issue) => issues.push({ severity, ...issue });
    let parsed = { meta: {}, lines: [], warnings: [] };

    try {
      parsed = parseXLRC(text);
    } catch (error) {
      add("error", { code: "parse", message: error.message || "XLRC could not be parsed", line: 0 });
    }

    // Plain text lines (pasted lyrics) are one grouped item, not one error per line. A
    // translation under one of them can't attach yet either; it will once the line is timed.
    const untimed = new Set(findUntimedLines(text));
    const untimedLines = [];
    const sourceLines = text.split("\n");
    const parentIsUntimed = (line) => {
      for (let n = line - 1; n >= 1; n--) {
        const raw = sourceLines[n - 1].trim();
        if (raw === "" || raw.startsWith("[>")) continue;
        return untimed.has(n);
      }
      return false;
    };
    for (const warning of parsed.warnings) {
      if (warning.code === "unrecognized-line" && untimed.has(warning.line)) {
        untimedLines.push(warning.line);
        continue;
      }
      if (warning.code === "orphan-translation" && parentIsUntimed(warning.line)) continue;
      add("error", { code: warning.code, message: warning.message, line: warning.line });
    }
    if (untimedLines.length > 0) {
      add("error", {
        code: "untimed",
        message: untimedLines.length === 1
          ? "No timestamp yet. Add [mm:ss.xx] or use Stamp with audio"
          : `${untimedLines.length} lines have no timestamp yet. Add [mm:ss.xx] or use Stamp with audio`,
        line: untimedLines[0],
        lines: untimedLines
      });
    }

    for (const warning of validateXLRC(parsed).warnings.filter((warning) => (
      warning.code !== "invalid-length" &&
      !SUPERSEDED_LANGUAGE_WARNINGS.has(warning.code) &&
      !(
        warning.code === "invalid-lang" &&
        (typeof parsed.meta.lang !== "string" || parsed.meta.lang.trim() === "")
      )
    ))) {
      add("error", { code: warning.code, message: warning.message, line: warning.line });
    }

    const artist = typeof parsed.meta.ar === "string" ? parsed.meta.ar.trim() : "";
    const title = typeof parsed.meta.ti === "string" ? parsed.meta.ti.trim() : "";
    const length = typeof parsed.meta.length === "string" ? parsed.meta.length.trim() : "";
    const lengthSeconds = parseLengthSeconds(length);
    const hasAudio = Number.isFinite(state.audioSeconds);

    const requireHeader = (value, key, message, extra = {}) => {
      if (!value && !offline) add("error", { code: "missing-header", message, line: findHeaderLine(text, key), field: key, ...extra });
    };
    requireHeader(artist, "ar", "Missing non-empty [ar:] header");
    requireHeader(title, "ti", "Missing non-empty [ti:] header");
    if (!length) {
      requireHeader(length, "length", "Missing non-empty [length:] header",
        hasAudio ? { fix: { kind: "set-length", value: formatDuration(state.audioSeconds) } } : {});
    } else if (lengthSeconds === undefined) {
      add(offline ? "warning" : "error", {
        code: "length-format",
        message: "Length must use mm:ss with seconds below 60",
        line: findHeaderLine(text, "length"),
        field: "length",
        ...(hasAudio ? { fix: { kind: "set-length", value: formatDuration(state.audioSeconds) } } : {})
      });
    }

    for (const error of validateLanguageMetadata(parsed, text)) {
      // Offline, language headers are optional and a bad code is only a suggestion.
      if (offline && (error.code === "missing-lang" || error.code === "missing-langs")) continue;
      add(offline ? "warning" : "error", error);
    }

    // CI only creates artists for new submissions; an edited track's [ar:] has to resolve.
    const resolution = state.artistResolution;
    if (mode === "edit" && artist && resolution.status === "new" && resolution.name === artist) {
      const [near] = resolution.similar || [];
      add("error", {
        code: "edit-unknown-artist",
        message: `"${artist}" isn't an artist or alias in xlrcdb. An edit has to keep an existing artist`,
        line: findHeaderLine(text, "ar"),
        field: "ar",
        ...(near ? { fix: { kind: "set-header", key: "ar", value: near.canonicalName } } : {})
      });
    }

    // Advice that doesn't block submitting.
    const endMs = hasAudio ? state.audioSeconds * 1000 : lengthSeconds !== undefined ? lengthSeconds * 1000 : undefined;
    for (const warning of lintTiming(parsed, { endMs })) add("warning", warning);
    for (const warning of lintLanguages(parsed, text)) add("warning", warning);
    for (const warning of lintLength({ lengthSeconds, audioSeconds: state.audioSeconds, line: findHeaderLine(text, "length") })) {
      add("warning", warning);
    }

    const errorLines = new Set();
    const warnLines = new Set();
    for (const issue of issues) {
      const target = issue.severity === "error" ? errorLines : warnLines;
      for (const line of issue.lines ?? [issue.line]) if (line > 0) target.add(line);
    }
    for (const line of errorLines) warnLines.delete(line);

    const filename = `${slugify(artist || "artist")}-${slugify(title || "track")}.xlrc`;
    const targetPath = mode === "edit" && state.trackPath ? state.trackPath : `incoming/${filename}`;
    const errors = issues.filter((issue) => issue.severity === "error");

    return {
      mode,
      artist,
      title,
      length,
      lengthSeconds,
      text,
      filename,
      targetPath,
      parsed,
      issues,
      errors,
      errorLines,
      warnLines,
      lineCount: text.split(/\r?\n/u).length,
      valid: errors.length === 0
    };
  }

  function renderGutter(text, errorLines, warnLines) {
    el.gutter.innerHTML = text.split(/\r?\n/u).map((_, index) => {
      const line = index + 1;
      const cls = errorLines.has(line) ? " err" : warnLines.has(line) ? " warn" : "";
      return `<div class="ln${cls}">${line}</div>`;
    }).join("");
  }

  // ─────────────────────────── problems: inline notes, notices, popover ───────────────────────────
  // Problems show where they happen: a note at the end of the source line (fix button right
  // there), an outline on the meta field, and a strip under the meta bar for file-level ones
  // (duplicate, header missing entirely). The pill opens the full list next to itself.
  function renderIssues(output) {
    state.problemList = [...output.issues].sort(compareIssues);
    renderNotes(output);
    renderNotices(output);
    renderFieldStates(output);
    if (state.popOpen) renderPop();
  }

  function compareIssues(a, b) {
    return (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) ||
      (a.line > 0 ? a.line : Infinity) - (b.line > 0 ? b.line : Infinity);
  }

  function countLabel(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }

  function renderPill(output) {
    const errors = output.errors.length;
    const warnings = output.issues.length - errors;
    const warn = warnings ? `<span class="pill-warn">${countLabel(warnings, "warning")}</span>` : "";
    if (errors) {
      el.statusPill.className = "submit-status-pill invalid";
      el.statusPill.innerHTML = `<span>${countLabel(errors, "error")}</span>${warn}`;
    } else {
      el.statusPill.className = "submit-status-pill valid";
      el.statusPill.innerHTML = `<span>Valid</span>${warn}`;
    }
    el.statusPill.title = output.issues.length ? "Show all problems" : "No problems";
    el.statusPill.setAttribute("aria-expanded", String(state.popOpen));
  }

  function issueIndex(issue) {
    return state.problemList.indexOf(issue);
  }

  function issueActions(issue) {
    const i = issueIndex(issue);
    const fix = issue.fix ? `<button class="issue-fix" type="button" data-fix="${i}">${escapeHtml(fixLabel(issue.fix))}</button>` : "";
    const link = issue.link ? `<a class="issue-fix" href="${escapeHtml(issue.link.href)}" target="_blank" rel="noopener">${escapeHtml(issue.link.label)}</a>` : "";
    const edit = issue.edit ? `<button class="issue-fix primary" type="button" data-edit="${i}" title="Open an edit PR for the existing track, keeping your changes">Submit as an edit</button>` : "";
    return edit + fix + link;
  }

  function sevClass(issue) {
    return issue.severity === "error" ? "err" : "warn";
  }

  // One note per source line (the most severe issue, "+N" for the rest), placed just past
  // the end of the line's text and clamped to stay inside the pane.
  function renderNotes(output) {
    el.notes.textContent = "";
    state.notes = [];
    const byLine = new Map();
    for (const issue of state.problemList) {
      if (!(issue.line > 0)) continue;
      if (!byLine.has(issue.line)) byLine.set(issue.line, []);
      byLine.get(issue.line).push(issue);
    }
    const base = el.highlight.getBoundingClientRect().left - el.highlight.scrollLeft;
    const padLeft = parseFloat(getComputedStyle(el.highlight).paddingLeft) || 14;
    for (const [line, issues] of byLine) {
      const row = el.highlight.children[line - 1];
      if (!row) continue;
      const [issue, ...rest] = issues;
      let textRight = padLeft;
      if (row.textContent) {
        const range = document.createRange();
        range.selectNodeContents(row);
        textRight = range.getBoundingClientRect().right - base;
      }
      const node = document.createElement("div");
      node.className = `ed-note ${sevClass(issue)}`;
      node.title = issues.map((item) => item.message).join("\n");
      node.innerHTML = `
        <button class="ed-note-main" type="button" data-go="${issueIndex(issue)}"><i></i><span>${escapeHtml(issue.message)}</span></button>
        ${rest.length ? `<span class="ed-note-more">+${rest.length}</span>` : ""}
        ${issueActions(issue)}`;
      el.notes.appendChild(node);
      state.notes.push({ node, row, textRight, natural: node.offsetWidth });
    }
    positionNotes();
  }

  function positionNotes() {
    if (!state.notes.length) return;
    const paneWidth = el.notes.clientWidth;
    const paneHeight = el.notes.clientHeight;
    for (const note of state.notes) {
      const top = note.row.offsetTop - el.highlight.scrollTop;
      const visible = top > -24 && top < paneHeight;
      note.node.style.visibility = visible ? "" : "hidden";
      if (!visible) continue;
      // Prefer the space after the text, truncating the message to fit; only when there's
      // barely any room does the note sit flush right, over the end of a long line.
      let left = note.textRight - el.highlight.scrollLeft + 24;
      let room = paneWidth - left - 8;
      if (room < Math.min(note.natural, 240)) {
        room = Math.min(note.natural, paneWidth - 16, 440);
        left = paneWidth - room;
      }
      note.node.style.maxWidth = `${Math.max(120, Math.floor(room))}px`;
      note.node.style.transform = `translate(${Math.round(Math.max(8, left))}px, ${Math.round(top)}px)`;
    }
  }

  // Issues with no source line: shown under the meta bar, action beside the message.
  function renderNotices(output) {
    const notices = state.problemList.filter((issue) => !(issue.line > 0));
    el.notices.innerHTML = notices.map((issue) => `
      <div class="ed-notice ${sevClass(issue)}">
        <button class="ed-notice-main" type="button" data-go="${issueIndex(issue)}"><i></i><span>${escapeHtml(issue.message)}</span></button>
        ${issueActions(issue)}
      </div>`).join("");
    el.notices.classList.toggle("show", notices.length > 0);
  }

  function renderFieldStates(output) {
    const worst = {};
    for (const issue of output.issues) {
      if (!issue.field) continue;
      if (worst[issue.field] !== "error") worst[issue.field] = issue.severity;
    }
    for (const key of ["ar", "ti", "length", "lang", "langs"]) {
      const input = fieldInput(key);
      input.classList.toggle("has-error", worst[key] === "error");
      input.classList.toggle("has-warning", worst[key] === "warning");
    }
  }

  function togglePop(force) {
    state.popOpen = typeof force === "boolean" ? force : !state.popOpen;
    el.problemsPop.hidden = !state.popOpen;
    el.statusPill.setAttribute("aria-expanded", String(state.popOpen));
    if (state.popOpen) renderPop();
  }

  function renderPop() {
    const rows = state.problemList.map((issue, i) => {
      const where = issue.line > 0 ? `Ln ${issue.line}` : issue.field ? FIELD_LABELS[issue.field] : "File";
      return `
        <div class="ed-pop-row ${sevClass(issue)}">
          <button class="ed-pop-main" type="button" data-go="${i}">
            <i></i><span class="ed-pop-where">${escapeHtml(where)}</span><span class="ed-pop-msg">${escapeHtml(issue.message)}</span>
          </button>
          ${issueActions(issue)}
        </div>`;
    }).join("");
    el.problemsPop.innerHTML = `
      <div class="ed-pop-head">${offline ? "Errors are lines a player would skip. Warnings are suggestions." : "Errors block submitting. Warnings are suggestions."}</div>
      ${rows || '<div class="ed-pop-empty">No problems. Ready to submit.</div>'}`;
  }

  function onIssueClick(e) {
    const editBtn = e.target.closest("button[data-edit]");
    if (editBtn) {
      const issue = state.problemList[Number(editBtn.dataset.edit)];
      if (issue?.edit) openAsEdit(issue.edit);
      return;
    }
    const fixBtn = e.target.closest("button[data-fix]");
    if (fixBtn) {
      const issue = state.problemList[Number(fixBtn.dataset.fix)];
      if (issue?.fix) applyIssueFix(issue);
      return;
    }
    const go = e.target.closest("[data-go]");
    if (go) {
      const issue = state.problemList[Number(go.dataset.go)];
      if (issue) goToIssue(issue);
    }
  }

  function onDocPointerDown(e) {
    if (state.popOpen && !el.problemsPop.contains(e.target) && !el.statusPill.contains(e.target)) togglePop(false);
  }

  function onDocKeydown(e) {
    if (e.key === "Escape" && state.popOpen) togglePop(false);
  }

  // Turn a would-be duplicate into an edit of the existing track, keeping the user's text.
  // The edit has to name an existing artist, so [ar:] is switched to that track's artist
  // unless it already resolves to it (an alias is fine).
  async function openAsEdit(target) {
    let source = ensureTrailingNewline(el.area.value);
    const resolved = await resolveArtist(state.output.artist).catch(() => null);
    if (!resolved || resolved.artistId !== target.artistId) {
      source = patchHeader(source, "ar", target.canonicalName);
    }
    options.onOpenAsEdit({
      mode: "edit",
      source,
      trackPath: target.trackPath,
      trackId: target.trackId,
      artistId: target.artistId
    });
  }

  function applyIssueFix(issue) {
    const next = applyFix(el.area.value, state.parsed, issue.fix);
    if (next === el.area.value) return;
    setSource(next);
  }

  // Header problems go to the matching meta-bar field; everything else to the source line.
  function goToIssue(issue) {
    const field = issue.field ? fieldInput(issue.field) : null;
    if (field) {
      field.focus();
      field.select();
      flash(field.closest("label") || field);
      return;
    }
    if (issue.line > 0) jumpToLine(issue.line);
  }

  function fieldInput(key) {
    return { ar: el.artist, ti: el.title, length: el.length, lang: el.lang, langs: el.langs }[key] || null;
  }

  function jumpToLine(line) {
    const value = el.area.value;
    const start = offsetOfLine(value, line - 1);
    el.area.focus({ preventScroll: true });
    el.area.setSelectionRange(start, start);
    const lineHeight = parseFloat(getComputedStyle(el.area).lineHeight) || 21;
    el.area.scrollTop = Math.max(0, (line - 1) * lineHeight - el.area.clientHeight / 3);
    syncScroll();
    flash(el.curline);
    // Bring the matching preview line (or the lyric a translation belongs to) into view.
    const idx = state.parsed.lines.findIndex((l) => l.line === line || l.translations.some((t) => t.line === line));
    if (idx >= 0) state.lineEls[idx]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function flash(node) {
    node.classList.remove("ed-flash");
    void node.offsetWidth;
    node.classList.add("ed-flash");
  }

  // ─────────────────────────── artist suggestions ───────────────────────────
  // Existing artists as you type ("kd" -> K/DA), so a submission lands on the artist that's
  // already there instead of creating a near-duplicate record.
  function wireArtistSuggest() {
    let index = null;
    getDirectory()
      .then((directory) => {
        index = buildSearchIndex({ artists: directory.artists, tracks: [] });
      })
      .catch(() => {});
    suggests.push(attachSuggest(el.artist, {
      pickOnTab: false,
      getItems: (input) => {
        const query = input.value.trim();
        if (!query || !index) return [];
        return searchDirectory(index, query, { artistLimit: 6, trackLimit: 0 }).artists.map(({ artist, alias }) => ({
          name: artist.name,
          html: `<span>${escapeHtml(artist.name)}</span>${alias ? `<em>aka ${escapeHtml(alias)}</em>` : ""}<small>${artist.trackCount} ${artist.trackCount === 1 ? "track" : "tracks"}</small>`
        }));
      },
      onPick: (item, input) => {
        input.value = item.name;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }));
  }

  // ─────────────────────────── language fields ───────────────────────────
  function wireLanguageFields() {
    suggests.push(attachSuggest(el.lang, {
      openOnFocus: true,
      getItems: (input) => {
        const query = input.value.trim();
        // A finished, valid code needs no list until the user starts changing it.
        if (document.activeElement === input && isValidLanguageTag(query) && languageName(query) && !input.dataset.typing) return [];
        return suggestLanguages(query).map(languageItem);
      },
      onPick: (item, input) => {
        input.value = item.tag;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }));

    // [langs:] is a comma list: suggest for the token being typed, "in this file" tags first.
    suggests.push(attachSuggest(el.langs, {
      openOnFocus: true,
      getItems: (input) => {
        const tokens = input.value.split(",");
        const current = tokens[tokens.length - 1].trim();
        const listed = tokens.slice(0, -1).map((token) => token.trim()).filter(Boolean);
        const inFile = requiredLanguages().filter((tag) => !listed.some((l) => l.toLowerCase() === tag.toLowerCase()));
        if (!current) {
          const fromFile = inFile.map((tag) => ({ tag, name: languageName(tag), inFile: true }));
          const common = suggestLanguages("", { exclude: [...listed, ...inFile], limit: 6 });
          return [...fromFile, ...common].map(languageItem);
        }
        if (isValidLanguageTag(current) && languageName(current) && !input.dataset.typing) return [];
        return suggestLanguages(current, { exclude: listed }).map((item) => languageItem({
          ...item,
          inFile: inFile.some((tag) => tag.toLowerCase() === item.tag.toLowerCase())
        }));
      },
      onPick: (item, input) => {
        const tokens = input.value.split(",");
        tokens[tokens.length - 1] = item.tag;
        input.value = tokens.map((token) => token.trim()).filter(Boolean).join(",");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }));

    // "typing" lets the list show for a valid code the user is in the middle of editing.
    for (const input of [el.lang, el.langs]) {
      input.addEventListener("input", () => {
        input.dataset.typing = "1";
      });
      input.addEventListener("blur", () => {
        delete input.dataset.typing;
      });
    }
    // Drop the stray commas and spaces that typing a list leaves behind.
    el.langs.addEventListener("blur", () => {
      const tidy = el.langs.value.split(",").map((tag) => tag.trim()).filter(Boolean).join(",");
      if (tidy !== el.langs.value) {
        el.langs.value = tidy;
        el.langs.dispatchEvent(new Event("input", { bubbles: true }));
        delete el.langs.dataset.typing;
      }
    });
  }

  function languageItem(item) {
    const note = item.inFile ? '<small>in this file</small>' : "";
    return {
      ...item,
      html: `<code>${escapeHtml(item.tag)}</code><span>${escapeHtml(item.name || "")}</span>${note}`
    };
  }

  // [lang:] plus every inline translation language, in the order a reader meets them.
  function requiredLanguages() {
    const out = [];
    const seen = new Set();
    const add = (tag) => {
      if (!tag || seen.has(tag.toLowerCase())) return;
      seen.add(tag.toLowerCase());
      out.push(tag);
    };
    add((el.lang.value || "").trim());
    for (const line of state.parsed.lines) for (const tr of line.translations) add(tr.lang);
    return out;
  }

  function renderLangHints() {
    const lang = el.lang.value.trim();
    setHint(el.langName, lang ? (languageName(lang) || "not a language code") : "", lang && !languageName(lang));

    const tags = el.langs.value.split(",").map((tag) => tag.trim()).filter(Boolean);
    const unknown = tags.filter((tag) => !languageName(tag));
    if (unknown.length) {
      setHint(el.langsName, `unknown: ${unknown.join(", ")}`, true);
    } else {
      setHint(el.langsName, tags.map(languageName).join(", "), false);
    }
  }

  function setHint(node, text, bad) {
    node.textContent = text ? ` · ${text}` : "";
    node.classList.toggle("bad", Boolean(bad));
    node.title = text;
  }

  // ─────────────────────────── preview ───────────────────────────
  function renderPreview(parsed) {
    // The starter's empty [00:00.00] isn't a start on timing; words with a time are.
    if (!parsed.lines.some((line) => !line.isEmpty)) {
      renderGuide();
      state.lineEls = [];
      el.trFilter.closest("label").hidden = true;
      return;
    }
    // Translation filter: "" all, "none" off, or one language.
    const filter = state.trFilter;
    state.lineEls = filter
      ? renderLyrics(el.preview, parsed, filter === "none" ? "\u0000" : filter, { showAll: false })
      : renderLyrics(el.preview, parsed, "", { showAll: true });
    state.lineEls.forEach((node, i) => {
      node.dataset.idx = String(i);
      node.classList.add("clickable");
    });
    const langs = detectedLangs(parsed);
    const options = ['<option value="">All translations</option>', '<option value="none">No translations</option>']
      .concat(langs.filter((tag) => tag !== parsed.meta.lang).map((tag) => (
        `<option value="${escapeHtml(tag)}">${escapeHtml(languageName(tag) || tag)} only</option>`
      )));
    const html = options.join("");
    if (el.trFilter.dataset.html !== html) {
      el.trFilter.innerHTML = html;
      el.trFilter.dataset.html = html;
    }
    if (![...el.trFilter.options].some((option) => option.value === state.trFilter)) state.trFilter = "";
    el.trFilter.value = state.trFilter;
    el.trFilter.closest("label").hidden = langs.filter((tag) => tag !== parsed.meta.lang).length === 0;
    state.wordEl = null;
    state.wordLit = -2;
    const prev = state.activeIdx;
    state.activeIdx = -1;
    setActiveLine(prev, { scroll: false });
    followCaretInPreview();
  }

  // Until something is timed, the preview walks a new contributor through the three steps
  // (lyrics, audio, timing) with live status, instead of sitting empty.
  function renderGuide() {
    const source = el.area.value;
    const lines = source.split("\n");
    const lyricCount = syncCandidates(source).filter((n) => displayText(lines[n - 1]) !== "").length;
    const hasAudio = audio.hasAudio();
    const ready = lyricCount > 0 && hasAudio;
    const step = (n, done, title, detail, actions = "") => `
      <li class="guide-step${done ? " done" : ""}">
        <span class="guide-num">${done ? "✓" : n}</span>
        <div>
          <strong>${title}</strong>
          <p>${detail}</p>
          ${actions ? `<div class="guide-actions">${actions}</div>` : ""}
        </div>
      </li>`;
    el.preview.innerHTML = `
      <div class="ed-guide">
        <p class="ed-guide-eyebrow">Get started</p>
        <h3>Make a timed lyrics file</h3>
        <ol>
          ${step(1, lyricCount > 0, "Add the lyrics",
            lyricCount ? `${lyricCount} ${lyricCount === 1 ? "line" : "lines"} in the editor` : "One line of the song per line, under the headers on the left.",
            lyricCount ? "" : '<button class="guide-primary" type="button" data-guide="paste">Paste lyrics</button><button type="button" data-guide="type">Type them</button>')}
          ${step(2, hasAudio, "Load the song",
            hasAudio ? escapeHtml(state.audioName || "Audio loaded") : "It stays in your browser and is only used to time the lines.",
            hasAudio ? "" : '<button class="guide-primary" type="button" data-guide="audio">Load audio</button>')}
          ${step(3, false, "Time the lines",
            ready ? "Play the song and press Space as each line starts." : "Needs the lyrics and the song first.",
            `<button class="guide-primary" type="button" data-guide="sync"${ready ? "" : " disabled"}>Tap to time</button>`)}
        </ol>
        <p class="ed-guide-note">Already have a timed .lrc or .xlrc file? <button class="guide-link" type="button" data-guide="import">Import it</button> or drop it anywhere here.</p>
      </div>`;
  }

  // Click a preview line: jump the audio there and put the caret on its source line.
  function onPreviewClick(e) {
    const guide = e.target.closest("[data-guide]");
    if (guide) {
      const action = guide.dataset.guide;
      if (action === "paste") pasteLyrics();
      else if (action === "type") typeLyrics();
      else if (action === "audio") el.audioFile.click();
      else if (action === "sync") toggleSync();
      else if (action === "import") el.importFile.click();
      return;
    }
    const node = e.target.closest(".rline");
    if (!node) return;
    const line = state.parsed.lines[Number(node.dataset.idx)];
    if (!line) return;
    if (audio.hasAudio()) audio.seek((line.timestamp + offsetMs()) / 1000);
    const offset = offsetOfLine(el.area.value, line.line - 1);
    el.area.setSelectionRange(offset, offset);
    history.commit(snapshot());
    revealCaret();
    updateCurline();
    followCaretInPreview();
    if (state.loopOn) updateLoop();
  }

  // While paused, the preview marks the caret's line so the source and preview stay paired.
  function followCaretInPreview(force = false) {
    const line = caretLine();
    const idx = state.parsed.lines.findIndex((l) => l.line === line || l.translations.some((t) => t.line === line));
    state.lineEls.forEach((node, i) => node.classList.toggle("caret", i === idx));
    if (idx >= 0 && (force || !audio.isPlaying())) {
      state.lineEls[idx]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  function onActivePos(pos) {
    state.activePos = pos;
    setActiveLine(state.order[pos]?.idx ?? -1);
  }

  function setActiveLine(idx, { scroll = idx !== state.activeIdx } = {}) {
    state.activeIdx = idx;
    state.lineEls.forEach((node, i) => {
      node.classList.toggle("active", i === idx);
      node.classList.toggle("near", i === idx - 1 || i === idx + 1);
    });
    if (scroll && idx >= 0 && state.lineEls[idx]) {
      state.lineEls[idx].scrollIntoView({ block: "center", behavior: "smooth" });
    }
    // Mirror the playing line onto the source side: accent gutter number + band.
    const srcLine = idx >= 0 && state.parsed.lines[idx] ? state.parsed.lines[idx].line : 0;
    updateEditorActive(srcLine);
    updateWordHighlight();
  }

  // Word-timed lines light up word by word while playing: sung words full, the current one in
  // the accent, the rest dim. Repeats of a line are skipped (its word times fit the first).
  function updateWordHighlight() {
    const idx = state.activeIdx;
    const node = idx >= 0 ? state.lineEls[idx] : null;
    if (state.wordEl && state.wordEl !== node) {
      state.wordEl.classList.remove("words-live");
      for (const word of state.wordEl.querySelectorAll(".rw")) word.classList.remove("sung", "now");
      state.wordEl = null;
      state.wordLit = -2;
    }
    const line = node ? state.parsed.lines[idx] : null;
    const entry = state.order[state.activePos];
    if (!line || !line.words.length || !entry || entry.tsIndex > 0 || !audio.hasAudio()) return;
    const now = audio.currentTimeMs() - offsetMs();
    let lit = -1;
    line.words.forEach((word, i) => {
      if (word.timestamp <= now) lit = i;
    });
    if (node === state.wordEl && lit === state.wordLit) return;
    state.wordEl = node;
    state.wordLit = lit;
    node.classList.add("words-live");
    node.querySelectorAll(".rw").forEach((word, i) => {
      word.classList.toggle("sung", i < lit);
      word.classList.toggle("now", i === lit);
    });
  }

  function updateEditorActive(srcLine) {
    if (state.curGutterEl) state.curGutterEl.classList.remove("cur");
    state.curGutterEl = srcLine ? el.gutter.children[srcLine - 1] : null;
    if (state.curGutterEl) state.curGutterEl.classList.add("cur");
    state.activeSrcLine = srcLine;
    positionActiveBand();
  }

  function positionActiveBand() {
    positionRowBand(el.activeline, state.activeSrcLine);
  }

  // ─────────────────────────── shortcuts popover ───────────────────────────
  function toggleKeys(force) {
    const open = typeof force === "boolean" ? force : el.keysPop.hidden;
    el.keysPop.hidden = !open;
    el.keysBtn.setAttribute("aria-expanded", String(open));
  }

  function shortcutsHtml() {
    const row = (keys, label) => `<div class="ed-key-row"><span>${keys.map((k) => `<kbd>${k}</kbd>`).join(" ")}</span><span>${label}</span></div>`;
    return `
      <div class="ed-keys-group">
        <h4>While editing</h4>
        ${row([`${ALT}Enter`], "Stamp the caret's line at the playhead")}
        ${row([`${ALT}K`], "Play / pause")}
        ${row([`${ALT}J`, `${ALT}L`], "Back / ahead 2s (add Shift for 0.5s)")}
        ${row([`${ALT}↑`, `${ALT}↓`], "Nudge the line's time 50ms (Shift: 10ms)")}
        ${row([`${ALT}R`], "Loop the caret's line")}
        ${row([`${ALT}N`], "Next empty translation")}
        ${row([`${ALT}T`], "Tap to time")}
        ${row([`${MOD}Z`, `${IS_MAC ? "⇧⌘Z" : "Ctrl+Y"}`], "Undo / redo (stamps and drags too)")}
      </div>
      <div class="ed-keys-group">
        <h4>Timeline</h4>
        ${row(["Scroll"], "Zoom in and out")}
        ${row(["Shift+Scroll"], "Pan")}
        ${row(["Drag a marker"], "Retime that line (its words move with it)")}
        ${row(["Drag a word tick"], "Retime that word (zoom in to see them)")}
        ${row(["Double-click"], "Edit that line")}
      </div>
      <div class="ed-keys-group">
        <h4>Tap to time</h4>
        ${row(["Space"], "Stamp and move on (line, or word in Words)")}
        ${row(["⌫"], "Undo the last stamp")}
        ${row(["."], "Mark a gap or the end")}
        ${row(["W"], "Switch between Lines and Words")}
        ${row(["R"], "Words: replay the line")}
        ${row(["S"], "Words: split or join words")}
        ${row(["Tab"], "Words: skip or unskip a line (skipped keeps just its line time)")}
      </div>`;
  }

  // ─────────────────────────── translation helper ───────────────────────────
  // "Add translation": an empty [>tag] under every lyric line, then straight to the first one.
  function wireTranslationHelper() {
    el.trBtn.addEventListener("click", () => toggleTranslationPop());
    el.trAdd.addEventListener("click", addTranslation);
    // The dropdown goes first: Enter on a suggestion picks it (and marks the event handled);
    // Enter with no list open adds the lines.
    suggests.push(attachSuggest(el.trLang, {
      openOnFocus: true,
      getItems: (input) => {
        const have = requiredLanguages();
        return suggestLanguages(input.value.trim(), { exclude: have }).map(languageItem);
      },
      onPick: (item, input) => {
        input.value = item.tag;
        renderTranslationHint();
      }
    }));
    el.trLang.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.defaultPrevented) {
        e.preventDefault();
        addTranslation();
      } else if (e.key === "Escape" && !e.defaultPrevented) {
        toggleTranslationPop(false);
      }
    });
    el.trLang.addEventListener("input", renderTranslationHint);
  }

  function toggleTranslationPop(force) {
    const open = typeof force === "boolean" ? force : el.trPop.hidden;
    el.trPop.hidden = !open;
    el.trBtn.setAttribute("aria-expanded", String(open));
    if (open) {
      el.trLang.value = "";
      renderTranslationHint();
      el.trLang.focus();
    }
  }

  function renderTranslationHint() {
    const tag = el.trLang.value.trim();
    const name = languageName(tag);
    el.trHint.classList.toggle("bad", Boolean(tag) && !name);
    el.trHint.textContent = !tag
      ? "Adds an empty translation line under every lyric line that doesn't have one yet."
      : name
        ? `Adds an empty [>${canonicalTag(tag)}] (${name}) line under every lyric line that doesn't have one yet.`
        : `"${tag}" is not a language code. Try a name like "English" or a code like en.`;
  }

  function addTranslation() {
    const tag = el.trLang.value.trim();
    if (!isValidLanguageTag(tag) || !languageName(tag)) {
      renderTranslationHint();
      el.trLang.focus();
      return;
    }
    const code = canonicalTag(tag);
    let text = addTranslationLane(el.area.value, code);
    text = syncLangsHeader(text, parseXLRC(ensureTrailingNewline(text)));
    toggleTranslationPop(false);
    if (text === el.area.value) return;
    const first = nextEmptyTranslation(text, 0);
    const caret = first ? offsetOfLine(text, first - 1) + text.split("\n")[first - 1].length : el.area.selectionStart;
    applyEdit(text, { kind: "lane", selection: { start: caret, end: caret } });
    el.area.focus({ preventScroll: true });
    revealCaret();
  }

  function goToNextEmptyTranslation() {
    const text = el.area.value;
    const line = nextEmptyTranslation(text, caretLine());
    if (!line) return;
    const caret = offsetOfLine(text, line - 1) + text.split("\n")[line - 1].replace(/\r$/u, "").length;
    el.area.focus({ preventScroll: true });
    el.area.setSelectionRange(caret, caret);
    onCaretMove();
    revealCaret();
  }

  // ─────────────────────────── drafts ───────────────────────────
  // Edits save to this browser as you go; reopening the track offers them back.
  function offerEditDraft() {
    if (mode !== "edit") return;
    const draft = loadTextDraft(state.draftKey);
    if (!draft || draft.text === el.area.value) return;
    const changed = state.original !== null && draft.base && draft.base !== fingerprint(state.original);
    showBanner(`
      <span>You have unsaved changes to this track from ${escapeHtml(timeAgo(draft.savedAt))}.${changed ? " The published version has changed since." : ""}</span>
      <button class="issue-fix primary" type="button" data-banner="restore">Restore them</button>
      <button class="issue-fix" type="button" data-banner="discard">Discard</button>`);
    el.banner.dataset.text = draft.text;
  }

  function showBanner(html) {
    el.banner.innerHTML = html;
    el.banner.hidden = false;
  }

  function onBannerClick(e) {
    const button = e.target.closest("[data-banner]");
    if (!button) return;
    const action = button.dataset.banner;
    if (action === "restore") applyEdit(el.banner.dataset.text, { kind: "import", selection: { start: 0, end: 0 } });
    else if (action === "discard") clearTextDraft(state.draftKey);
    else if (action === "use-embedded" && state.embedded) useLyrics(state.embedded.text);
    state.embedded = null;
    el.banner.hidden = true;
    el.banner.innerHTML = "";
    delete el.banner.dataset.text;
  }

  function setPressed(button, on) {
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", String(on));
  }

  // ─────────────────────────── artist disambiguation ───────────────────────────
  function resolveArtistDebounced(delay) {
    clearTimeout(resolveTimer);
    resolveTimer = setTimeout(resolveArtistNow, delay);
  }

  async function resolveArtistNow() {
    if (offline) return;
    const name = (el.artist.value || "").trim();
    const token = ++state.resolveToken;
    if (!name) {
      state.artistResolution = { status: "empty" };
      renderDisambig();
      return;
    }
    const resolved = await resolveArtist(name).catch(() => null);
    if (token !== state.resolveToken) return;
    if (resolved) {
      state.artistResolution = { status: "existing", artistId: resolved.artistId, canonicalName: resolved.canonicalName, name };
    } else {
      const similar = await findSimilarArtists(name).catch(() => []);
      if (token !== state.resolveToken) return;
      state.artistResolution = { status: "new", name, similar };
    }
    renderDisambig();
    if (mode === "edit") render();
  }

  function onDisambigClick(e) {
    const use = e.target.closest("button[data-use]");
    if (!use) return;
    el.artist.value = use.dataset.use;
    el.artist.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function renderDisambig() {
    const r = state.artistResolution;
    if (r.status === "empty") {
      el.disambig.className = "ed-disambig";
      el.disambig.innerHTML = "";
      return;
    }
    if (r.status === "existing") {
      el.disambig.className = "ed-disambig existing";
      el.disambig.innerHTML = `<span class="ed-disambig-dot"></span><span>Existing artist <strong>${escapeHtml(r.canonicalName)}</strong></span><code>${escapeHtml(r.artistId)}</code>`;
      return;
    }
    const similar = (r.similar || []).map((match) => (
      `<button class="ed-disambig-use" type="button" data-use="${escapeHtml(match.canonicalName)}">${escapeHtml(match.canonicalName)}</button>`
    )).join(" ");
    const similarHtml = similar ? `<span class="ed-disambig-similar">Already in xlrcdb: ${similar}</span>` : "";
    // Edits never create artists (CI requires [ar:] to resolve), so no "will be created".
    if (mode === "edit") {
      el.disambig.className = "ed-disambig new";
      el.disambig.innerHTML = `
        <span class="ed-disambig-dot"></span>
        <span>No artist named <strong>${escapeHtml(r.name)}</strong> in xlrcdb</span>
        ${similarHtml}`;
      return;
    }
    // New artist. Its optional Latin name / pronunciation are asked for in the review sheet.
    el.disambig.className = "ed-disambig new";
    el.disambig.innerHTML = `
      <span class="ed-disambig-dot"></span>
      <span>New artist <strong>${escapeHtml(r.name)}</strong> will be created</span>
      ${similarHtml}`;
  }

  // ─────────────────────────── submission handoff ───────────────────────────
  // "Submit via PR" opens the review sheet; the sheet's confirm hands off to onSubmit.
  function openReview() {
    const output = state.output;
    if (!output?.valid) return;
    if (sync.isOpen()) sync.close();
    const meta = output.parsed.meta;
    review.open({
      mode,
      title: output.title,
      artist: output.artist,
      length: output.length,
      lang: typeof meta.lang === "string" ? meta.lang.trim() : "",
      langs: Array.isArray(meta.langs) ? meta.langs : [],
      targetPath: output.targetPath,
      artistResolution: state.artistResolution,
      newArtist: state.newArtist,
      summary: summarizeSubmission(output.parsed, output.text),
      warnings: output.issues.filter((issue) => issue.severity === "warning"),
      account: options.getSubmitContext?.() ?? {},
      simulate: Boolean(options.getSubmitContext?.()?.simulate),
      rights: false
    });
  }

  function buildSubmission() {
    const output = state.output;
    const resolution = state.artistResolution;
    return {
      mode,
      text: output.text,
      artist: output.artist,
      title: output.title,
      length: output.length,
      filename: output.filename,
      trackPath: state.trackPath,
      trackSha: state.trackSha,
      trackId: state.trackId,
      artistId: resolution.status === "existing" ? resolution.artistId : state.artistId,
      artistResolution: resolution,
      newArtist: resolution.status === "new"
        ? { canonical_name: output.artist, canonical_name_latin: state.newArtist.latin.trim(), pronunciation: state.newArtist.pronunciation.trim() }
        : null
    };
  }

  function setSubmitFeedback(kind, message, result = {}) {
    if (review.isOpen()) review.setProgress(kind, message, result);
    state.submitState = { kind, message };
    if (kind === "done" && mode === "edit") {
      clearTimeout(state.draftTimer);
      clearTextDraft(state.draftKey);
    }
    el.submitBtn.disabled = kind === "busy" || !state.output?.valid;
    renderStatus(state.output, false);
    // Mirror submit lifecycle into a prominent toast (the statusbar is easy to miss), unless
    // the review sheet is open and already showing it.
    if (review.isOpen()) hideToast();
    else if (kind === "busy") showToast("busy", escapeHtml(message), false);
    else if (kind === "done") showToast("success", message, true); // message is safe HTML (PR link)
    else if (kind === "idle" && message) showToast("error", escapeHtml(message), true);
    else hideToast();
  }

  const TOAST_TAGS = { busy: "Submitting…", success: "Submitted", error: "Couldn't submit", info: "Note" };
  function showToast(kind, html, dismissable) {
    el.toast.className = `ed-toast show ${kind}`;
    el.toast.innerHTML = `
      <span class="ed-toast-tag">${TOAST_TAGS[kind] ?? ""}</span>
      <div class="ed-toast-body">${html}</div>
      ${dismissable ? '<button class="ed-toast-close" type="button" aria-label="Dismiss">×</button>' : ""}`;
    const close = el.toast.querySelector(".ed-toast-close");
    if (close) close.addEventListener("click", hideToast);
  }
  function hideToast() {
    el.toast.className = "ed-toast";
    el.toast.innerHTML = "";
  }

  // ─────────────────────────── local actions ───────────────────────────
  function onExport() {
    if (!state.output?.valid) return;
    downloadTextFile(state.output.filename, state.output.text);
  }
  async function onCopy() {
    if (!state.output?.valid) return;
    try {
      await navigator.clipboard.writeText(state.output.text);
      el.copyBtn.textContent = "Copied";
      setTimeout(() => {
        el.copyBtn.textContent = "Copy";
      }, 1400);
    } catch (_) {}
  }

  // ─────────────────────────── meta ↔ source ───────────────────────────
  function syncMetaFromSource() {
    const headers = readHeaders(el.area.value);
    el.artist.value = headers.ar;
    el.title.value = headers.ti;
    el.length.value = headers.length;
    el.lang.value = headers.lang;
    el.langs.value = headers.langs;
  }

  function persist() {
    if (offline) {
      saveTextDraft("offline", el.area.value);
      return;
    }
    if (mode === "new") {
      saveTextDraft("new", el.area.value);
      return;
    }
    // Edits: debounce, and drop the draft once it matches what's published again.
    clearTimeout(state.draftTimer);
    state.draftTimer = setTimeout(() => {
      const text = el.area.value;
      if (state.original !== null && text === state.original) clearTextDraft(state.draftKey);
      else saveTextDraft(state.draftKey, text, state.original !== null ? fingerprint(state.original) : null);
    }, 400);
  }

  function destroy() {
    clearTimeout(resolveTimer);
    clearTimeout(state.draftTimer);
    timeline.destroy();
    sync.destroy();
    document.removeEventListener("pointerdown", onDocPointerDown);
    document.removeEventListener("keydown", onRootKeydown);
    document.removeEventListener("keydown", onDocKeydown);
    window.removeEventListener("resize", positionNotes);
    for (const suggest of suggests) suggest.destroy();
    audio.destroy();
  }

  return { getSubmission: buildSubmission, setSubmitFeedback, destroy };
}

// ─────────────────────────── pure helpers ───────────────────────────
function template(mode, offline = false) {
  const submitLabel = mode === "edit" ? "Open edit PR" : "Submit via PR";
  return `
  <article class="submit-editor-app">
    <header class="submit-toolbar">
      <div class="submit-brand">
        <a class="submit-logo" href="#/">XLRCDB</a>
        <span>${offline ? "Offline" : mode === "edit" ? "Edit" : "New"}</span>
      </div>
      <div class="submit-toolbar-group">
        <button class="submit-tool-button" id="edImport" type="button">${ICON_IMPORT} Import</button>
        <input class="visually-hidden" id="edImportFile" type="file" accept=".xlrc,.lrc,.txt,text/plain">
        <button class="submit-tool-button" id="edAudioBtn" type="button">${ICON_AUDIO} Load audio</button>
        <input class="visually-hidden" id="edAudioFile" type="file" accept="audio/*,.mp3,.flac,.wav,.m4a,.ogg">
        <div class="ed-tr-wrap">
          <button class="submit-tool-button" id="edTrBtn" type="button" aria-expanded="false" aria-controls="edTrPop">${ICON_TRANSLATE} Add translation</button>
          <div class="ed-tr-pop" id="edTrPop" role="dialog" aria-label="Add a translation" hidden>
            <label><span>Language</span><input id="edTrLang" type="text" placeholder="English, en, romaji…" autocapitalize="off" spellcheck="false"></label>
            <p class="ed-tr-hint" id="edTrHint"></p>
            <button class="issue-fix primary" id="edTrAdd" type="button">Add lines</button>
          </div>
        </div>
      </div>
      <div class="submit-toolbar-spacer"></div>
      <div class="submit-toolbar-group">
        <a class="submit-tool-button" href="#/">Browse</a>
        <button class="submit-tool-button" id="edCopy" type="button" disabled>Copy</button>
        <button class="submit-tool-button${offline ? " primary" : ""}" id="edExport" type="button" disabled>Export</button>
        ${offline ? '<button class="submit-tool-button" id="edToSubmit" type="button" title="Open this file in the xlrcdb submit editor, which checks it against the database rules">Submit to xlrcdb</button>' : ""}
        <button class="submit-tool-button primary" id="edSubmit" type="button" disabled${offline ? " hidden" : ""}>${submitLabel}</button>
        <a class="submit-tool-button" href="${CONTRIBUTING_URL}" target="_blank" rel="noopener">Guide</a>
      </div>
    </header>

    <section class="submit-meta-bar" aria-label="Submission metadata">
      <label><span>Artist</span><input id="edArtist" data-header="ar" type="text" placeholder="Artist"></label>
      <label><span>Track</span><input id="edTitle" data-header="ti" type="text" placeholder="Title"></label>
      <label class="submit-length-field"><span>Length</span><input id="edLength" data-header="length" type="text" inputmode="numeric" placeholder="03:42"></label>
      <label><span>Primary language<em class="ed-lang-name" id="edLangName"></em></span><input id="edLang" data-header="lang" type="text" placeholder="ja" autocapitalize="off" spellcheck="false"></label>
      <label><span>All languages<em class="ed-lang-name" id="edLangsName"></em></span><input id="edLangList" data-header="langs" type="text" placeholder="ja,en" autocapitalize="off" spellcheck="false"></label>
      <button class="submit-status-pill" id="edStatusPill" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="edProblemsPop">Checking</button>
      <div class="ed-problems-pop" id="edProblemsPop" role="dialog" aria-label="Problems" hidden></div>
    </section>

    <div class="ed-disambig" id="edDisambig"></div>
    <div class="ed-notices-wrap">
      <div class="ed-banner" id="edBanner" hidden></div>
      <div class="ed-notices" id="edNotices" aria-live="polite"></div>
    </div>

    <div class="submit-main">
      <section class="submit-source-pane" aria-label="XLRC source editor">
        <div class="ed-gutter" id="edGutter" aria-hidden="true"></div>
        <div class="ed-input">
          <div class="ed-activeline" id="edActiveline" aria-hidden="true"></div>
          <div class="ed-curline" id="edCurline"></div>
          <pre class="ed-highlight" id="edHighlight" aria-hidden="true"></pre>
          <div class="ed-notes" id="edNotes"></div>
          <textarea class="ed-area" id="edArea" spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off"></textarea>
        </div>
      </section>
      <div class="submit-divider" aria-hidden="true"></div>
      <div class="ed-preview-wrap">
        <section class="submit-preview-pane" id="edPreview" aria-live="polite"></section>
        <label class="ed-tr-filter" hidden><span class="visually-hidden">Translations in preview</span><select id="edTrFilter"></select></label>
        <div class="sync-mode" id="edSync" hidden></div>
      </div>
    </div>

    <div class="ed-transport disabled" id="edTransport">
      <div class="ed-transport-row">
        <button class="play-btn" id="edPlay" type="button" aria-label="Play / pause">${ICON_PLAY}${ICON_PAUSE}</button>
        <div class="time" id="edTime">00:00.00 / 00:00.00</div>
        <div class="ed-overview" id="edOverview"></div>
        <div class="ed-speed" title="Playback speed (slow down to time fast lines)">
          <input type="range" id="edSpeed" min="0.1" max="1" step="0.05" value="1" aria-label="Playback speed">
          <span id="edSpeedVal">1x</span>
          <span class="ed-speed-presets" id="edSpeedPresets">
            <button type="button" data-speed="0.5">0.5</button><button type="button" data-speed="0.75">0.75</button><button type="button" data-speed="1" class="active">1</button>
          </span>
        </div>
        <div class="ed-zoom" role="group" aria-label="Timeline zoom">
          <button type="button" id="edZoomOut" title="Zoom out" aria-label="Zoom out">−</button>
          <button type="button" id="edZoomIn" title="Zoom in" aria-label="Zoom in">+</button>
          <button type="button" id="edZoomFit" title="Show the whole song">Fit</button>
        </div>
        <button class="ed-tool" id="edLoop" type="button" aria-pressed="false" title="Loop the caret's line (${ALT}R)">Loop line</button>
        <button class="ed-tool" id="edSyncBtn" type="button" aria-pressed="false" title="Press a key as each line starts (${ALT}T)">Tap to time</button>
        <button class="ed-stamp" id="edStamp" type="button" disabled title="Set the caret's line to the playhead time (${ALT}Enter)">Stamp ⏎</button>
        <button class="ed-tool icon" id="edKeysBtn" type="button" aria-expanded="false" aria-controls="edKeysPop" title="Keyboard shortcuts">?</button>
        <div class="ed-keys-pop" id="edKeysPop" role="dialog" aria-label="Keyboard shortcuts" hidden></div>
      </div>
      <div class="ed-lane-host" id="edLane"></div>
      <div class="ed-timeline-empty">
        <span>Load the song's audio to see the waveform, time lines by ear, and drag them into place.</span>
        <button class="issue-fix primary" id="edTlLoad" type="button">Load audio</button>
        <button class="issue-fix" id="edTlReload" type="button" hidden></button>
      </div>
    </div>

    <footer class="submit-statusbar">
      <span class="ed-status-text" id="edStatusText">Checking</span>
      <span class="ed-status-path" id="edPath">incoming/artist-track.xlrc</span>
      <span id="edLangs">—</span>
      <span id="edLineCount">0 lines</span>
    </footer>

    <div class="dropzone" id="edDrop">
      <div class="dropzone-inner">
        <div class="dz-title">Drop to load</div>
        <div class="dz-sub">.xlrc lyrics &nbsp;·&nbsp; or an audio file</div>
      </div>
    </div>

    <div class="ed-toast" id="edToast" role="status" aria-live="polite"></div>
    <div id="edReview"></div>

    <audio id="edAudio" preload="metadata"></audio>
  </article>`;
}

function lineAt(text, offset) {
  let count = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") count++;
  }
  return count;
}

function offsetOfLine(text, lineIndex) {
  if (lineIndex <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      seen++;
      if (seen === lineIndex) return i + 1;
    }
  }
  return text.length;
}

function timeAgo(ms) {
  if (!ms) return "earlier";
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ms).toLocaleDateString();
}

function issueText(issue) {
  const prefix = Number.isInteger(issue.line) && issue.line > 0 ? `Line ${issue.line}: ` : "";
  return `${prefix}${issue.message}`;
}

function ensureTrailingNewline(value) {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function parseLengthSeconds(value) {
  const match = value.match(LENGTH_PATTERN);
  if (!match) return undefined;
  return Number.parseInt(match[1], 10) * 60 + Number.parseInt(match[2], 10);
}

function slugify(value) {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 80);
  return slug || "track";
}

function isAudioFile(file) {
  return file.type.startsWith("audio/") || /\.(mp3|flac|wav|m4a|ogg|aac|opus)$/iu.test(file.name);
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}
