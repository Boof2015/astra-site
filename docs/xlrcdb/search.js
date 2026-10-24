// Fuzzy search over artists and tracks for the typeahead (pure, unit-tested).
//
// Every name gets a forgiving key: NFKC, lowercase, Latin accents dropped, katakana folded to
// hiragana, punctuation and symbols turned into spaces. Matching then tries, best first:
// exact, prefix (also with spaces removed, so "kd" finds "K/DA"), word prefix, initials
// ("jr" finds "Jane Remover"), substring, letters in order, and small typos. A query of
// several words can span the artist and the title ("kda firestarter").

export function searchKey(value) {
  return String(value)
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/[ァ-ヶ]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function field(text) {
  const key = searchKey(text);
  const words = key ? key.split(" ") : [];
  return { text, key, compact: words.join(""), words, initials: words.map((w) => w[0]).join("") };
}

// Optimal string alignment distance, giving up past `max`.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      row.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

function inOrder(needle, hay) {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i++;
  return i === needle.length;
}

function tokenScore(token, f) {
  const t = token.compact;
  if (!t || !f.compact) return 0;
  if (f.key === token.key) return 100;
  if (f.key.startsWith(token.key) || f.compact.startsWith(t)) return 85;
  if (f.words.some((w) => w.startsWith(t))) return 70;
  if (t.length >= 2 && f.initials.startsWith(t)) return 60;
  if (f.compact.includes(t)) return 50;
  if (t.length >= 3 && inOrder(t, f.compact)) return 30;
  const allowed = t.length >= 8 ? 2 : t.length >= 4 ? 1 : 0;
  if (allowed) {
    for (const w of [...f.words, f.compact]) {
      if (editDistance(t, w, allowed) <= allowed || editDistance(t, w.slice(0, t.length), allowed) <= allowed) return 22;
    }
  }
  return 0;
}

function bestOver(token, fields) {
  let score = 0;
  let index = -1;
  fields.forEach((f, i) => {
    const s = tokenScore(token, f);
    if (s > score) {
      score = s;
      index = i;
    }
  });
  return { score, index };
}

// { artists: [{ id, name, aliases: [string], trackCount }],
//   tracks: [{ artistId, artistName, id, title, length }] }
export function buildSearchIndex({ artists = [], tracks = [] }) {
  const artistItems = artists.map((artist) => {
    const names = [artist.name, ...artist.aliases.filter((alias) => searchKey(alias) !== searchKey(artist.name))];
    return { ...artist, fields: names.map(field) };
  });
  const byId = new Map(artistItems.map((artist) => [artist.id, artist]));
  const trackItems = tracks.map((track) => ({
    ...track,
    titleField: field(track.title),
    artistFields: byId.get(track.artistId)?.fields ?? [field(track.artistName || "")]
  }));
  return { artists: artistItems, tracks: trackItems };
}

export function search(index, query, { artistLimit = 6, trackLimit = 10 } = {}) {
  const key = searchKey(query);
  if (!key) return { artists: [], tracks: [] };
  const tokens = key.split(" ").map((word) => ({ key: word, compact: word }));
  const whole = { key, compact: key.replace(/ /gu, "") };

  const artists = [];
  for (const artist of index.artists) {
    let total = 0;
    let ok = true;
    for (const token of tokens) {
      const { score } = bestOver(token, artist.fields);
      if (!score) {
        ok = false;
        break;
      }
      total += score;
    }
    const phrase = bestOver(whole, artist.fields);
    if (!ok && !phrase.score) continue;
    total = Math.max(total, phrase.score * tokens.length) + phrase.score * 0.5;
    const matched = phrase.index > 0 ? artist.fields[phrase.index].text : null;
    artists.push({ artist, score: total, alias: matched });
  }

  const tracks = [];
  for (const track of index.tracks) {
    const fields = [track.titleField, ...track.artistFields];
    let total = 0;
    let ok = true;
    let titleHit = false;
    for (const token of tokens) {
      const { score, index: at } = bestOver(token, fields);
      if (!score) {
        ok = false;
        break;
      }
      if (at === 0) titleHit = true;
      total += score;
    }
    const phraseTitle = tokenScore(whole, track.titleField);
    if (phraseTitle) {
      titleHit = true;
      total = Math.max(total, phraseTitle * tokens.length);
    }
    if (!ok && !phraseTitle) continue;
    const phraseArtist = bestOver(whole, track.artistFields).score;
    if (!titleHit && !phraseArtist && tokens.length === 1) continue;
    // Tracks found only through their artist sort below tracks whose title matched.
    tracks.push({ track, score: titleHit ? total + phraseTitle * 0.5 : total * 0.5, viaArtist: !titleHit });
  }

  const rank = (a, b) => b.score - a.score;
  artists.sort((a, b) => rank(a, b) || a.artist.name.length - b.artist.name.length || a.artist.name.localeCompare(b.artist.name));
  tracks.sort((a, b) => rank(a, b) || a.track.title.localeCompare(b.track.title));
  return { artists: artists.slice(0, artistLimit), tracks: tracks.slice(0, trackLimit) };
}

// Character ranges of `text` to highlight for `query`: each query word is looked for in the
// text's letters and digits (punctuation skipped), so "kd" marks the K and D of "K/DA".
export function highlightRanges(text, query) {
  const letters = [];
  const at = [];
  let i = 0;
  for (const ch of text) {
    if (/[\p{L}\p{N}]/u.test(ch)) {
      letters.push(ch.toLowerCase());
      at.push([i, i + ch.length]);
    }
    i += ch.length;
  }
  const hay = letters.join("");
  const ranges = [];
  for (const word of String(query).toLowerCase().split(/\s+/u)) {
    const needle = [...word].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join("");
    if (!needle) continue;
    const pos = hay.indexOf(needle);
    if (pos < 0) continue;
    const startLetter = [...hay.slice(0, pos)].length;
    const endLetter = startLetter + [...needle].length - 1;
    ranges.push([at[startLetter][0], at[endLetter][1]]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}
