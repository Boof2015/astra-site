import { parseXLRC, validateXLRC } from "../xlrc/assets/xlrc.js";

const DATA_SOURCE = "https://boof2015.github.io/xlrcdb";
const DATA_REPO_URL = "https://github.com/Boof2015/xlrcdb";
const SUBMISSION_STORAGE_KEY = "xlrcdb-submission-draft";
const HEADER_TAG_PATTERN = /^\[([A-Za-z][A-Za-z0-9_-]*):([^\]]*)\]\s*$/u;
const LENGTH_PATTERN = /^(\d+):([0-5]\d)$/u;
const MANAGED_SUBMISSION_HEADERS = new Set(["ar", "ti", "length"]);
const DEFAULT_SUBMISSION = {
  artist: "",
  title: "",
  length: "",
  source: "[ti:]\n[ar:]\n[length:]\n\n[00:00.00]\n"
};

const state = {
  aliasesIndex: null,
  aliasEntries: [],
  artistCache: new Map(),
  trackTextCache: new Map(),
  loading: true,
  error: null,
  searchToken: 0,
  submission: loadSubmissionDraft(),
  submissionOutput: null,
  submissionToken: 0
};

const elements = {};

document.addEventListener("DOMContentLoaded", () => {
  elements.statusDot = document.getElementById("statusDot");
  elements.sourceStatus = document.getElementById("sourceStatus");
  elements.artistCount = document.getElementById("artistCount");
  elements.aliasCount = document.getElementById("aliasCount");
  elements.artistSearch = document.getElementById("artistSearch");
  elements.trackSearch = document.getElementById("trackSearch");
  elements.results = document.getElementById("results");
  elements.detailPane = document.getElementById("detailPane");
  elements.refreshButton = document.getElementById("refreshButton");
  elements.searchForm = document.getElementById("searchForm");

  elements.searchForm.addEventListener("submit", (event) => event.preventDefault());
  elements.artistSearch.addEventListener("input", () => renderSearch());
  elements.trackSearch.addEventListener("input", () => renderSearch());
  elements.refreshButton.addEventListener("click", () => refresh());
  window.addEventListener("hashchange", () => renderRoute());

  refresh();
});

async function refresh() {
  state.loading = true;
  state.error = null;
  state.aliasesIndex = null;
  state.aliasEntries = [];
  state.artistCache.clear();
  state.trackTextCache.clear();

  setStatus("loading", "Connecting to source");
  renderStats();
  renderSearch();
  renderRoute();

  try {
    state.aliasesIndex = await fetchJson(joinUrl(DATA_SOURCE, "index/aliases.json"));
    state.aliasEntries = Object.entries(state.aliasesIndex.aliases ?? {})
      .sort(([left], [right]) => compareStrings(left, right));
    state.loading = false;
    setStatus("online", `Connected to ${new URL(DATA_SOURCE).hostname}`);
  } catch (error) {
    state.loading = false;
    state.error = error;
    setStatus("error", "Source unavailable");
  }

  renderStats();
  renderSearch();
  renderRoute();
}

function renderStats() {
  const artistIds = new Set(state.aliasEntries.map(([, artistId]) => artistId));
  elements.artistCount.textContent = String(artistIds.size);
  elements.aliasCount.textContent = String(state.aliasEntries.length);
}

async function renderSearch() {
  const token = ++state.searchToken;
  const artistQuery = normalizeKey(elements.artistSearch.value);
  const trackQuery = normalizeKey(elements.trackSearch.value);

  if (state.loading) {
    elements.results.innerHTML = resultMessage("Loading index");
    return;
  }

  if (state.error) {
    elements.results.innerHTML = resultMessage("Source unavailable");
    return;
  }

  if (state.aliasEntries.length === 0) {
    elements.results.innerHTML = resultMessage("No artists indexed yet");
    return;
  }

  if (!artistQuery && trackQuery) {
    elements.results.innerHTML = resultMessage("Enter an artist to filter tracks");
    return;
  }

  const matches = collectArtistMatches(artistQuery).slice(0, 40);
  if (matches.length === 0) {
    elements.results.innerHTML = resultMessage("No matching artists");
    return;
  }

  elements.results.innerHTML = resultMessage("Loading results");
  const rows = [];

  for (const match of matches) {
    const artist = await getArtistIndex(match.artistId).catch(() => null);
    if (token !== state.searchToken) {
      return;
    }

    if (!artist) {
      rows.push(renderArtistResult({
        id: match.artistId,
        canonical_name: match.artistId,
        tracks: []
      }, match.aliases, []));
      continue;
    }

    const trackMatches = trackQuery
      ? artist.tracks.filter((track) => normalizeKey(track.title).includes(trackQuery))
      : artist.tracks;

    if (trackQuery && trackMatches.length === 0) {
      continue;
    }

    rows.push(renderArtistResult(artist, match.aliases, trackMatches));
  }

  elements.results.innerHTML = rows.length > 0 ? rows.join("") : resultMessage("No matching tracks");
}

function collectArtistMatches(query) {
  const matches = new Map();

  for (const [alias, artistId] of state.aliasEntries) {
    if (query && !alias.includes(query)) {
      continue;
    }

    const match = matches.get(artistId) ?? { artistId, aliases: [] };
    match.aliases.push(alias);
    matches.set(artistId, match);
  }

  return [...matches.values()].sort((left, right) => compareStrings(left.artistId, right.artistId));
}

function renderArtistResult(artist, aliases, tracks) {
  const aliasText = aliases.slice(0, 3).join(", ");
  const trackLabel = `${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}`;

  return `
    <a class="result-row" href="#/artist/${encodeURIComponent(artist.id)}">
      <span class="title-line">
        <strong>${escapeHtml(artist.canonical_name)}</strong>
        <small>${escapeHtml(trackLabel)}</small>
      </span>
      <p>${escapeHtml(aliasText || artist.id)}</p>
    </a>
  `;
}

async function renderRoute() {
  const route = parseRoute();
  document.body.classList.toggle("submit-mode", route.name === "submit");

  if (route.name === "submit") {
    renderSubmit();
    return;
  }

  if (state.loading) {
    elements.detailPane.innerHTML = `
      <div class="loading-state">
        <p class="eyebrow">Live source</p>
        <h2>Loading XLRCDB</h2>
        <p>Fetching the static index from GitHub Pages.</p>
      </div>
    `;
    return;
  }

  if (state.error) {
    elements.detailPane.innerHTML = `
      <div class="error-state">
        <p class="eyebrow">Live source</p>
        <h2>Source unavailable</h2>
        <p>${escapeHtml(state.error.message || "The static data source could not be loaded.")}</p>
      </div>
    `;
    return;
  }

  if (route.name === "artist") {
    await renderArtist(route.artistId);
    return;
  }

  if (route.name === "track") {
    await renderTrack(route.artistId, route.trackId);
    return;
  }

  renderHome();
}

function renderHome() {
  if (state.aliasEntries.length === 0) {
    elements.detailPane.innerHTML = `
      <div class="empty-state">
        <p class="eyebrow">Database online</p>
        <h2>No tracks indexed yet</h2>
        <p>The static source is live at ${escapeHtml(DATA_SOURCE)}, and new XLRC files will appear here after they are normalized into the data repo.</p>
      </div>
    `;
    return;
  }

  elements.detailPane.innerHTML = `
    <div class="empty-state">
      <p class="eyebrow">Browse</p>
      <h2>Select an artist</h2>
      <p>The index contains ${escapeHtml(String(new Set(state.aliasEntries.map(([, artistId]) => artistId)).size))} artists and ${escapeHtml(String(state.aliasEntries.length))} searchable aliases.</p>
    </div>
  `;
}

async function renderArtist(artistId) {
  elements.detailPane.innerHTML = loadingMarkup("Loading artist");

  try {
    const artist = await getArtistIndex(artistId);
    const aliases = state.aliasEntries
      .filter(([, id]) => id === artist.id)
      .map(([alias]) => alias);

    elements.detailPane.innerHTML = `
      <article>
        <div class="detail-header">
          <div>
            <p class="eyebrow">Artist</p>
            <h2>${escapeHtml(artist.canonical_name)}</h2>
          </div>
          <div class="detail-actions">
            <a class="link-button" href="#/">Search</a>
            <a class="link-button" href="${escapeHtml(joinUrl(DATA_SOURCE, artistIndexPath(artist.id)))}" target="_blank" rel="noopener">JSON</a>
          </div>
        </div>

        <div class="meta-grid">
          <div class="metadata-row"><small>Artist ID</small><strong>${escapeHtml(artist.id)}</strong></div>
          <div class="metadata-row"><small>Tracks</small><strong>${escapeHtml(String(artist.tracks.length))}</strong></div>
          <div class="metadata-row"><small>Aliases</small><strong>${escapeHtml(String(aliases.length))}</strong></div>
        </div>

        <div class="alias-list">
          ${aliases.map((alias) => `<span class="alias-chip">${escapeHtml(alias)}</span>`).join("")}
        </div>

        <div class="section-title">
          <h3>Tracks</h3>
        </div>
        <div class="track-list">
          ${artist.tracks.length === 0 ? resultMessage("No tracks indexed for this artist") : artist.tracks.map((track) => renderTrackRow(artist.id, track)).join("")}
        </div>
      </article>
    `;
  } catch (error) {
    elements.detailPane.innerHTML = errorMarkup("Artist unavailable", error);
  }
}

function renderTrackRow(artistId, track) {
  return `
    <a class="track-row" href="#/track/${encodeURIComponent(artistId)}/${encodeURIComponent(track.id)}">
      <strong>${escapeHtml(track.title)}</strong>
      <span>${formatDuration(track.length)}</span>
      <code>${escapeHtml(track.id)}</code>
    </a>
  `;
}

async function renderTrack(artistId, trackId) {
  elements.detailPane.innerHTML = loadingMarkup("Loading track");

  try {
    const artist = await getArtistIndex(artistId);
    const track = artist.tracks.find((candidate) => candidate.id === trackId);
    if (!track) {
      elements.detailPane.innerHTML = errorMarkup("Track unavailable", new Error("The track is not listed for this artist."));
      return;
    }

    const text = await getTrackText(track.path);
    const parsed = parsePreview(text);

    elements.detailPane.innerHTML = `
      <article>
        <div class="detail-header">
          <div>
            <p class="eyebrow">Track</p>
            <h2>${escapeHtml(track.title)}</h2>
          </div>
          <div class="detail-actions">
            <a class="link-button" href="#/artist/${encodeURIComponent(artist.id)}">Artist</a>
            <a class="link-button" href="${escapeHtml(joinUrl(DATA_SOURCE, track.path))}" target="_blank" rel="noopener">XLRC</a>
          </div>
        </div>

        <div class="meta-grid">
          <div class="metadata-row"><small>Artist</small><strong>${escapeHtml(artist.canonical_name)}</strong></div>
          <div class="metadata-row"><small>Length</small><strong>${escapeHtml(formatDuration(track.length))}</strong></div>
          <div class="metadata-row"><small>Track ID</small><strong>${escapeHtml(track.id)}</strong></div>
        </div>

        <div class="section-title">
          <h3>Lyrics</h3>
        </div>
        <div class="lyric-list">
          ${parsed.lines.length === 0 ? resultMessage("No timed lyric lines") : parsed.lines.map(renderLyricRow).join("")}
        </div>

        <div class="section-title">
          <h3>Raw XLRC</h3>
        </div>
        <pre class="raw-block">${escapeHtml(text)}</pre>
      </article>
    `;
  } catch (error) {
    elements.detailPane.innerHTML = errorMarkup("Track unavailable", error);
  }
}

function renderSubmit() {
  const draft = normalizeSubmissionDraft(state.submission);
  state.submission = draft;
  elements.detailPane.innerHTML = `
    <article class="submit-editor-app">
      <header class="submit-toolbar">
        <div class="submit-brand">
          <a class="submit-logo" href="#/">XLRCDB</a>
          <span>Submit</span>
        </div>
        <div class="submit-toolbar-group">
          <button class="submit-tool-button" id="importSubmission" type="button">Import</button>
          <input class="visually-hidden" id="importSubmissionFile" type="file" accept=".xlrc,text/plain">
        </div>
        <div class="submit-toolbar-spacer"></div>
        <div class="submit-toolbar-group">
          <a class="submit-tool-button" href="#/">Search</a>
          <button class="submit-tool-button" id="copySubmission" type="button" disabled>Copy</button>
          <button class="submit-tool-button primary" id="downloadSubmission" type="button" disabled>Export .xlrc</button>
          <a class="submit-tool-button" href="${DATA_REPO_URL}/pulls" target="_blank" rel="noopener">Open PR</a>
        </div>
      </header>

      <section class="submit-meta-bar" aria-label="Submission metadata">
        <label>
          <span>Artist</span>
          <input id="submitArtist" name="artist" type="text" value="${escapeHtml(draft.artist)}" placeholder="Artist">
        </label>
        <label>
          <span>Track</span>
          <input id="submitTitle" name="title" type="text" value="${escapeHtml(draft.title)}" placeholder="Title">
        </label>
        <label class="submit-length-field">
          <span>Length</span>
          <input id="submitLength" name="length" type="text" value="${escapeHtml(draft.length)}" inputmode="numeric" placeholder="03:42">
        </label>
        <div class="submit-status-pill" id="submissionStatus">Checking</div>
      </section>

      <div class="submit-main">
        <section class="submit-source-pane" aria-label="XLRC source editor">
          <div class="submit-gutter" id="submissionGutter" aria-hidden="true"></div>
          <textarea class="submit-source-area" id="submitSource" name="source" spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off">${escapeHtml(draft.source)}</textarea>
        </section>
        <div class="submit-divider" aria-hidden="true"></div>
        <section class="submit-preview-pane" id="submissionPreview" aria-live="polite"></section>
      </div>

      <footer class="submit-statusbar">
        <span id="submitStatusText">Checking</span>
        <span id="submissionPath">incoming/artist-track.xlrc</span>
        <span id="submitLineCount">0 lines</span>
      </footer>
    </article>
  `;

  const fields = {
    artist: document.getElementById("submitArtist"),
    title: document.getElementById("submitTitle"),
    length: document.getElementById("submitLength"),
    source: document.getElementById("submitSource")
  };
  const importInput = document.getElementById("importSubmissionFile");

  for (const field of [fields.artist, fields.title, fields.length]) {
    field.addEventListener("input", () => {
      fields.source.value = buildSubmissionText(readSubmissionForm(fields));
      persistAndUpdateSubmission(fields);
    });
  }

  fields.source.addEventListener("input", () => {
    syncSubmissionFieldsFromSource(fields);
    persistAndUpdateSubmission(fields);
  });

  fields.source.addEventListener("scroll", () => {
    const gutter = document.getElementById("submissionGutter");
    if (gutter) {
      gutter.scrollTop = fields.source.scrollTop;
    }
  });

  document.getElementById("importSubmission").addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", async () => {
    const file = importInput.files?.[0];
    if (!file) {
      return;
    }

    fields.source.value = await file.text();
    syncSubmissionFieldsFromSource(fields);
    persistAndUpdateSubmission(fields);
    importInput.value = "";
  });

  document.getElementById("downloadSubmission").addEventListener("click", () => {
    if (state.submissionOutput?.valid) {
      downloadTextFile(state.submissionOutput.filename, state.submissionOutput.text);
    }
  });

  document.getElementById("copySubmission").addEventListener("click", async () => {
    if (!state.submissionOutput?.valid) {
      return;
    }

    const button = document.getElementById("copySubmission");
    try {
      await navigator.clipboard.writeText(state.submissionOutput.text);
      button.textContent = "Copied";
      window.setTimeout(() => {
        button.textContent = "Copy XLRC";
      }, 1400);
    } catch (error) {
      renderSubmissionStatus({
        ...state.submissionOutput,
        errors: [submissionError(`Clipboard unavailable: ${error.message || "copy failed"}`)],
        valid: false
      });
    }
  });

  persistAndUpdateSubmission(fields);
}

async function updateSubmissionPreview(fields) {
  const token = ++state.submissionToken;
  const output = createSubmissionOutput(readSubmissionForm(fields));
  state.submissionOutput = output;
  renderSubmissionStatus(output);

  const shouldCheckDuplicate = output.valid && !state.loading && !state.error && state.aliasesIndex;
  if (!shouldCheckDuplicate) {
    return;
  }

  renderSubmissionStatus({ ...output, checking: true });
  const duplicate = await findSubmissionDuplicate(output).catch(() => null);
  if (token !== state.submissionToken) {
    return;
  }

  if (duplicate) {
    output.errors.push(submissionError(`Possible duplicate: ${duplicate.artist.canonical_name} - ${duplicate.track.title} (${formatDuration(duplicate.track.length)})`));
    output.valid = false;
  }

  state.submissionOutput = output;
  renderSubmissionStatus(output);
}

function persistAndUpdateSubmission(fields) {
  state.submission = readSubmissionForm(fields);
  saveSubmissionDraft(state.submission);
  updateSubmissionPreview(fields);
}

function readSubmissionForm(fields) {
  return {
    artist: fields.artist.value,
    title: fields.title.value,
    length: fields.length.value,
    source: fields.source.value
  };
}

function createSubmissionOutput(input) {
  const text = ensureTrailingNewline(input.source);
  const errors = [];
  const warningLines = new Set();
  let parsed = null;

  try {
    parsed = parseXLRC(text);
  } catch (error) {
    errors.push(submissionError(error.message || "XLRC could not be parsed"));
  }

  if (parsed) {
    for (const warning of parsed.warnings) {
      warningLines.add(warning.line);
      errors.push(submissionError(formatPackageWarning(warning), warning.line));
    }

    for (const warning of validateXLRC(parsed).warnings.filter((warning) => warning.code !== "invalid-length")) {
      if (warning.line > 0) {
        warningLines.add(warning.line);
      }
      errors.push(submissionError(formatPackageWarning(warning), warning.line));
    }
  }

  const artist = typeof parsed?.meta.ar === "string" ? parsed.meta.ar.trim() : "";
  const title = typeof parsed?.meta.ti === "string" ? parsed.meta.ti.trim() : "";
  const length = typeof parsed?.meta.length === "string" ? parsed.meta.length.trim() : "";
  const lengthSeconds = parseLengthSeconds(length);

  if (!artist) {
    const line = findHeaderLine(text, "ar");
    errors.push(submissionError("Missing non-empty [ar:] header", line));
    if (line) {
      warningLines.add(line);
    }
  }

  if (!title) {
    const line = findHeaderLine(text, "ti");
    errors.push(submissionError("Missing non-empty [ti:] header", line));
    if (line) {
      warningLines.add(line);
    }
  }

  if (!length) {
    const line = findHeaderLine(text, "length");
    errors.push(submissionError("Missing non-empty [length:] header", line));
    if (line) {
      warningLines.add(line);
    }
  } else if (lengthSeconds === undefined) {
    const line = findHeaderLine(text, "length");
    errors.push(submissionError("Length must use mm:ss with seconds below 60", line));
    if (line) {
      warningLines.add(line);
    }
  }

  const filename = `${slugify(artist || "artist")}-${slugify(title || "track")}.xlrc`;
  const preview = parsePreview(text);

  return {
    artist,
    title,
    length,
    lengthSeconds,
    text,
    filename,
    targetPath: `incoming/${filename}`,
    preview,
    errors,
    warningLines,
    lineCount: text.split(/\r?\n/u).length,
    valid: errors.length === 0
  };
}

function buildSubmissionText(input) {
  const split = splitSubmissionSource(input.source);
  const albumHeaders = split.preservedHeaders.filter((header) => header.key === "al");
  const otherHeaders = split.preservedHeaders.filter((header) => header.key !== "al");
  const headers = [
    `[ti:${input.title.trim()}]`,
    `[ar:${input.artist.trim()}]`,
    ...albumHeaders.map((header) => header.line),
    `[length:${input.length.trim()}]`,
    ...otherHeaders.map((header) => header.line)
  ];
  const body = split.body.trimStart();

  return `${headers.join("\n")}\n\n${body}${body.endsWith("\n") ? "" : "\n"}`;
}

function splitSubmissionSource(source) {
  const lines = source.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  const preservedHeaders = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const match = line.match(HEADER_TAG_PATTERN);
    if (!match) {
      break;
    }

    const key = (match[1] ?? "").toLowerCase();
    if (!MANAGED_SUBMISSION_HEADERS.has(key)) {
      preservedHeaders.push({ key, line: line.trimEnd() });
    }
    index += 1;
  }

  while ((lines[index] ?? "").trim() === "" && index < lines.length) {
    index += 1;
  }

  return {
    preservedHeaders,
    body: lines.slice(index).join("\n")
  };
}

function renderSubmissionStatus(output) {
  const status = document.getElementById("submissionStatus");
  const path = document.getElementById("submissionPath");
  const preview = document.getElementById("submissionPreview");
  const gutter = document.getElementById("submissionGutter");
  const lineCount = document.getElementById("submitLineCount");
  const statusText = document.getElementById("submitStatusText");
  const download = document.getElementById("downloadSubmission");
  const copy = document.getElementById("copySubmission");

  if (!status || !path || !preview || !gutter || !lineCount || !statusText || !download || !copy) {
    return;
  }

  path.textContent = output.targetPath;
  lineCount.textContent = `${output.lineCount} ${output.lineCount === 1 ? "line" : "lines"}`;
  gutter.innerHTML = renderSubmissionGutter(output.text, output.warningLines);
  download.disabled = !output.valid;
  copy.disabled = !output.valid;
  preview.innerHTML = renderSubmissionPreview(output);

  if (output.checking) {
    status.className = "submit-status-pill";
    status.textContent = "Checking";
    statusText.textContent = "Checking live index for duplicates";
    return;
  }

  if (output.valid) {
    status.className = "submit-status-pill valid";
    status.textContent = "Valid";
    statusText.textContent = "Ready to submit";
    return;
  }

  status.className = "submit-status-pill invalid";
  status.textContent = "Invalid";
  statusText.textContent = output.errors[0]?.message ?? "Needs changes";
}

async function findSubmissionDuplicate(output) {
  const aliases = state.aliasesIndex?.aliases ?? {};
  const artistId = aliases[normalizeKey(output.artist)];
  if (!artistId || output.lengthSeconds === undefined) {
    return null;
  }

  const artist = await getArtistIndex(artistId);
  const normalizedTitle = normalizeKey(output.title);
  const track = artist.tracks.find((candidate) => (
    normalizeKey(candidate.title) === normalizedTitle &&
    Math.abs(candidate.length - output.lengthSeconds) <= 1
  ));

  return track ? { artist, track } : null;
}

function saveSubmissionDraft(draft) {
  try {
    localStorage.setItem(SUBMISSION_STORAGE_KEY, JSON.stringify(draft));
  } catch (error) {
    // Private browsing or storage limits should not block editing.
  }
}

function loadSubmissionDraft() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SUBMISSION_STORAGE_KEY) || "null");
    if (parsed && typeof parsed === "object") {
      return normalizeSubmissionDraft({
        artist: typeof parsed.artist === "string" ? parsed.artist : DEFAULT_SUBMISSION.artist,
        title: typeof parsed.title === "string" ? parsed.title : DEFAULT_SUBMISSION.title,
        length: typeof parsed.length === "string" ? parsed.length : DEFAULT_SUBMISSION.length,
        source: typeof parsed.source === "string" ? parsed.source : DEFAULT_SUBMISSION.source
      });
    }
  } catch (error) {
    // Ignore malformed stored drafts.
  }

  return { ...DEFAULT_SUBMISSION };
}

function normalizeSubmissionDraft(draft) {
  const source = draft.source || DEFAULT_SUBMISSION.source;
  const sourceHeaders = readSubmissionHeaders(source);
  const normalized = {
    artist: draft.artist || sourceHeaders.artist || DEFAULT_SUBMISSION.artist,
    title: draft.title || sourceHeaders.title || DEFAULT_SUBMISSION.title,
    length: draft.length || sourceHeaders.length || DEFAULT_SUBMISSION.length,
    source
  };

  if (!sourceHasHeaderBlock(source)) {
    normalized.source = buildSubmissionText(normalized);
  }

  return normalized;
}

function syncSubmissionFieldsFromSource(fields) {
  const headers = readSubmissionHeaders(fields.source.value);
  fields.artist.value = headers.artist;
  fields.title.value = headers.title;
  fields.length.value = headers.length;
}

function readSubmissionHeaders(source) {
  const headers = { artist: "", title: "", length: "" };
  for (const line of source.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    if (line.trim() === "") {
      continue;
    }

    const match = line.match(HEADER_TAG_PATTERN);
    if (!match) {
      break;
    }

    const key = (match[1] ?? "").toLowerCase();
    const value = match[2] ?? "";
    if (key === "ar") {
      headers.artist = value;
    } else if (key === "ti") {
      headers.title = value;
    } else if (key === "length") {
      headers.length = value;
    }
  }

  return headers;
}

function sourceHasHeaderBlock(source) {
  return source.replace(/^\uFEFF/u, "").split(/\r?\n/u).some((line) => {
    if (line.trim() === "") {
      return false;
    }

    return HEADER_TAG_PATTERN.test(line);
  });
}

function renderSubmissionGutter(text, warningLines) {
  return text.split(/\r?\n/u).map((_, index) => {
    const line = index + 1;
    const className = warningLines.has(line) ? " warn" : "";
    return `<div class="submit-ln${className}">${line}</div>`;
  }).join("");
}

function renderSubmissionPreview(output) {
  const errors = output.errors.slice(0, 5);
  const lines = output.preview.lines.slice(0, 24);

  return `
    <div class="submit-preview-surface">
      ${errors.length > 0 ? `
        <div class="submit-error-list">
          <strong>Needs changes</strong>
          ${errors.map((error) => `<div>${escapeHtml(error.message)}</div>`).join("")}
        </div>
      ` : ""}
      <div class="submit-preview-lines">
        ${lines.length === 0 ? `
          <div class="submit-preview-empty">No timed lyric lines</div>
        ` : lines.map((line) => `
          <div class="submit-preview-line">
            <time>${escapeHtml(line.time)}</time>
            <div>
              <strong>${escapeHtml(line.text || "(clear)")}</strong>
              ${line.translations.map((translation) => `<span>${escapeHtml(translation.lang)} ${escapeHtml(translation.text)}</span>`).join("")}
            </div>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function submissionError(message, line = 0) {
  return { message, line };
}

function ensureTrailingNewline(value) {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function findHeaderLine(text, header) {
  const lines = text.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      continue;
    }

    const match = line.match(HEADER_TAG_PATTERN);
    if (!match) {
      break;
    }

    if ((match[1] ?? "").toLowerCase() === header) {
      return index + 1;
    }
  }

  return 0;
}

function formatPackageWarning(warning) {
  const prefix = Number.isInteger(warning.line) && warning.line > 0 ? `Line ${warning.line}: ` : "";
  return `${prefix}${warning.message}`;
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
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function renderLyricRow(line) {
  const text = line.text || "(clear)";
  const translations = line.translations.map((translation) => `
    <div class="translation"><span>${escapeHtml(translation.lang)}</span> ${escapeHtml(translation.text)}</div>
  `).join("");

  return `
    <div class="lyric-row">
      <time>${escapeHtml(line.time)}</time>
      <div>
        <div class="lyric-text">${escapeHtml(text)}</div>
        ${translations}
      </div>
    </div>
  `;
}

async function getArtistIndex(artistId) {
  if (!state.artistCache.has(artistId)) {
    state.artistCache.set(artistId, fetchJson(joinUrl(DATA_SOURCE, artistIndexPath(artistId))));
  }

  return state.artistCache.get(artistId);
}

async function getTrackText(trackPath) {
  if (!state.trackTextCache.has(trackPath)) {
    state.trackTextCache.set(trackPath, fetchText(joinUrl(DATA_SOURCE, trackPath)));
  }

  return state.trackTextCache.get(trackPath);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.text();
}

function parseRoute() {
  const hash = window.location.hash.replace(/^#\/?/u, "");
  const [name = "", artistId = "", trackId = ""] = hash.split("/").map(decodeURIComponent);

  if (name === "submit") {
    return { name };
  }

  if (name === "artist" && artistId) {
    return { name, artistId };
  }

  if (name === "track" && artistId && trackId) {
    return { name, artistId, trackId };
  }

  return { name: "home" };
}

function parsePreview(text) {
  const lines = [];
  let currentLine = null;

  for (const rawLine of text.split(/\r?\n/u)) {
    const lyricMatch = rawLine.match(/^\[(\d+:\d{2}(?:\.\d{1,3})?)\](.*)$/u);
    if (lyricMatch) {
      currentLine = {
        time: lyricMatch[1],
        text: cleanLyricText(lyricMatch[2] ?? ""),
        translations: []
      };
      lines.push(currentLine);
      continue;
    }

    const translationMatch = rawLine.match(/^\[>([A-Za-z0-9-]+)\](.*)$/u);
    if (translationMatch && currentLine) {
      currentLine.translations.push({
        lang: translationMatch[1],
        text: translationMatch[2] ?? ""
      });
    }
  }

  return { lines };
}

function cleanLyricText(value) {
  return value
    .replace(/^\[v:[^\]]*\]/u, "")
    .replace(/<\d+:\d{2}(?:\.\d{1,3})?>/gu, "")
    .replace(/([\u3400-\u9fff々〆ヵヶ]+)\[[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]+\]/gu, "$1");
}

function setStatus(kind, text) {
  elements.statusDot.className = `status-dot ${kind === "online" ? "online" : kind === "error" ? "error" : ""}`;
  elements.sourceStatus.textContent = text;
}

function loadingMarkup(title) {
  return `
    <div class="loading-state">
      <p class="eyebrow">Loading</p>
      <h2>${escapeHtml(title)}</h2>
      <p>Fetching static JSON from XLRCDB.</p>
    </div>
  `;
}

function errorMarkup(title, error) {
  return `
    <div class="error-state">
      <p class="eyebrow">Unavailable</p>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(error.message || "The requested resource could not be loaded.")}</p>
    </div>
  `;
}

function resultMessage(text) {
  return `<div class="metadata-row"><strong>${escapeHtml(text)}</strong></div>`;
}

function normalizeKey(value) {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function artistIndexPath(artistId) {
  const body = artistId.startsWith("art_") ? artistId.slice(4) : artistId;
  return `index/artists/${body.slice(0, 2)}/${body.slice(2, 4)}/${artistId}.json`;
}

function joinUrl(source, path) {
  return `${source.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

function parseLengthSeconds(value) {
  const match = value.match(LENGTH_PATTERN);
  if (!match) {
    return undefined;
  }

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

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}
