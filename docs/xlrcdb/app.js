const DATA_SOURCE = "https://boof2015.github.io/xlrcdb";

const state = {
  aliasesIndex: null,
  aliasEntries: [],
  artistCache: new Map(),
  trackTextCache: new Map(),
  loading: true,
  error: null,
  searchToken: 0
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

  const route = parseRoute();
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
