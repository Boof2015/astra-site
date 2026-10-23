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
import {
  CONTRIBUTING_URL,
  formatDuration,
  findSimilarArtists,
  getAllTracks,
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
  validateLanguageMetadata
} from "./editor-validation.js";
import { isValidLanguageTag, languageName, suggestLanguages } from "./languages.js";
import { attachSuggest } from "./suggest.js";

const SUBMISSION_STORAGE_KEY = "xlrcdb-submission-draft";
const LEADING_TIMESTAMP = /^\[\d+:\d{2}(?:\.\d{1,3})?\]/u;
const LENGTH_PATTERN = /^(\d+):([0-5]\d)$/u;
const DEFAULT_SOURCE = "[ti:]\n[ar:]\n[length:]\n[lang:]\n[langs:]\n\n[00:00.00]\n";
// The package's shape-only language checks; languages.js is stricter and gives line numbers.
const SUPERSEDED_LANGUAGE_WARNINGS = new Set(["invalid-lang", "invalid-langs", "invalid-translation-lang"]);
const FIELD_LABELS = { ar: "Artist", ti: "Track", length: "Length", lang: "Primary language", langs: "All languages" };

const ICON_IMPORT = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 11 4 7h2.5V2h3v5H12L8 11Z"/><path d="M3 13h10v1H3z"/></svg>';
const ICON_AUDIO = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6 3v7.3A2.5 2.5 0 1 0 7 12V6h4V3H6Z"/></svg>';
const ICON_PLAY = '<svg class="i-play" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5-9-5.5Z"/></svg>';
const ICON_PAUSE = '<svg class="i-pause" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z"/></svg>';

export function createEditor(container, options = {}) {
  const mode = options.mode === "edit" ? "edit" : "new";
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

  container.innerHTML = template(mode);
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

  // ── audio engine ──
  const audio = createAudioEngine(
    {
      audio: el.audio,
      scrub: root.querySelector("#edScrub"),
      wave: root.querySelector("#edWave"),
      markers: root.querySelector("#edMarkers"),
      playhead: root.querySelector("#edPlayhead"),
      scrubTip: root.querySelector("#edScrubTip"),
      playBtn: root.querySelector("#edPlay"),
      time: root.querySelector("#edTime")
    },
    {
      getLines: () => state.parsed.lines,
      getOffset: () => state.parsed.meta.offset || 0,
      onActiveLine: setActiveLine,
      onDuration: onAudioDuration,
      onEmbeddedLyrics: onEmbeddedLyrics
    }
  );

  // ── initial source ──
  if (mode === "edit") {
    state.source = initial.source || "";
  } else if (typeof initial.source === "string") {
    state.source = initial.source;
  } else {
    const draft = loadDraft();
    if (initial.artist) {
      // "Create new track" arriving from search/artist: prefill [ar:] on a fresh body.
      state.source = patchHeader(DEFAULT_SOURCE, "ar", initial.artist);
      if (initial.title) state.source = patchHeader(state.source, "ti", initial.title);
    } else {
      state.source = draft || DEFAULT_SOURCE;
    }
  }
  el.area.value = state.source;

  syncMetaFromSource();
  wire();
  paint();
  resolveArtistDebounced(0);
  el.audio && requestAnimationFrame(() => audio.resize());

  // ─────────────────────────── wiring ───────────────────────────
  function wire() {
    el.area.addEventListener("input", onSourceInput);
    el.area.addEventListener("scroll", syncScroll);
    el.area.addEventListener("keydown", onAreaKeydown);
    el.area.addEventListener("click", updateCurline);
    el.area.addEventListener("keyup", updateCurline);

    for (const field of [el.artist, el.title, el.length, el.lang, el.langs]) {
      field.addEventListener("input", () => {
        const key = field.dataset.header;
        patchHeaderInPlace(key, field.value);
        if (key === "ar") resolveArtistDebounced(180);
        persist();
        paint();
      });
    }

    wireLanguageFields();
    el.disambig.addEventListener("click", onDisambigClick);

    el.statusPill.addEventListener("click", () => togglePop());
    for (const host of [el.problemsPop, el.notices, el.notes]) host.addEventListener("click", onIssueClick);
    document.addEventListener("pointerdown", onDocPointerDown);
    document.addEventListener("keydown", onDocKeydown);
    window.addEventListener("resize", positionNotes);

    el.importBtn.addEventListener("click", () => el.importFile.click());
    el.importFile.addEventListener("change", async () => {
      const file = el.importFile.files?.[0];
      if (!file) return;
      el.area.value = await file.text();
      onSourceInput();
      el.importFile.value = "";
    });

    el.audioBtn.addEventListener("click", () => el.audioFile.click());
    el.audioFile.addEventListener("change", () => {
      if (el.audioFile.files?.[0]) loadAudio(el.audioFile.files[0]);
      el.audioFile.value = "";
    });

    el.stamp.addEventListener("click", stampAtPlayhead);
    el.speed.addEventListener("input", () => {
      const r = parseFloat(el.speed.value) || 1;
      audio.setRate(r);
      el.speedVal.textContent = `${r}x`;
    });

    el.copyBtn.addEventListener("click", onCopy);
    el.exportBtn.addEventListener("click", onExport);
    if (options.onSubmit) {
      el.submitBtn.addEventListener("click", () => options.onSubmit(buildSubmission()));
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
    if (audioFile) loadAudio(audioFile);
    if (lyricFile) lyricFile.text().then((text) => {
      el.area.value = text;
      onSourceInput();
    });
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

  // Replace the whole source (quick fixes, imports) keeping the caret roughly in place.
  function setSource(text) {
    const caret = Math.min(el.area.selectionStart, text.length);
    el.area.value = text;
    el.area.selectionStart = el.area.selectionEnd = caret;
    onSourceInput();
  }

  function onSourceInput() {
    state.source = el.area.value;
    syncMetaFromSource();
    resolveArtistDebounced(180);
    persist();
    paint();
  }

  function onAreaKeydown(e) {
    if (e.key === "Tab") {
      e.preventDefault();
      const s = el.area.selectionStart;
      const en = el.area.selectionEnd;
      el.area.value = `${el.area.value.slice(0, s)}  ${el.area.value.slice(en)}`;
      el.area.selectionStart = el.area.selectionEnd = s + 2;
      onSourceInput();
      return;
    }
    // Alt+Enter stamps the current line at the audio playhead.
    if (e.key === "Enter" && e.altKey && audio.hasAudio()) {
      e.preventDefault();
      stampAtPlayhead();
    }
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
  function stampAtPlayhead() {
    const stamp = `[${formatTimestamp(Math.round(audio.currentTimeMs()))}]`;
    const value = el.area.value;
    const idx = lineAt(value, el.area.selectionStart);
    const lines = value.split("\n");
    const line = lines[idx] ?? "";
    const body = line.replace(LEADING_TIMESTAMP, "");
    lines[idx] = `${stamp}${body}`;
    el.area.value = lines.join("\n");

    // Move the caret to the start of the next line so repeated stamping walks down.
    const nextStart = offsetOfLine(el.area.value, Math.min(idx + 1, lines.length - 1));
    el.area.selectionStart = el.area.selectionEnd = nextStart;
    el.area.focus();
    onSourceInput();
    audio.refreshMarkers();
    updateCurline();
  }

  function loadAudio(file) {
    el.transport.classList.remove("disabled");
    el.stamp.disabled = false;
    // Switch the preview to karaoke dimming once audio is driving the active line.
    el.preview.classList.add("synced");
    audio.loadFile(file);
  }

  function onAudioDuration(seconds) {
    state.audioSeconds = seconds;
    // Auto-fill [length:] from the loaded audio (design-doc behaviour).
    const current = (state.parsed.meta.length || "").trim();
    if (!current) {
      el.length.value = formatDuration(seconds);
      patchHeaderInPlace("length", el.length.value);
      persist();
    }
    // Re-lint either way: "past the end" and the length check depend on the audio.
    paint();
  }

  function onEmbeddedLyrics(text) {
    if (el.area.value.trim() && el.area.value !== DEFAULT_SOURCE) return;
    el.area.value = text;
    onSourceInput();
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

    buildHighlight(el.highlight, el.area.value, output.errorLines, output.warnLines);
    renderGutter(el.area.value, output.errorLines, output.warnLines);
    syncScroll();

    state.lineEls = renderLyrics(el.preview, output.parsed, "", { showAll: true });
    setActiveLine(state.activeIdx);
    audio.refreshMarkers();

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
    el.copyBtn.disabled = !output.valid;
    el.exportBtn.disabled = !output.valid;
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
      el.statusText.textContent = mode === "edit" ? "Ready to open edit PR" : "Ready to submit";
    } else {
      el.statusText.textContent = output.errors[0] ? issueText(output.errors[0]) : "Needs changes";
    }
  }

  async function runDuplicateCheck(output) {
    const token = ++state.token;
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

    // Plain text lines (pasted lyrics) are one grouped item, not one error per line.
    const untimed = new Set(findUntimedLines(text));
    const untimedLines = [];
    for (const warning of parsed.warnings) {
      if (warning.code === "unrecognized-line" && untimed.has(warning.line)) {
        untimedLines.push(warning.line);
        continue;
      }
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
      if (!value) add("error", { code: "missing-header", message, line: findHeaderLine(text, key), field: key, ...extra });
    };
    requireHeader(artist, "ar", "Missing non-empty [ar:] header");
    requireHeader(title, "ti", "Missing non-empty [ti:] header");
    if (!length) {
      requireHeader(length, "length", "Missing non-empty [length:] header",
        hasAudio ? { fix: { kind: "set-length", value: formatDuration(state.audioSeconds) } } : {});
    } else if (lengthSeconds === undefined) {
      add("error", {
        code: "length-format",
        message: "Length must use mm:ss with seconds below 60",
        line: findHeaderLine(text, "length"),
        field: "length",
        ...(hasAudio ? { fix: { kind: "set-length", value: formatDuration(state.audioSeconds) } } : {})
      });
    }

    for (const error of validateLanguageMetadata(parsed, text)) add("error", error);

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
      <div class="ed-pop-head">Errors block submitting. Warnings are suggestions.</div>
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

  function setActiveLine(idx) {
    state.activeIdx = idx;
    state.lineEls.forEach((node, i) => {
      node.classList.toggle("active", i === idx);
      node.classList.toggle("near", i === idx - 1 || i === idx + 1);
    });
    if (idx >= 0 && state.lineEls[idx]) {
      state.lineEls[idx].scrollIntoView({ block: "center", behavior: "smooth" });
    }
    // Mirror the playing line onto the source side: accent gutter number + band.
    const srcLine = idx >= 0 && state.parsed.lines[idx] ? state.parsed.lines[idx].line : 0;
    updateEditorActive(srcLine);
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

  // ─────────────────────────── artist disambiguation ───────────────────────────
  function resolveArtistDebounced(delay) {
    clearTimeout(resolveTimer);
    resolveTimer = setTimeout(resolveArtistNow, delay);
  }

  async function resolveArtistNow() {
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
    // new artist: offer optional latin name + pronunciation
    el.disambig.className = "ed-disambig new";
    el.disambig.innerHTML = `
      <span class="ed-disambig-dot"></span>
      <span>New artist <strong>${escapeHtml(r.name)}</strong> will be created</span>
      ${similarHtml}
      <div class="ed-newartist">
        <label><span>Latin name</span><input id="edArtistLatin" type="text" placeholder="optional" value="${escapeHtml(state.newArtist.latin)}"></label>
        <label><span>Pronunciation</span><input id="edArtistPron" type="text" placeholder="optional" value="${escapeHtml(state.newArtist.pronunciation)}"></label>
      </div>`;
    el.disambig.querySelector("#edArtistLatin").addEventListener("input", (e) => {
      state.newArtist.latin = e.target.value;
    });
    el.disambig.querySelector("#edArtistPron").addEventListener("input", (e) => {
      state.newArtist.pronunciation = e.target.value;
    });
  }

  // ─────────────────────────── submission handoff ───────────────────────────
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

  function setSubmitFeedback(kind, message) {
    state.submitState = { kind, message };
    el.submitBtn.disabled = kind === "busy" || !state.output?.valid;
    renderStatus(state.output, false);
    // Mirror submit lifecycle into a prominent toast (the statusbar is easy to miss).
    if (kind === "busy") showToast("busy", escapeHtml(message), false);
    else if (kind === "done") showToast("success", message, true); // message is safe HTML (PR link)
    else if (kind === "idle" && message) showToast("error", escapeHtml(message), true);
    else hideToast();
  }

  const TOAST_TAGS = { busy: "Submitting…", success: "Submitted", error: "Couldn't submit" };
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
    if (mode !== "new") return;
    try {
      localStorage.setItem(SUBMISSION_STORAGE_KEY, el.area.value);
    } catch (_) {}
  }
  function loadDraft() {
    try {
      const stored = localStorage.getItem(SUBMISSION_STORAGE_KEY);
      return stored && stored.trim() ? stored : null;
    } catch (_) {
      return null;
    }
  }

  function destroy() {
    clearTimeout(resolveTimer);
    document.removeEventListener("pointerdown", onDocPointerDown);
    document.removeEventListener("keydown", onDocKeydown);
    window.removeEventListener("resize", positionNotes);
    for (const suggest of suggests) suggest.destroy();
    audio.destroy();
  }

  return { getSubmission: buildSubmission, setSubmitFeedback, destroy };
}

// ─────────────────────────── pure helpers ───────────────────────────
function template(mode) {
  const submitLabel = mode === "edit" ? "Open edit PR" : "Submit via PR";
  return `
  <article class="submit-editor-app">
    <header class="submit-toolbar">
      <div class="submit-brand">
        <a class="submit-logo" href="#/">XLRCDB</a>
        <span>${mode === "edit" ? "Edit" : "New"}</span>
      </div>
      <div class="submit-toolbar-group">
        <button class="submit-tool-button" id="edImport" type="button">${ICON_IMPORT} Import</button>
        <input class="visually-hidden" id="edImportFile" type="file" accept=".xlrc,.lrc,.txt,text/plain">
        <button class="submit-tool-button" id="edAudioBtn" type="button">${ICON_AUDIO} Load audio</button>
        <input class="visually-hidden" id="edAudioFile" type="file" accept="audio/*,.mp3,.flac,.wav,.m4a,.ogg">
      </div>
      <div class="submit-toolbar-spacer"></div>
      <div class="submit-toolbar-group">
        <a class="submit-tool-button" href="#/">Browse</a>
        <button class="submit-tool-button" id="edCopy" type="button" disabled>Copy</button>
        <button class="submit-tool-button" id="edExport" type="button" disabled>Export</button>
        <button class="submit-tool-button primary" id="edSubmit" type="button" disabled>${submitLabel}</button>
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
    <div class="ed-notices" id="edNotices" aria-live="polite"></div>

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
      <section class="submit-preview-pane" id="edPreview" aria-live="polite"></section>
    </div>

    <div class="ed-transport disabled" id="edTransport">
      <button class="play-btn" id="edPlay" aria-label="Play / pause">${ICON_PLAY}${ICON_PAUSE}</button>
      <div class="scrub-wrap"><div class="scrub" id="edScrub">
        <canvas class="wave" id="edWave"></canvas>
        <div class="mk-rail" id="edMarkers"></div>
        <div class="playhead" id="edPlayhead"></div>
        <div class="scrub-tip" id="edScrubTip"></div>
      </div></div>
      <div class="time" id="edTime">00:00.00 / 00:00.00</div>
      <label class="ed-speed" title="Playback speed (slow down to time lyrics)">
        <input type="range" id="edSpeed" min="0.1" max="1" step="0.05" value="1" aria-label="Playback speed">
        <span id="edSpeedVal">1x</span>
      </label>
      <button class="ed-stamp" id="edStamp" type="button" disabled title="Set [mm:ss.xx] on the current line at the playhead (Alt+Enter)">Stamp ⏎</button>
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
