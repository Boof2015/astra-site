// xlrcdb SPA entry point: routing, the typeahead search, browse pages (home / artist /
// track), and the glue that mounts the editor and drives the GitHub contribution flow.
// Data access lives in data.js, matching in search.js, the editor and PR mechanics in
// editor.js / github.js.

import { parseXLRC } from "../xlrc/assets/xlrc.js";
import {
  DATA_SOURCE,
  DATA_REPO_URL,
  loadAliases,
  getAliasEntries,
  getArtistIndex,
  getDirectory,
  getTrackText,
  clearCaches,
  artistIndexPath,
  joinUrl,
  formatDuration,
  fetchText
} from "./data.js";
import { buildHighlight, detectedLangs, renderLyrics } from "./render.js";
import { buildSearchIndex, highlightRanges, search } from "./search.js";
import { languageName } from "./languages.js";
import { createEditor } from "./editor.js";
import { createGitHub } from "./github.js";

const github = createGitHub();

// Temporary: preview the submit flow without opening a real pull request. On for local
// development (localhost / 127.0.0.1) or with ?simulate in the URL; ?simulate=0 forces a
// real submission. The live site always submits for real.
const SIMULATE_SUBMIT = (() => {
  const params = new URLSearchParams(location.search);
  if (params.has("simulate")) return params.get("simulate") !== "0";
  return location.hostname === "localhost" || location.hostname === "127.0.0.1";
})();

function submitContext() {
  return {
    simulate: SIMULATE_SUBMIT,
    configured: github.isConfigured(),
    authed: github.isAuthed(),
    login: ui.user?.login || ""
  };
}

const PHONE = matchMedia("(max-width: 620px)");
// Narrower than this, the editor gets a "use a bigger screen" note first (tablets in landscape
// and up go straight in).
const EDITOR_MIN = matchMedia("(max-width: 760px)");
const BIG_SCREEN_OK_KEY = "xlrcdb-small-screen-ok";

const ui = {
  loading: true,
  error: null,
  searchTimer: 0,
  searchIndex: null,
  directory: null,
  editor: null,
  mountedRoute: null,
  user: null,
  flash: null
};

// Carries an initial editor state across a navigation (prefill / OAuth restore).
let pendingEditorInitial = null;

const el = {};

document.addEventListener("DOMContentLoaded", async () => {
  el.search = document.getElementById("search");
  el.searchPane = document.querySelector(".search-pane");
  el.results = document.getElementById("results");
  el.detailPane = document.getElementById("detailPane");
  el.refreshButton = document.getElementById("refreshButton");
  el.searchForm = document.getElementById("searchForm");
  el.authStrip = document.getElementById("authStrip");
  el.sourceError = document.getElementById("sourceError");
  el.sourceNote = document.getElementById("sourceNote");

  el.searchForm.addEventListener("submit", (e) => e.preventDefault());
  el.search.addEventListener("input", scheduleSearch);
  el.search.addEventListener("keydown", onSearchKeydown);
  el.results.addEventListener("click", onResultsClick);
  document.addEventListener("keydown", onGlobalKeydown);
  el.refreshButton.addEventListener("click", () => refresh());
  window.addEventListener("hashchange", () => {
    // On phones the results float over the page; picking one should close them.
    if (PHONE.matches && document.activeElement && el.searchPane.contains(document.activeElement)) document.activeElement.blur();
    renderRoute();
  });

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
  ui.searchIndex = null;
  ui.directory = null;
  clearCaches();

  setStatus("loading");
  renderSearch();
  renderRoute();

  try {
    await loadAliases();
    ui.loading = false;
    setStatus("online");
  } catch (error) {
    ui.loading = false;
    ui.error = error;
    setStatus("error", error);
  }

  renderSearch();
  renderRoute();
  if (!ui.error) loadDirectory();
}

// Artists and tracks for search and browsing; the search re-runs once it arrives.
async function loadDirectory() {
  try {
    ui.directory = await getDirectory();
    ui.searchIndex = buildSearchIndex(ui.directory);
  } catch (_) {
    ui.directory = null;
  }
  renderSearch();
  if (["home", "artists"].includes(parseRoute().name)) renderRoute();
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

// ─────────────────────────── search ───────────────────────────
function scheduleSearch() {
  clearTimeout(ui.searchTimer);
  ui.searchTimer = setTimeout(renderSearch, 80);
}

function renderSearch() {
  const query = el.search.value.trim();
  el.searchPane.classList.toggle("has-query", Boolean(query));
  if (ui.loading) return setResults(resultMessage("Loading the index…"));
  if (ui.error) return setResults(resultMessage("The database couldn't be reached."));
  if (getAliasEntries().length === 0) return setResults(resultMessage("No artists indexed yet."));
  if (!query) return setResults(searchHint());
  if (!ui.searchIndex) return setResults(resultMessage("Loading artists and songs…"));

  const { artists, tracks } = search(ui.searchIndex, query);
  if (!artists.length && !tracks.length) {
    return setResults(`
      <div class="result-empty">
        <p>Nothing matches <strong>${escapeHtml(query)}</strong>.</p>
        <a class="link-button" href="#/submit" data-result>Add it to xlrcdb</a>
      </div>`);
  }
  const groups = [];
  if (artists.length) {
    groups.push(`<p class="result-label">Artists</p>${artists.map(({ artist, alias }) => `
      <a class="result-row" href="#/artist/${encodeURIComponent(artist.id)}" data-result>
        <span class="title-line"><strong>${highlightHtml(artist.name, query)}</strong><small>${artist.trackCount} ${artist.trackCount === 1 ? "track" : "tracks"}</small></span>
        ${alias ? `<p>Also known as ${highlightHtml(alias, query)}</p>` : ""}
      </a>`).join("")}`);
  }
  if (tracks.length) {
    groups.push(`<p class="result-label">Songs</p>${tracks.map(({ track }) => `
      <a class="result-row" href="#/track/${encodeURIComponent(track.artistId)}/${encodeURIComponent(track.id)}" data-result>
        <span class="title-line"><strong>${highlightHtml(track.title, query)}</strong><small>${formatDuration(track.length)}</small></span>
        <p>${highlightHtml(track.artistName, query)}</p>
      </a>`).join("")}`);
  }
  setResults(groups.join(""));
  setActiveResult(0);
}

function searchHint() {
  return `
    <div class="search-hint">
      <p>Type an artist, a song, or both, like <button class="hint-chip" type="button" data-example="kda firestarter">kda firestarter</button>. Typos and missing punctuation are fine.</p>
      <p class="muted">Press <kbd>/</kbd> anywhere to search.</p>
    </div>`;
}

function setResults(html) {
  el.results.innerHTML = html;
}

function resultRows() {
  return [...el.results.querySelectorAll("[data-result]")];
}

function setActiveResult(index) {
  const rows = resultRows();
  rows.forEach((row, i) => row.classList.toggle("active", i === index));
  ui.activeResult = rows.length ? Math.max(0, Math.min(index, rows.length - 1)) : -1;
  rows[ui.activeResult]?.scrollIntoView({ block: "nearest" });
}

function onSearchKeydown(e) {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    setActiveResult((ui.activeResult ?? -1) + (e.key === "ArrowDown" ? 1 : -1));
  } else if (e.key === "Enter") {
    const row = resultRows()[ui.activeResult ?? 0];
    if (row) {
      e.preventDefault();
      location.hash = row.getAttribute("href");
    }
  } else if (e.key === "Escape") {
    el.search.value = "";
    renderSearch();
  }
}

function onResultsClick(e) {
  const example = e.target.closest("[data-example]");
  if (example) {
    el.search.value = example.dataset.example;
    el.search.focus();
    renderSearch();
  }
}

// "/" or Cmd/Ctrl+K focuses the search from anywhere outside a text field.
function onGlobalKeydown(e) {
  if (document.body.classList.contains("submit-mode")) return;
  const typing = e.target.closest?.("input, textarea, select, [contenteditable]");
  if ((e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) {
    e.preventDefault();
    el.search.focus();
    el.search.select();
  }
}

// Escaped text with the query's matches wrapped in <mark>.
function highlightHtml(text, query) {
  const ranges = highlightRanges(text, query);
  if (!ranges.length) return escapeHtml(text);
  let out = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    out += `${escapeHtml(text.slice(cursor, start))}<mark>${escapeHtml(text.slice(start, end))}</mark>`;
    cursor = end;
  }
  return out + escapeHtml(text.slice(cursor));
}

// ─────────────────────────── routing ───────────────────────────
function parseRoute() {
  const hash = window.location.hash.replace(/^#\/?/u, "");
  const [name = "", a = "", b = ""] = hash.split("/").map(decodeURIComponent);
  if (name === "submit") return { name: "submit" };
  if (name === "editor") return { name: "editor" };
  if (name === "edit" && a && b) return { name: "edit", artistId: a, trackId: b };
  if (name === "artist-edit" && a) return { name: "artist-edit", artistId: a };
  if (name === "artist" && a) return { name: "artist", artistId: a };
  if (name === "artists") return { name: "artists" };
  if (name === "track" && a && b) return { name: "track", artistId: a, trackId: b };
  return { name: "home" };
}

async function renderRoute() {
  const route = parseRoute();
  // Only the full-screen track editor uses submit-mode; artist-edit is a normal
  // detail view (keeps the nav + search pane + page padding).
  const editorRoute = route.name === "submit" || route.name === "edit" || route.name === "editor";
  const routeKey = editorRoute ? location.hash : null;
  document.body.classList.toggle("submit-mode", editorRoute);

  // Tear down a live editor when leaving an editor route.
  if (!editorRoute && (ui.editor || ui.mountedRoute)) {
    if (ui.editor) ui.editor.destroy();
    ui.editor = null;
    ui.mountedRoute = null;
  }

  if (editorRoute && needsBigScreenNote()) {
    if (ui.editor) ui.editor.destroy();
    ui.editor = null;
    ui.mountedRoute = null;
    return renderBigScreenNote();
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
  if (route.name === "editor") return mountOfflineEditor();
  if (route.name === "edit") return mountEditEditor(route.artistId, route.trackId);

  if (ui.loading) return setDetail(stateBlock("Live source", "Loading XLRCDB", "Fetching the static index from GitHub Pages."));
  if (ui.error) return setDetail(stateBlock("Live source", "Source unavailable", ui.error.message || "The static data source could not be loaded.", "error-state"));

  if (route.name === "artist") return renderArtist(route.artistId);
  if (route.name === "artists") return renderArtistIndex();
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
  ui.editor = mountEditor({
    mode: "new",
    initial,
    onSubmit: handleTrackSubmit,
    getSubmitContext: submitContext,
    // "Submit as an edit" on a duplicate: carry the text into the existing track's editor.
    onOpenAsEdit: (editInitial) => {
      pendingEditorInitial = editInitial;
      location.hash = `#/edit/${encodeURIComponent(editInitial.artistId)}/${encodeURIComponent(editInitial.trackId)}`;
    }
  });
  flushFlash();
}

// The standalone editor (/xlrc/editor/ redirects here): no submitting, no database. "Submit to
// xlrcdb" carries the file over to the submit editor, where the stricter checks apply.
function mountOfflineEditor() {
  if (ui.editor) ui.editor.destroy();
  ui.editor = mountEditor({
    mode: "new",
    offline: true,
    initial: {},
    onOpenInSubmit: (text) => {
      pendingEditorInitial = { source: text };
      location.hash = "#/submit";
    }
  });
}

async function mountEditEditor(artistId, trackId) {
  if (pendingEditorInitial && pendingEditorInitial.mode === "edit") {
    const initial = pendingEditorInitial;
    pendingEditorInitial = null;
    if (ui.editor) ui.editor.destroy();
    ui.editor = mountEditor({ mode: "edit", initial, onSubmit: handleTrackSubmit, getSubmitContext: submitContext });
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
    ui.editor = mountEditor({
      mode: "edit",
      initial: { source, original: source, trackPath: track.path, trackId: track.id, artistId: artist.id },
      onSubmit: handleTrackSubmit,
      getSubmitContext: submitContext
    });
    flushFlash();
  } catch (error) {
    setDetail(stateBlock("Unavailable", "Track unavailable", error.message, "error-state"));
  }
}

// ─────────────────────────── small screens ───────────────────────────
// Timing lyrics needs a keyboard, the waveform and room for the text, so on phones the editor
// starts with a note instead. "Continue anyway" is remembered for the rest of the visit.
function needsBigScreenNote() {
  if (!EDITOR_MIN.matches) return false;
  try {
    return sessionStorage.getItem(BIG_SCREEN_OK_KEY) !== "1";
  } catch {
    return true;
  }
}

function renderBigScreenNote() {
  setDetail(`
    <div class="big-screen-note">
      <div>
        <p class="eyebrow">Editor</p>
        <h2>The editor needs a bigger screen</h2>
        <p>Timing lyrics takes a keyboard, the waveform and room for the text. Open this page on a computer or a tablet in landscape.</p>
        <div class="note-actions">
          <a class="link-button primary" href="#/">Back to browsing</a>
          <button class="link-button" type="button" data-note="copy">Copy link</button>
        </div>
        <button class="text-button" type="button" data-note="continue">Continue anyway</button>
      </div>
    </div>`);
  el.detailPane.querySelector('[data-note="copy"]').addEventListener("click", (e) => copyText(location.href, e.currentTarget));
  el.detailPane.querySelector('[data-note="continue"]').addEventListener("click", () => {
    try {
      sessionStorage.setItem(BIG_SCREEN_OK_KEY, "1");
    } catch {}
    renderRoute();
  });
}

// A throw while mounting usually means the browser mixed cached old modules with new ones
// after an update (see the recovery script in index.html): refresh them and reload once.
// Anything that survives that is shown, not swallowed into a blank editor.
function mountEditor(options) {
  try {
    const editor = createEditor(el.detailPane, options);
    window.xlrcdbStarted?.();
    return editor;
  } catch (error) {
    console.error(error);
    if (window.xlrcdbRecover?.()) {
      setDetail(stateBlock("Updating", "Loading the latest editor", "Refreshing files your browser had cached from an older version."));
    } else {
      setDetail(stateBlock(
        "Editor error",
        "The editor couldn't start",
        `${error.message || error}. Try a hard refresh (Cmd+Shift+R, or Ctrl+Shift+R on Windows and Linux).`,
        "error-state"
      ));
    }
    return null;
  }
}

async function handleTrackSubmit(submission) {
  if (!submission || !ui.editor) return;
  const editor = ui.editor;

  if (SIMULATE_SUBMIT) {
    await simulateSubmit(submission, editor);
    return;
  }

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
    const { url, number } = await github.submitTrack(submission, (msg, info) => editor.setSubmitFeedback("busy", msg, info));
    editor.setSubmitFeedback("done", `Pull request opened: <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`, { url, number });
  } catch (error) {
    editor.setSubmitFeedback("idle", error.message || "Submission failed");
  }
}

// Plays back the same progress steps (and kinds of detail) github.js reports, then a
// simulated success.
async function simulateSubmit(submission, editor) {
  const login = ui.user?.login || "you";
  const title = `${submission.mode === "edit" ? "Edit" : "Add"}: ${submission.artist} - ${submission.title}`;
  const path = submission.mode === "edit" && submission.trackPath ? submission.trackPath : `incoming/${crypto.randomUUID()}.xlrc`;
  const steps = [
    ["Checking your GitHub account", "account", `@${login}`],
    ["Preparing your copy of xlrcdb", "fork", `${login}/xlrcdb`],
    ["Creating a branch for this change", "branch", `xlrcdb-${submission.mode}-${Date.now().toString(36)}`],
    ["Uploading the lyrics", "commit", path],
    ["Opening the pull request", "pr", title]
  ];
  for (const [text, step, detail] of steps) {
    editor.setSubmitFeedback("busy", text, { step, detail });
    await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 400));
  }
  editor.setSubmitFeedback("busy", "Pull request opened", { step: "pr", detail: `#0 · ${title} (simulated)` });
  editor.setSubmitFeedback("done", "Simulated submission finished. No pull request was opened.", { simulated: true });
}

function flushFlash() {
  if (!ui.flash) return;
  const editor = ui.editor;
  if (editor) editor.setSubmitFeedback("idle", ui.flash);
  ui.flash = null;
}

// ─────────────────────────── browse: home / artist / track ───────────────────────────
// Home: the search does the finding, so this stays small: actions, the newest tracks (when the
// data repo's catalog has added dates), and a way into the full artist list.
function renderHome() {
  if (getAliasEntries().length === 0) {
    return setDetail(stateBlock("Database online", "No tracks indexed yet", "New XLRC files appear here once they're merged into the data repo."));
  }
  const artistCount = ui.directory?.artists.length;
  const recent = (ui.directory?.tracks ?? [])
    .filter((track) => track.added)
    .sort((a, b) => b.added.localeCompare(a.added))
    .slice(0, 8);
  const recentHtml = recent.length ? `
      <section class="recent">
        <div class="section-title"><h3>Recently added</h3></div>
        <div class="recent-list">
          ${recent.map((track) => `
            <a class="recent-row" href="#/track/${encodeURIComponent(track.artistId)}/${encodeURIComponent(track.id)}">
              <strong>${escapeHtml(track.title)}</strong>
              <span class="recent-artist">${escapeHtml(track.artistName)}</span>
              <span class="recent-meta">${formatDuration(track.length)}</span>
              <time datetime="${escapeHtml(track.added)}" title="${escapeHtml(new Date(track.added).toLocaleString())}">${escapeHtml(relativeDate(track.added))}</time>
            </a>`).join("")}
        </div>
      </section>` : "";
  setDetail(`
    <article class="home">
      <header class="home-head">
        <p class="eyebrow">Browse</p>
        <h2>Synced lyrics, made by the community</h2>
        <div class="home-actions">
          <a class="link-button primary" href="#/submit">Add lyrics</a>
          <button class="link-button" id="randomTrack" type="button"${ui.directory?.tracks.length ? "" : " disabled"}>Random track</button>
        </div>
      </header>
      ${recentHtml}
      <a class="browse-link" href="#/artists">Browse all artists${artistCount ? ` <small>${artistCount}</small>` : ""} <span aria-hidden="true">→</span></a>
    </article>`);
  document.getElementById("randomTrack")?.addEventListener("click", () => {
    const tracks = ui.directory?.tracks ?? [];
    const pick = tracks[Math.floor(Math.random() * tracks.length)];
    if (pick) location.hash = `#/track/${encodeURIComponent(pick.artistId)}/${encodeURIComponent(pick.id)}`;
  });
}

// "today", "yesterday", "3 days ago", "2 weeks ago", then a date.
function relativeDate(iso) {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} ${Math.floor(days / 7) === 1 ? "week" : "weeks"} ago`;
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Every artist as a dense A-Z index: letter, then the names on one wrapping line.
function renderArtistIndex() {
  const artists = ui.directory?.artists;
  if (!artists) return setDetail(stateBlock("Loading", "Loading artists", "Fetching the artist list from xlrcdb."));
  const groups = new Map();
  for (const artist of artists) {
    const first = artist.name.normalize("NFKD")[0]?.toUpperCase() ?? "#";
    const letter = /[A-Z]/u.test(first) ? first : "#";
    if (!groups.has(letter)) groups.set(letter, []);
    groups.get(letter).push(artist);
  }
  const letters = [...groups.keys()].sort((a, b) => (a === "#") - (b === "#") || a.localeCompare(b));
  setDetail(`
    <article class="artist-index">
      <div class="detail-header">
        <div>
          <p class="eyebrow">Browse</p>
          <h2>All artists</h2>
          <p class="detail-sub">${artists.length} ${artists.length === 1 ? "artist" : "artists"}</p>
        </div>
      </div>
      <dl class="az">
        ${letters.map((letter) => `
          <dt>${letter}</dt>
          <dd>${groups.get(letter).map((artist) => `<a href="#/artist/${encodeURIComponent(artist.id)}">${escapeHtml(artist.name)}</a>`).join('<span class="az-sep">·</span>')}</dd>`).join("")}
      </dl>
    </article>`);
}

async function renderArtist(artistId) {
  setDetail(stateBlock("Loading", "Loading artist", "Fetching the artist from xlrcdb."));
  try {
    const artist = await getArtistIndex(artistId);
    const lowerAliases = getAliasEntries().filter(([, id]) => id === artist.id).map(([alias]) => alias);
    setDetail(`
      <article class="artist-page">
        <div class="detail-header">
          <div>
            <p class="eyebrow">Artist</p>
            <h2>${escapeHtml(artist.canonical_name)}</h2>
            <p class="detail-sub" id="artistAka">${akaHtml(artist.canonical_name, lowerAliases)}</p>
          </div>
          <div class="detail-actions">
            <button class="link-button primary" id="addTrack" type="button">Add a track</button>
            <a class="link-button" href="#/artist-edit/${encodeURIComponent(artist.id)}">Edit artist</a>
          </div>
        </div>
        <div class="section-title"><h3>Tracks</h3></div>
        <div class="track-list">
          ${artist.tracks.length === 0 ? resultMessage("No tracks for this artist yet.") : artist.tracks.map((track) => renderTrackRow(artist.id, track)).join("")}
        </div>
        <footer class="dev-row">
          <span>Artist ID <code>${escapeHtml(artist.id)}</code></span>
          <button class="text-button" type="button" data-copy="${escapeHtml(artist.id)}">Copy ID</button>
          <a class="text-button" href="${escapeHtml(joinUrl(DATA_SOURCE, artistIndexPath(artist.id)))}" target="_blank" rel="noopener">Index JSON</a>
        </footer>
      </article>`);
    wireCopyButtons();
    document.getElementById("addTrack").addEventListener("click", () => {
      pendingEditorInitial = { artist: artist.canonical_name };
      location.hash = "#/submit";
    });
    // The artist's record has the aliases in their real casing (and a Latin name).
    fetchText(joinUrl(DATA_SOURCE, artistRecordPath(artist.id)))
      .then((toml) => {
        const record = parseArtistToml(toml);
        const node = document.getElementById("artistAka");
        if (node) node.innerHTML = akaHtml(artist.canonical_name, record.aliases || lowerAliases, record.canonical_name_latin);
      })
      .catch(() => {});
  } catch (error) {
    setDetail(stateBlock("Unavailable", "Artist unavailable", error.message, "error-state"));
  }
}

function akaHtml(name, aliases, latin = "") {
  const seen = new Set([name.toLowerCase()]);
  const others = [];
  for (const alias of [latin, ...aliases]) {
    if (!alias || seen.has(alias.toLowerCase())) continue;
    seen.add(alias.toLowerCase());
    others.push(alias);
  }
  return others.length ? `Also known as ${others.map((alias) => `<span class="alias-chip">${escapeHtml(alias)}</span>`).join(" ")}` : "";
}

function renderTrackRow(artistId, track) {
  return `
    <a class="track-row" href="#/track/${encodeURIComponent(artistId)}/${encodeURIComponent(track.id)}">
      <strong>${escapeHtml(track.title)}</strong>
      <span>${formatDuration(track.length)}</span>
    </a>`;
}

async function renderTrack(artistId, trackId) {
  setDetail(stateBlock("Loading", "Loading track", "Fetching the lyrics from xlrcdb."));
  try {
    const artist = await getArtistIndex(artistId);
    const track = artist.tracks.find((candidate) => candidate.id === trackId);
    if (!track) throw new Error("The track is not listed for this artist.");
    const text = await getTrackText(track.path);
    const parsed = parseXLRC(text);
    const rawUrl = joinUrl(DATA_SOURCE, track.path);
    const langs = [...new Set([parsed.meta.lang, ...(parsed.meta.langs || [])].filter(Boolean))];
    const translationLangs = detectedLangs(parsed).filter((tag) => tag !== parsed.meta.lang);
    const hasFurigana = parsed.lines.some((line) => line.furigana.length > 0);
    const lineCount = text.split(/\r?\n/u).length;
    const lookup = `import { lookup } from "@boof2015/xlrc";

const result = await lookup({
  artist: ${JSON.stringify(artist.canonical_name)},
  title: ${JSON.stringify(track.title)},
  length: ${track.length},
  source: "${DATA_SOURCE}/"
});`;
    const issueUrl = `${DATA_REPO_URL}/issues/new?${new URLSearchParams({
      title: `Problem with ${artist.canonical_name} - ${track.title}`,
      body: `Track: ${artist.canonical_name} - ${track.title}\nFile: ${track.path}\nPage: ${location.href}\n\nWhat's wrong:\n`
    })}`;

    setDetail(`
      <article class="track-page">
        <div class="detail-header">
          <div>
            <p class="eyebrow">Track</p>
            <h2>${escapeHtml(track.title)}</h2>
            <p class="detail-sub">
              <a class="inline-link" href="#/artist/${encodeURIComponent(artist.id)}">${escapeHtml(artist.canonical_name)}</a>
              · ${formatDuration(track.length)}
              ${langs.length ? `· ${langs.map((tag) => escapeHtml(languageName(tag) || tag)).join(", ")}` : ""}
            </p>
          </div>
          <div class="detail-actions">
            <a class="link-button primary" href="#/edit/${encodeURIComponent(artist.id)}/${encodeURIComponent(track.id)}">Edit</a>
            <button class="link-button" type="button" data-copy-raw>Copy file</button>
            <button class="link-button" type="button" data-download-raw>Download</button>
          </div>
        </div>

        ${translationLangs.length || hasFurigana ? `
          <div class="lyrics-tools">
            ${translationLangs.length ? `
              <select id="trackTranslations" aria-label="Translations">
                <option value="">All translations</option>
                <option value="none">No translations</option>
                ${translationLangs.map((tag) => `<option value="${escapeHtml(tag)}">${escapeHtml(languageName(tag) || tag)} only</option>`).join("")}
              </select>` : ""}
            ${hasFurigana ? '<label class="toggle"><input type="checkbox" id="trackFurigana" checked> Furigana</label>' : ""}
          </div>` : ""}
        <div class="lyric-list" id="trackLyrics"></div>

        <details class="raw-file">
          <summary>
            <span>Raw <code>.xlrc</code> file <small>${lineCount} lines</small></span>
            <span class="raw-actions">
              <button class="text-button" type="button" data-copy-raw>Copy</button>
              <button class="text-button" type="button" data-download-raw>Download</button>
              <a class="text-button" href="${escapeHtml(rawUrl)}" target="_blank" rel="noopener">Open</a>
            </span>
          </summary>
          <pre class="raw-block" id="trackRaw"></pre>
        </details>

        <details class="raw-file">
          <summary><span>Use it in your app</span></summary>
          <div class="dev-body">
            <p class="muted">Look the track up by artist, title and length with the <a class="inline-link" href="https://www.npmjs.com/package/@boof2015/xlrc" target="_blank" rel="noopener">@boof2015/xlrc</a> client.</p>
            <pre class="code-block"><code>${escapeHtml(lookup)}</code></pre>
            <div class="dev-row">
              <button class="text-button" type="button" data-copy="${escapeHtml(lookup)}">Copy snippet</button>
              <span>Track ID <code>${escapeHtml(track.id)}</code></span>
              <button class="text-button" type="button" data-copy="${escapeHtml(track.id)}">Copy ID</button>
            </div>
          </div>
        </details>

        <p class="report-row">Something wrong? <a class="inline-link" href="#/edit/${encodeURIComponent(artist.id)}/${encodeURIComponent(track.id)}">Fix it in the editor</a> or <a class="inline-link" href="${escapeHtml(issueUrl)}" target="_blank" rel="noopener">report it</a>.</p>
      </article>`);

    const lyricsEl = document.getElementById("trackLyrics");
    const paint = (filter = "") => renderLyrics(lyricsEl, parsed, filter === "none" ? "\u0000" : filter, { showAll: !filter });
    paint();
    document.getElementById("trackTranslations")?.addEventListener("change", (e) => paint(e.target.value));
    document.getElementById("trackFurigana")?.addEventListener("change", (e) => lyricsEl.classList.toggle("hide-furigana", !e.target.checked));
    buildHighlight(document.getElementById("trackRaw"), text.replace(/\n$/u, ""), new Set());

    const filename = `${slugify(artist.canonical_name)}-${slugify(track.title)}.xlrc`;
    for (const button of el.detailPane.querySelectorAll("[data-copy-raw]")) {
      button.addEventListener("click", (e) => {
        e.preventDefault(); // inside <summary>: don't toggle the details
        copyText(text, button);
      });
    }
    for (const button of el.detailPane.querySelectorAll("[data-download-raw]")) {
      button.addEventListener("click", (e) => {
        e.preventDefault();
        downloadText(filename, text);
      });
    }
    wireCopyButtons();
  } catch (error) {
    setDetail(stateBlock("Unavailable", "Track unavailable", error.message, "error-state"));
  }
}

function wireCopyButtons() {
  for (const button of el.detailPane.querySelectorAll("[data-copy]")) {
    button.addEventListener("click", (e) => {
      e.preventDefault();
      copyText(button.dataset.copy, button);
    });
  }
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const label = button.textContent;
    button.textContent = "Copied";
    button.classList.add("copied");
    setTimeout(() => {
      button.textContent = label;
      button.classList.remove("copied");
    }, 1400);
  } catch (_) {
    button.textContent = "Couldn't copy";
  }
}

function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function slugify(value) {
  const slug = String(value).normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 80);
  return slug || "track";
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

  if (SIMULATE_SUBMIT) {
    for (const step of ["Reading your GitHub account", "Preparing your fork", "Creating a branch", `Committing ${edit.path.split("/").pop()}`, "Opening the pull request"]) {
      status.textContent = `Simulated: ${step}`;
      await new Promise((resolve) => setTimeout(resolve, 450));
    }
    status.textContent = "Simulated: no pull request was opened.";
    return;
  }

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
// The data source is only worth mentioning when it's down; otherwise a quiet footer line.
function setStatus(kind, error) {
  const host = new URL(DATA_SOURCE).hostname;
  el.sourceNote.textContent = kind === "loading" ? "Connecting…" : kind === "error" ? "Offline" : `Data from ${host}`;
  el.sourceError.hidden = kind !== "error";
  if (kind === "error") {
    el.sourceError.textContent = `Couldn't reach ${host}${error?.message ? ` (${error.message})` : ""}. Try Refresh.`;
  }
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
