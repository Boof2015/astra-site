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
  getArtistIndex,
  normalizeKey,
  resolveArtist
} from "./data.js";
import {
  findHeaderLine,
  patchHeader,
  readHeaders,
  validateLanguageMetadata
} from "./editor-validation.js";

const SUBMISSION_STORAGE_KEY = "xlrcdb-submission-draft";
const LEADING_TIMESTAMP = /^\[\d+:\d{2}(?:\.\d{1,3})?\]/u;
const LENGTH_PATTERN = /^(\d+):([0-5]\d)$/u;
const DEFAULT_SOURCE = "[ti:]\n[ar:]\n[length:]\n[lang:]\n[langs:]\n\n[00:00.00]\n";

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
    statusPill: root.querySelector("#edStatusPill"),
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
        state.source = patchHeader(el.area.value, key, field.value);
        el.area.value = state.source;
        if (key === "ar") resolveArtistDebounced(180);
        persist();
        paint();
      });
    }

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
    // Auto-fill [length:] from the loaded audio (design-doc behaviour).
    const current = (state.parsed.meta.length || "").trim();
    if (!current) {
      el.length.value = formatDuration(seconds);
      state.source = patchHeader(el.area.value, "length", el.length.value);
      el.area.value = state.source;
      persist();
      paint();
    }
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
    const output = computeOutput(el.area.value);
    state.output = output;
    state.parsed = output.parsed;

    buildHighlight(el.highlight, el.area.value, output.warningLines);
    renderGutter(el.area.value, output.warningLines);
    syncScroll();

    state.lineEls = renderLyrics(el.preview, output.parsed, "", { showAll: true });
    setActiveLine(state.activeIdx);
    audio.refreshMarkers();

    el.lineCount.textContent = `${output.lineCount} ${output.lineCount === 1 ? "line" : "lines"}`;
    el.pathText.textContent = output.targetPath;
    const langs = detectedLangs(output.parsed);
    el.langSummary.textContent = langs.length ? langs.map((l) => LANG_LABELS[l] || l).join(", ") : "—";

    renderStatus(output);
    runDuplicateCheck(output);
  }

  function renderStatus(output, checking = false) {
    const sub = state.submitState;
    el.copyBtn.disabled = !output.valid;
    el.exportBtn.disabled = !output.valid;
    el.submitBtn.disabled = !output.valid || sub.kind === "busy";

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
    if (output.valid) {
      el.statusPill.className = "submit-status-pill valid";
      el.statusPill.textContent = "Valid";
    } else {
      el.statusPill.className = "submit-status-pill invalid";
      el.statusPill.textContent = "Invalid";
    }
    // An idle note (config hint, submit error, post-sign-in flash) takes the line.
    if (sub.kind === "idle" && sub.message) {
      el.statusText.textContent = sub.message;
    } else if (output.valid) {
      el.statusText.textContent = mode === "edit" ? "Ready to open edit PR" : "Ready to submit";
    } else {
      el.statusText.textContent = output.errors[0]?.message ?? "Needs changes";
    }
  }

  async function runDuplicateCheck(output) {
    const token = ++state.token;
    if (!output.valid || output.lengthSeconds === undefined) return;
    renderStatus(output, true);
    const dup = await findDuplicate(output).catch(() => null);
    if (token !== state.token) return;
    if (dup) {
      output.errors.push({ message: `Possible duplicate: ${dup.artist.canonical_name} - ${dup.track.title} (${formatDuration(dup.track.length)})`, line: 0 });
      output.valid = false;
      state.output = output;
    }
    renderStatus(output);
  }

  async function findDuplicate(output) {
    const resolved = await resolveArtist(output.artist);
    if (!resolved) return null;
    const artist = await getArtistIndex(resolved.artistId);
    const normalizedTitle = normalizeKey(output.title);
    const track = artist.tracks.find((candidate) =>
      candidate.id !== state.trackId &&
      normalizeKey(candidate.title) === normalizedTitle &&
      Math.abs(candidate.length - output.lengthSeconds) <= 1
    );
    return track ? { artist, track } : null;
  }

  function computeOutput(rawSource) {
    const text = ensureTrailingNewline(rawSource);
    const errors = [];
    const warningLines = new Set();
    let parsed = { meta: {}, lines: [], warnings: [] };

    try {
      parsed = parseXLRC(text);
    } catch (error) {
      errors.push({ message: error.message || "XLRC could not be parsed", line: 0 });
    }

    for (const warning of parsed.warnings) {
      warningLines.add(warning.line);
      errors.push({ message: formatPackageWarning(warning), line: warning.line });
    }
    for (const warning of validateXLRC(parsed).warnings.filter((warning) => (
      warning.code !== "invalid-length" &&
      !(
        warning.code === "invalid-lang" &&
        (typeof parsed.meta.lang !== "string" || parsed.meta.lang.trim() === "")
      )
    ))) {
      if (warning.line > 0) warningLines.add(warning.line);
      errors.push({ message: formatPackageWarning(warning), line: warning.line });
    }

    const artist = typeof parsed.meta.ar === "string" ? parsed.meta.ar.trim() : "";
    const title = typeof parsed.meta.ti === "string" ? parsed.meta.ti.trim() : "";
    const length = typeof parsed.meta.length === "string" ? parsed.meta.length.trim() : "";
    const lengthSeconds = parseLengthSeconds(length);

    requireHeader(text, artist, "ar", "Missing non-empty [ar:] header", errors, warningLines);
    requireHeader(text, title, "ti", "Missing non-empty [ti:] header", errors, warningLines);
    if (!length) {
      requireHeader(text, length, "length", "Missing non-empty [length:] header", errors, warningLines);
    } else if (lengthSeconds === undefined) {
      const line = findHeaderLine(text, "length");
      errors.push({ message: "Length must use mm:ss with seconds below 60", line });
      if (line) warningLines.add(line);
    }

    for (const error of validateLanguageMetadata(parsed, text)) {
      errors.push(error);
      if (error.line) warningLines.add(error.line);
    }

    const filename = `${slugify(artist || "artist")}-${slugify(title || "track")}.xlrc`;
    const targetPath = mode === "edit" && state.trackPath ? state.trackPath : `incoming/${filename}`;

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
      errors,
      warningLines,
      lineCount: text.split(/\r?\n/u).length,
      valid: errors.length === 0
    };
  }

  function renderGutter(text, warningLines) {
    el.gutter.innerHTML = text.split(/\r?\n/u).map((_, index) => {
      const line = index + 1;
      return `<div class="ln${warningLines.has(line) ? " warn" : ""}">${line}</div>`;
    }).join("");
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
      state.artistResolution = { status: "new", name };
    }
    renderDisambig();
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
    // new artist: offer optional latin name + pronunciation
    el.disambig.className = "ed-disambig new";
    el.disambig.innerHTML = `
      <span class="ed-disambig-dot"></span>
      <span>New artist <strong>${escapeHtml(r.name)}</strong> will be created</span>
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
      <label><span>Primary language</span><input id="edLang" data-header="lang" type="text" placeholder="ja" autocapitalize="off" spellcheck="false"></label>
      <label><span>All languages</span><input id="edLangList" data-header="langs" type="text" placeholder="ja,en" autocapitalize="off" spellcheck="false"></label>
      <div class="submit-status-pill" id="edStatusPill">Checking</div>
    </section>

    <div class="ed-disambig" id="edDisambig"></div>

    <div class="submit-main">
      <section class="submit-source-pane" aria-label="XLRC source editor">
        <div class="ed-gutter" id="edGutter" aria-hidden="true"></div>
        <div class="ed-input">
          <div class="ed-activeline" id="edActiveline" aria-hidden="true"></div>
          <div class="ed-curline" id="edCurline"></div>
          <pre class="ed-highlight" id="edHighlight" aria-hidden="true"></pre>
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
      <span id="edStatusText">Checking</span>
      <span id="edPath">incoming/artist-track.xlrc</span>
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

function requireHeader(text, value, key, message, errors, warningLines) {
  if (value) return;
  const line = findHeaderLine(text, key);
  errors.push({ message, line });
  if (line) warningLines.add(line);
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

function formatPackageWarning(warning) {
  const prefix = Number.isInteger(warning.line) && warning.line > 0 ? `Line ${warning.line}: ` : "";
  return `${prefix}${warning.message}`;
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
