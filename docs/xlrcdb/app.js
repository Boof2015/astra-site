// xlrcdb SPA entry point: routing, search (artist + global track), browse
// (artist / track), and the glue that mounts the editor and drives the GitHub
// contribution flow. Data access lives in data.js; the editor and PR mechanics
// live in editor.js / github.js.

import { parseXLRC } from "../xlrc/assets/xlrc.js";
import {
  DATA_SOURCE,
  DATA_REPO_URL,
  loadAliases,
  getAliasEntries,
  getAliasesIndex,
  getArtistIndex,
  getTrackText,
  clearCaches,
  normalizeKey,
  artistIndexPath,
  joinUrl,
  formatDuration,
  fetchText,
  compareStrings
} from "./data.js";
import { renderLyrics } from "./render.js";
import { createEditor } from "./editor.js";
import { createGitHub } from "./github.js";

const github = createGitHub();

const ui = {
  loading: true,
  error: null,
  searchToken: 0,
  searchTimer: 0,
  trackIndex: null,
  trackIndexPromise: null,
  editor: null,
  mountedRoute: null,
  user: null,
  flash: null
};

// Carries an initial editor state across a navigation (prefill / OAuth restore).
let pendingEditorInitial = null;

const el = {};

document.addEventListener("DOMContentLoaded", async () => {
  el.statusDot = document.getElementById("statusDot");
  el.sourceStatus = document.getElementById("sourceStatus");
  el.artistCount = document.getElementById("artistCount");
  el.aliasCount = document.getElementById("aliasCount");
  el.artistSearch = document.getElementById("artistSearch");
  el.trackSearch = document.getElementById("trackSearch");
  el.results = document.getElementById("results");
  el.detailPane = document.getElementById("detailPane");
  el.refreshButton = document.getElementById("refreshButton");
  el.searchForm = document.getElementById("searchForm");
  el.authStrip = document.getElementById("authStrip");

  el.searchForm.addEventListener("submit", (e) => e.preventDefault());
  el.artistSearch.addEventListener("input", scheduleSearch);
  el.trackSearch.addEventListener("input", scheduleSearch);
  el.refreshButton.addEventListener("click", () => refresh());
  window.addEventListener("hashchange", () => renderRoute());

  // Complete an OAuth round-trip if we're returning from GitHub.
  const redirect = await github.handleRedirect();
  if (redirect.returned) {
    if (redirect.error) ui.flash = redirect.error;
    if (redirect.pending?.initial) pendingEditorInitial = redirect.pending.initial;
    if (redirect.hash && location.hash !== redirect.hash) {
      location.hash = redirect.hash;
    }
  }

  renderAuthStrip();
  refresh();
});

async function refresh() {
  ui.loading = true;
  ui.error = null;
  ui.trackIndex = null;
  ui.trackIndexPromise = null;
  clearCaches();

  setStatus("loading", "Connecting to source");
  renderStats();
  renderSearch();
  renderRoute();

  try {
    await loadAliases();
    ui.loading = false;
    setStatus("online", `Connected to ${new URL(DATA_SOURCE).hostname}`);
  } catch (error) {
    ui.loading = false;
    ui.error = error;
    setStatus("error", "Source unavailable");
  }

  renderStats();
  renderSearch();
  renderRoute();
}

// ─────────────────────────── auth strip ───────────────────────────
async function renderAuthStrip() {
  if (!el.authStrip) return;
  if (!github.isConfigured()) {
    el.authStrip.innerHTML = "";
    return;
  }
  if (!github.isAuthed()) {
    renderSignedOut();
    return;
  }

  // Signed in: show who, fetched once and cached. Return here after sign-in too.
  if (!ui.user) {
    el.authStrip.innerHTML = `<span class="auth-dot online"></span><span class="muted">Signed in…</span>`;
    ui.user = await github.getUser().catch(() => null);
  }
  if (!github.isAuthed()) {
    // The token was rejected (cleared by a 401 during getUser).
    renderSignedOut();
    return;
  }

  const who = ui.user
    ? `<img class="auth-avatar" src="${escapeHtml(ui.user.avatar_url)}" alt=""><span class="auth-user">@${escapeHtml(ui.user.login)}</span>`
    : `<span class="auth-dot online"></span><span>Signed in</span>`;
  el.authStrip.innerHTML = `${who}<button class="link-button" id="authOut" type="button">Sign out</button>`;
  el.authStrip.querySelector("#authOut").addEventListener("click", () => {
    github.logout();
    ui.user = null;
    renderAuthStrip();
  });
}

function renderSignedOut() {
  ui.user = null;
  el.authStrip.innerHTML = `<span class="auth-dot"></span><button class="link-button" id="authIn" type="button">Sign in with GitHub</button>`;
  el.authStrip.querySelector("#authIn").addEventListener("click", () => github.login(location.hash || "#/"));
}

function renderStats() {
  const entries = getAliasEntries();
  const artistIds = new Set(entries.map(([, artistId]) => artistId));
  el.artistCount.textContent = String(artistIds.size);
  el.aliasCount.textContent = String(entries.length);
}

// ─────────────────────────── search ───────────────────────────
function scheduleSearch() {
  clearTimeout(ui.searchTimer);
  ui.searchTimer = setTimeout(renderSearch, 150);
}

async function renderSearch() {
  const token = ++ui.searchToken;
  const artistQuery = normalizeKey(el.artistSearch.value);
  const trackQuery = normalizeKey(el.trackSearch.value);

  if (ui.loading) return setResults(resultMessage("Loading index"));
  if (ui.error) return setResults(resultMessage("Source unavailable"));
  if (getAliasEntries().length === 0) return setResults(resultMessage("No artists indexed yet"));
  if (!artistQuery && !trackQuery) return setResults(resultMessage("Search by artist or track"));

  // Track-only query → search every track by title (global index).
  if (!artistQuery && trackQuery) {
    setResults(resultMessage("Searching tracks"));
    const index = await getTrackIndex().catch(() => null);
    if (token !== ui.searchToken) return;
    if (!index) return setResults(resultMessage("Track search unavailable"));
    const hits = index
      .filter((entry) => normalizeKey(entry.track.title).includes(trackQuery))
      .sort((a, b) => compareStrings(a.track.title, b.track.title))
      .slice(0, 40);
    return setResults(hits.length ? hits.map(renderTrackResult).join("") : resultMessage("No matching tracks"));
  }

  // Artist query (optionally narrowed by track).
  const matches = collectArtistMatches(artistQuery).slice(0, 40);
  if (matches.length === 0) return setResults(resultMessage("No matching artists"));

  setResults(resultMessage("Loading results"));
  const rows = [];
  for (const match of matches) {
    const artist = await getArtistIndex(match.artistId).catch(() => null);
    if (token !== ui.searchToken) return;
    if (!artist) {
      rows.push(renderArtistResult({ id: match.artistId, canonical_name: match.artistId, tracks: [] }, match.aliases, []));
      continue;
    }
    const tracks = trackQuery
      ? artist.tracks.filter((track) => normalizeKey(track.title).includes(trackQuery))
      : artist.tracks;
    if (trackQuery && tracks.length === 0) continue;
    rows.push(renderArtistResult(artist, match.aliases, trackQuery ? tracks : [], !!trackQuery));
  }
  setResults(rows.length ? rows.join("") : resultMessage("No matching tracks"));
}

function setResults(html) {
  el.results.innerHTML = html;
}

function collectArtistMatches(query) {
  const matches = new Map();
  for (const [alias, artistId] of getAliasEntries()) {
    if (query && !alias.includes(query)) continue;
    const match = matches.get(artistId) ?? { artistId, aliases: [] };
    match.aliases.push(alias);
    matches.set(artistId, match);
  }
  return [...matches.values()].sort((a, b) => compareStrings(a.artistId, b.artistId));
}

async function getTrackIndex() {
  if (ui.trackIndex) return ui.trackIndex;
  if (!ui.trackIndexPromise) ui.trackIndexPromise = buildTrackIndex();
  return ui.trackIndexPromise;
}

async function buildTrackIndex() {
  const ids = [...new Set(getAliasEntries().map(([, artistId]) => artistId))];
  const out = [];
  await Promise.all(ids.map(async (artistId) => {
    const artist = await getArtistIndex(artistId).catch(() => null);
    if (!artist) return;
    for (const track of artist.tracks) {
      out.push({ artistId, canonicalName: artist.canonical_name, track });
    }
  }));
  ui.trackIndex = out;
  return out;
}

function renderArtistResult(artist, aliases, tracks, showTracks = false) {
  const aliasText = aliases.slice(0, 3).join(", ");
  const trackLabel = `${artist.tracks.length} ${artist.tracks.length === 1 ? "track" : "tracks"}`;
  const sublist = showTracks && tracks.length
    ? `<div class="result-tracks">${tracks.slice(0, 6).map((track) => `
        <a class="result-track" href="#/track/${encodeURIComponent(artist.id)}/${encodeURIComponent(track.id)}">
          <span>${escapeHtml(track.title)}</span><small>${formatDuration(track.length)}</small>
        </a>`).join("")}</div>`
    : "";
  return `
    <div class="result-group">
      <a class="result-row" href="#/artist/${encodeURIComponent(artist.id)}">
        <span class="title-line"><strong>${escapeHtml(artist.canonical_name)}</strong><small>${escapeHtml(trackLabel)}</small></span>
        <p>${escapeHtml(aliasText || artist.id)}</p>
      </a>
      ${sublist}
    </div>`;
}

function renderTrackResult(entry) {
  return `
    <a class="result-row track-result" href="#/track/${encodeURIComponent(entry.artistId)}/${encodeURIComponent(entry.track.id)}">
      <span class="title-line"><strong>${escapeHtml(entry.track.title)}</strong><small>${formatDuration(entry.track.length)}</small></span>
      <p>${escapeHtml(entry.canonicalName)}</p>
    </a>`;
}

// ─────────────────────────── routing ───────────────────────────
function parseRoute() {
  const hash = window.location.hash.replace(/^#\/?/u, "");
  const [name = "", a = "", b = ""] = hash.split("/").map(decodeURIComponent);
  if (name === "submit") return { name: "submit" };
  if (name === "edit" && a && b) return { name: "edit", artistId: a, trackId: b };
  if (name === "artist-edit" && a) return { name: "artist-edit", artistId: a };
  if (name === "artist" && a) return { name: "artist", artistId: a };
  if (name === "track" && a && b) return { name: "track", artistId: a, trackId: b };
  return { name: "home" };
}

async function renderRoute() {
  const route = parseRoute();
  // Only the full-screen track editor uses submit-mode; artist-edit is a normal
  // detail view (keeps the nav + search pane + page padding).
  const editorRoute = route.name === "submit" || route.name === "edit";
  const routeKey = editorRoute ? location.hash : null;
  document.body.classList.toggle("submit-mode", editorRoute);

  // Tear down a live editor when leaving an editor route.
  if (!editorRoute && (ui.editor || ui.mountedRoute)) {
    if (ui.editor) ui.editor.destroy();
    ui.editor = null;
    ui.mountedRoute = null;
  }

  // Already mounted for this exact editor route: never remount (would wipe work).
  if (editorRoute && ui.mountedRoute === routeKey) return;
  if (editorRoute) {
    // Switching between editor routes: tear down the previous controller first.
    if (ui.editor) {
      ui.editor.destroy();
      ui.editor = null;
    }
    ui.mountedRoute = routeKey;
  }

  if (route.name === "submit") return mountNewEditor();
  if (route.name === "edit") return mountEditEditor(route.artistId, route.trackId);

  if (ui.loading) return setDetail(stateBlock("Live source", "Loading XLRCDB", "Fetching the static index from GitHub Pages."));
  if (ui.error) return setDetail(stateBlock("Live source", "Source unavailable", ui.error.message || "The static data source could not be loaded.", "error-state"));

  if (route.name === "artist") return renderArtist(route.artistId);
  if (route.name === "artist-edit") return renderArtistEdit(route.artistId);
  if (route.name === "track") return renderTrack(route.artistId, route.trackId);
  renderHome();
}

function setDetail(html) {
  el.detailPane.innerHTML = html;
}

// ─────────────────────────── editor mounting ───────────────────────────
function mountNewEditor() {
  if (ui.editor) ui.editor.destroy();
  const initial = pendingEditorInitial || {};
  pendingEditorInitial = null;
  ui.editor = createEditor(el.detailPane, { mode: "new", initial, onSubmit: handleTrackSubmit });
  flushFlash();
}

async function mountEditEditor(artistId, trackId) {
  if (pendingEditorInitial && pendingEditorInitial.mode === "edit") {
    const initial = pendingEditorInitial;
    pendingEditorInitial = null;
    if (ui.editor) ui.editor.destroy();
    ui.editor = createEditor(el.detailPane, { mode: "edit", initial, onSubmit: handleTrackSubmit });
    flushFlash();
    return;
  }

  setDetail(stateBlock("Loading", "Loading track", "Fetching the XLRC file to edit."));
  try {
    const artist = await getArtistIndex(artistId);
    const track = artist.tracks.find((candidate) => candidate.id === trackId);
    if (!track) throw new Error("The track is not listed for this artist.");
    const source = await getTrackText(track.path);
    if (ui.editor) ui.editor.destroy();
    ui.editor = createEditor(el.detailPane, {
      mode: "edit",
      initial: { source, trackPath: track.path, trackId: track.id, artistId: artist.id },
      onSubmit: handleTrackSubmit
    });
    flushFlash();
  } catch (error) {
    setDetail(stateBlock("Unavailable", "Track unavailable", error.message, "error-state"));
  }
}

async function handleTrackSubmit(submission) {
  if (!submission || !ui.editor) return;
  const editor = ui.editor;

  if (!github.isConfigured()) {
    editor.setSubmitFeedback("idle", "Sign-in isn't configured yet. Use Export or Copy and open a PR manually via Guide.");
    return;
  }
  if (!github.isAuthed()) {
    editor.setSubmitFeedback("busy", "Redirecting to GitHub to sign in");
    github.login(location.hash, {
      route: location.hash,
      initial: {
        mode: submission.mode,
        source: submission.text,
        trackPath: submission.trackPath,
        trackId: submission.trackId,
        artistId: submission.artistId
      }
    });
    return;
  }

  try {
    editor.setSubmitFeedback("busy", "Starting");
    const { url } = await github.submitTrack(submission, (msg) => editor.setSubmitFeedback("busy", msg));
    editor.setSubmitFeedback("done", `Pull request opened: <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`);
    ui.trackIndex = null;
    ui.trackIndexPromise = null;
  } catch (error) {
    editor.setSubmitFeedback("idle", error.message || "Submission failed");
  }
}

function flushFlash() {
  if (!ui.flash) return;
  const editor = ui.editor;
  if (editor) editor.setSubmitFeedback("idle", ui.flash);
  ui.flash = null;
}

// ─────────────────────────── browse: home / artist / track ───────────────────────────
function renderHome() {
  const entries = getAliasEntries();
  if (entries.length === 0) {
    return setDetail(stateBlock("Database online", "No tracks indexed yet", `The static source is live at ${escapeHtml(DATA_SOURCE)}; new XLRC files appear here after they are normalized into the data repo.`));
  }
  const artists = new Set(entries.map(([, artistId]) => artistId)).size;
  setDetail(`
    <div class="empty-state">
      <p class="eyebrow">Browse</p>
      <h2>Search by artist or track</h2>
      <p>The index contains ${artists} ${artists === 1 ? "artist" : "artists"} and ${entries.length} searchable aliases. Search on the left, or <a class="inline-link" href="#/submit">submit a new track</a>.</p>
    </div>`);
}

async function renderArtist(artistId) {
  setDetail(stateBlock("Loading", "Loading artist", "Fetching static JSON from XLRCDB."));
  try {
    const artist = await getArtistIndex(artistId);
    const aliases = getAliasEntries().filter(([, id]) => id === artist.id).map(([alias]) => alias);
    setDetail(`
      <article>
        <div class="detail-header">
          <div>
            <p class="eyebrow">Artist</p>
            <h2>${escapeHtml(artist.canonical_name)}</h2>
          </div>
          <div class="detail-actions">
            <button class="link-button" id="addTrack" type="button">Add track</button>
            <a class="link-button" href="#/artist-edit/${encodeURIComponent(artist.id)}">Edit aliases</a>
            <a class="link-button" href="${escapeHtml(joinUrl(DATA_SOURCE, artistIndexPath(artist.id)))}" target="_blank" rel="noopener">JSON</a>
          </div>
        </div>
        <div class="meta-grid">
          <div class="metadata-row"><small>Artist ID</small><strong>${escapeHtml(artist.id)}</strong></div>
          <div class="metadata-row"><small>Tracks</small><strong>${artist.tracks.length}</strong></div>
          <div class="metadata-row"><small>Aliases</small><strong>${aliases.length}</strong></div>
        </div>
        <div class="alias-list">${aliases.map((alias) => `<span class="alias-chip">${escapeHtml(alias)}</span>`).join("")}</div>
        <div class="section-title"><h3>Tracks</h3></div>
        <div class="track-list">
          ${artist.tracks.length === 0 ? resultMessage("No tracks indexed for this artist") : artist.tracks.map((track) => renderTrackRow(artist.id, track)).join("")}
        </div>
      </article>`);
    document.getElementById("addTrack").addEventListener("click", () => {
      pendingEditorInitial = { artist: artist.canonical_name };
      location.hash = "#/submit";
    });
  } catch (error) {
    setDetail(stateBlock("Unavailable", "Artist unavailable", error.message, "error-state"));
  }
}

function renderTrackRow(artistId, track) {
  return `
    <a class="track-row" href="#/track/${encodeURIComponent(artistId)}/${encodeURIComponent(track.id)}">
      <strong>${escapeHtml(track.title)}</strong>
      <span>${formatDuration(track.length)}</span>
      <code>${escapeHtml(track.id)}</code>
    </a>`;
}

async function renderTrack(artistId, trackId) {
  setDetail(stateBlock("Loading", "Loading track", "Fetching static JSON from XLRCDB."));
  try {
    const artist = await getArtistIndex(artistId);
    const track = artist.tracks.find((candidate) => candidate.id === trackId);
    if (!track) throw new Error("The track is not listed for this artist.");
    const text = await getTrackText(track.path);
    const parsed = parseXLRC(text);

    setDetail(`
      <article>
        <div class="detail-header">
          <div>
            <p class="eyebrow">Track</p>
            <h2>${escapeHtml(track.title)}</h2>
          </div>
          <div class="detail-actions">
            <a class="link-button" href="#/artist/${encodeURIComponent(artist.id)}">Artist</a>
            <a class="link-button primary" href="#/edit/${encodeURIComponent(artist.id)}/${encodeURIComponent(track.id)}">Edit</a>
            <a class="link-button" href="${escapeHtml(joinUrl(DATA_SOURCE, track.path))}" target="_blank" rel="noopener">XLRC</a>
          </div>
        </div>
        <div class="meta-grid">
          <div class="metadata-row"><small>Artist</small><strong>${escapeHtml(artist.canonical_name)}</strong></div>
          <div class="metadata-row"><small>Length</small><strong>${formatDuration(track.length)}</strong></div>
          <div class="metadata-row"><small>Track ID</small><strong>${escapeHtml(track.id)}</strong></div>
        </div>
        <div class="section-title"><h3>Lyrics</h3></div>
        <div class="lyric-list" id="trackLyrics"></div>
        <div class="section-title"><h3>Raw XLRC</h3></div>
        <pre class="raw-block">${escapeHtml(text)}</pre>
      </article>`);
    renderLyrics(document.getElementById("trackLyrics"), parsed, "", { showAll: true });
  } catch (error) {
    setDetail(stateBlock("Unavailable", "Track unavailable", error.message, "error-state"));
  }
}

// ─────────────────────────── artist record (alias) editor ───────────────────────────
async function renderArtistEdit(artistId) {
  setDetail(stateBlock("Loading", "Loading artist record", "Fetching the artist .toml from XLRCDB."));
  try {
    const artist = await getArtistIndex(artistId);
    const tomlPath = artistRecordPath(artist.id);
    const tomlText = await fetchText(joinUrl(DATA_SOURCE, tomlPath));
    const record = parseArtistToml(tomlText);

    setDetail(`
      <article class="artist-edit">
        <div class="detail-header">
          <div>
            <p class="eyebrow">Edit artist</p>
            <h2>${escapeHtml(artist.canonical_name)}</h2>
          </div>
          <div class="detail-actions">
            <a class="link-button" href="#/artist/${encodeURIComponent(artist.id)}">Cancel</a>
          </div>
        </div>
        <div class="form-grid">
          <label class="field"><span>Canonical name (latin)</span><input id="aeLatin" type="text" value="${escapeHtml(record.canonical_name_latin || "")}" placeholder="optional"></label>
          <label class="field"><span>Pronunciation</span><input id="aePron" type="text" value="${escapeHtml(record.pronunciation || "")}" placeholder="optional"></label>
          <label class="field field-wide"><span>Aliases (one per line)</span><textarea id="aeAliases" rows="6" spellcheck="false">${escapeHtml((record.aliases || []).join("\n"))}</textarea></label>
        </div>
        <div class="form-actions">
          <span class="muted" id="aeStatus"></span>
          <button class="link-button primary" id="aeSubmit" type="button">${github.isAuthed() ? "Open PR" : "Sign in & open PR"}</button>
        </div>
      </article>`);

    document.getElementById("aeSubmit").addEventListener("click", () => submitArtistEdit(artist, record));
  } catch (error) {
    setDetail(stateBlock("Unavailable", "Artist record unavailable", error.message, "error-state"));
  }
}

async function submitArtistEdit(artist, record) {
  const status = document.getElementById("aeStatus");
  const latin = document.getElementById("aeLatin").value.trim();
  const pronunciation = document.getElementById("aePron").value.trim();
  const aliases = document.getElementById("aeAliases").value.split("\n").map((s) => s.trim()).filter(Boolean);
  const text = serializeArtistToml({ ...record, id: artist.id, canonical_name: artist.canonical_name, canonical_name_latin: latin, pronunciation, aliases });
  const edit = { path: artistRecordPath(artist.id), text, artistId: artist.id, canonicalName: artist.canonical_name };

  if (!github.isConfigured()) {
    status.textContent = "Sign-in isn't configured yet.";
    return;
  }
  if (!github.isAuthed()) {
    github.login(location.hash);
    return;
  }
  try {
    status.textContent = "Working";
    const { url } = await github.submitArtist(edit, (msg) => { status.textContent = msg; });
    status.innerHTML = `PR opened: <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`;
  } catch (error) {
    status.textContent = error.message || "Submission failed";
  }
}

function artistRecordPath(artistId) {
  const body = artistId.startsWith("art_") ? artistId.slice(4) : artistId;
  return `artists/${body.slice(0, 2)}/${body.slice(2, 4)}/${artistId}.toml`;
}

// Minimal TOML for the fixed artist schema (string scalars + a string array).
function parseArtistToml(text) {
  const record = { aliases: [] };
  const lines = text.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const scalar = line.match(/^([A-Za-z_]+)\s*=\s*"(.*)"$/u);
    if (scalar) {
      record[scalar[1]] = scalar[2];
      continue;
    }
    if (/^aliases\s*=\s*\[/u.test(line)) {
      const collected = [];
      let block = line.slice(line.indexOf("[") + 1);
      while (!block.includes("]") && i + 1 < lines.length) {
        block += lines[++i];
      }
      block = block.slice(0, block.indexOf("]"));
      for (const m of block.matchAll(/"((?:[^"\\]|\\.)*)"/gu)) {
        collected.push(m[1].replace(/\\"/gu, '"'));
      }
      record.aliases = collected;
    }
  }
  return record;
}

function serializeArtistToml(record) {
  const esc = (v) => String(v).replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
  const lines = [`id = "${esc(record.id)}"`, `canonical_name = "${esc(record.canonical_name)}"`];
  if (record.canonical_name_latin) lines.push(`canonical_name_latin = "${esc(record.canonical_name_latin)}"`);
  if (record.pronunciation) lines.push(`pronunciation = "${esc(record.pronunciation)}"`);
  const aliases = record.aliases.length ? record.aliases : [record.canonical_name];
  lines.push("aliases = [");
  for (const alias of aliases) lines.push(`  "${esc(alias)}",`);
  lines.push("]");
  return `${lines.join("\n")}\n`;
}

// ─────────────────────────── small helpers ───────────────────────────
function setStatus(kind, text) {
  el.statusDot.className = `status-dot ${kind === "online" ? "online" : kind === "error" ? "error" : ""}`;
  el.sourceStatus.textContent = text;
}

function stateBlock(eyebrow, title, body, cls = "loading-state") {
  return `
    <div class="${cls}">
      <p class="eyebrow">${escapeHtml(eyebrow)}</p>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(body)}</p>
    </div>`;
}

function resultMessage(text) {
  return `<div class="metadata-row"><strong>${escapeHtml(text)}</strong></div>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

export { DATA_REPO_URL };
