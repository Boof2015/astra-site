// Shared data layer for the xlrcdb SPA. Owns the live data source, the aliases
// index, per-artist / track caches, and the small normalization helpers that
// must match the data repo's CI (so the site resolves artists the same way).

export const DATA_SOURCE = "https://boof2015.github.io/xlrcdb";
export const DATA_REPO = { owner: "Boof2015", repo: "xlrcdb" };
export const DATA_REPO_URL = `https://github.com/${DATA_REPO.owner}/${DATA_REPO.repo}`;
export const CONTRIBUTING_URL = `${DATA_REPO_URL}/blob/main/CONTRIBUTING.md`;

const artistCache = new Map();
const trackTextCache = new Map();
let aliasesPromise = null;
let directoryPromise = null;

const store = {
  aliasesIndex: null,
  aliasEntries: []
};

export function getAliasesIndex() {
  return store.aliasesIndex;
}

export function getAliasEntries() {
  return store.aliasEntries;
}

export function clearCaches() {
  store.aliasesIndex = null;
  store.aliasEntries = [];
  aliasesPromise = null;
  directoryPromise = null;
  artistCache.clear();
  trackTextCache.clear();
}

export function loadAliases() {
  aliasesPromise = (async () => {
    store.aliasesIndex = await fetchJson(joinUrl(DATA_SOURCE, "index/aliases.json"));
    store.aliasEntries = Object.entries(store.aliasesIndex.aliases ?? {})
      .sort(([left], [right]) => compareStrings(left, right));
    return store;
  })();
  return aliasesPromise;
}

// The editor can mount before the aliases index arrives (a direct load of #/submit), so
// lookups wait for an in-flight load instead of answering "no such artist".
async function aliasesReady() {
  if (!store.aliasesIndex && aliasesPromise) await aliasesPromise.catch(() => {});
}

// Every artist and track, for search, browsing and the editor's artist suggestions:
//   { artists: [{ id, name, latin, aliases, trackCount }],
//     tracks: [{ artistId, artistName, id, title, length, path, ...details }],
//     fromCatalog }
// Read from index/catalog.json in one request when the data repo publishes it (aliases as
// written, languages, added dates). Otherwise built by fetching each artist's index file,
// where aliases are the lowercase keys aliases.json stores. Cached until clearCaches().
export function getDirectory() {
  if (!directoryPromise) directoryPromise = loadCatalog().catch(() => buildDirectory());
  return directoryPromise;
}

async function loadCatalog() {
  const catalog = await fetchJson(joinUrl(DATA_SOURCE, "index/catalog.json"));
  if (catalog?.version !== 1 || !Array.isArray(catalog.artists) || !Array.isArray(catalog.tracks)) {
    throw new Error("Unsupported catalog");
  }
  const names = new Map(catalog.artists.map((artist) => [artist.id, artist.name]));
  const artists = catalog.artists.map((artist) => ({
    id: artist.id,
    name: artist.name,
    latin: artist.latin || "",
    aliases: [...(artist.aliases || []), ...(artist.latin ? [artist.latin] : [])],
    trackCount: artist.tracks ?? 0
  }));
  const tracks = catalog.tracks.map((track) => ({
    artistId: track.artist,
    artistName: names.get(track.artist) ?? "",
    id: track.id,
    title: track.title,
    length: track.length,
    path: track.path,
    lang: track.lang || "",
    langs: track.langs || [],
    translations: track.translations || [],
    lines: track.lines ?? null,
    furigana: Boolean(track.furigana),
    words: Boolean(track.words),
    voices: Boolean(track.voices),
    added: track.added || null
  }));
  artists.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { artists, tracks, fromCatalog: true };
}

async function buildDirectory() {
  await aliasesReady();
  const aliasesById = new Map();
  for (const [alias, artistId] of store.aliasEntries) {
    if (!aliasesById.has(artistId)) aliasesById.set(artistId, []);
    aliasesById.get(artistId).push(alias);
  }
  const artists = [];
  const tracks = [];
  await Promise.all([...aliasesById].map(async ([artistId, aliases]) => {
    const index = await getArtistIndex(artistId).catch(() => null);
    const name = index?.canonical_name ?? aliases[0];
    artists.push({ id: artistId, name, aliases, trackCount: index?.tracks.length ?? 0 });
    for (const track of index?.tracks ?? []) {
      tracks.push({ artistId, artistName: name, id: track.id, title: track.title, length: track.length, path: track.path });
    }
  }));
  artists.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { artists, tracks, fromCatalog: false };
}

// Every track as { artistId, canonicalName, track } (the duplicate check's shape).
export async function getAllTracks() {
  const { tracks } = await getDirectory();
  return tracks.map((track) => ({
    artistId: track.artistId,
    canonicalName: track.artistName,
    track: { id: track.id, title: track.title, length: track.length, path: track.path }
  }));
}

export function getArtistIndex(artistId) {
  if (!artistCache.has(artistId)) {
    artistCache.set(artistId, fetchJson(joinUrl(DATA_SOURCE, artistIndexPath(artistId))));
  }

  return artistCache.get(artistId);
}

export function getTrackText(trackPath) {
  if (!trackTextCache.has(trackPath)) {
    trackTextCache.set(trackPath, fetchText(joinUrl(DATA_SOURCE, trackPath)));
  }

  return trackTextCache.get(trackPath);
}

// "no-cache" makes the browser revalidate (conditional GET) rather than serve a
// stale copy from GitHub Pages' 10-minute cache, so new submissions show up
// without a hard refresh. Unchanged files come back as a cheap 304.
export async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json();
}

export async function fetchText(url) {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.text();
}

// Same rules as the data repo's normalizeKey: NFKC, lowercase, collapse spaces.
export function normalizeKey(value) {
  return String(value).normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

// Same rules as the data repo's matchKey (duplicate detection only): normalizeKey plus
// punctuation and symbols folded to spaces, so "For - Revenge" matches "for Revenge".
export function matchKey(value) {
  return String(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function artistIndexPath(artistId) {
  const body = artistId.startsWith("art_") ? artistId.slice(4) : artistId;
  return `index/artists/${body.slice(0, 2)}/${body.slice(2, 4)}/${artistId}.json`;
}

export function joinUrl(source, path) {
  return `${source.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

export function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const remaining = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

// Artists whose name or alias differs from artistName only in punctuation, spacing or case
// ("K - DA" vs "K/DA"). Alias resolution is exact, so without a nudge these submissions would
// create a second artist record. Returns [{ artistId, alias, canonicalName }].
export async function findSimilarArtists(artistName) {
  await aliasesReady();
  const key = matchKey(artistName);
  if (!key) return [];
  const matches = new Map();
  for (const [alias, artistId] of store.aliasEntries) {
    if (!matches.has(artistId) && matchKey(alias) === key) matches.set(artistId, alias);
  }
  return Promise.all([...matches].map(async ([artistId, alias]) => {
    const artist = await getArtistIndex(artistId).catch(() => null);
    return { artistId, alias, canonicalName: artist?.canonical_name ?? alias };
  }));
}

// Resolve an [ar:] string to an existing artist id via the aliases index.
// Returns { artistId, canonicalName } when exactly one artist matches, else null.
export async function resolveArtist(artistName) {
  await aliasesReady();
  const aliases = store.aliasesIndex?.aliases ?? {};
  const artistId = aliases[normalizeKey(artistName)];
  if (!artistId) {
    return null;
  }

  const artist = await getArtistIndex(artistId).catch(() => null);
  return { artistId, canonicalName: artist?.canonical_name ?? artistName };
}
