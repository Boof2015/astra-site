import { SIGNAL_LINK_PREFIX } from './vendor/astra-signal.js';

const RAW_FRAME_PATTERN = /^[A-Za-z0-9_-]+$/;

function safelyDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Recover a v3 Signal link from a custom URI, web URL, fragment, or raw frame. */
export function extractSignalLink(value) {
  if (typeof value !== 'string') return null;
  let candidate = value.trim();
  if (!candidate) return null;

  const prefixIndex = candidate.indexOf(SIGNAL_LINK_PREFIX);
  if (prefixIndex >= 0) {
    const frame = candidate
      .slice(prefixIndex + SIGNAL_LINK_PREFIX.length)
      .split(/[?#&\s]/, 1)[0];
    return RAW_FRAME_PATTERN.test(frame) ? `${SIGNAL_LINK_PREFIX}${frame}` : null;
  }

  try {
    const url = new URL(candidate);
    const hash = safelyDecode(url.hash.slice(1));
    const fromHash = extractSignalLink(hash);
    if (fromHash) return fromHash;
    const fromQuery = extractSignalLink(url.searchParams.get('signal') ?? '');
    if (fromQuery) return fromQuery;
  } catch {
    // Plain fragments and raw frames are handled below.
  }

  candidate = safelyDecode(candidate.replace(/^#/, ''));
  if (candidate.startsWith('v3:')) {
    candidate = `${SIGNAL_LINK_PREFIX}${candidate.slice(3)}`;
    return extractSignalLink(candidate);
  }
  return RAW_FRAME_PATTERN.test(candidate) ? `${SIGNAL_LINK_PREFIX}${candidate}` : null;
}

export function buildSignalPageUrl(signalLink, baseUrl = 'https://astramusic.dev/signal/') {
  const validated = extractSignalLink(signalLink);
  if (!validated) throw new Error('A valid Astra Signal v3 link is required.');
  const url = new URL(baseUrl);
  url.search = '';
  url.hash = validated;
  return url.toString();
}

export function normalizeMatchText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatDuration(durationSec) {
  const total = Math.max(0, Math.round(Number(durationSec) || 0));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

/** Parse a user-entered M:SS duration into the unsigned 16-bit Signal field. */
export function parseDurationInput(value) {
  const match = String(value ?? '').trim().match(/^(\d+):([0-5]\d)$/);
  if (!match) return null;
  const total = Number(match[1]) * 60 + Number(match[2]);
  return Number.isSafeInteger(total) && total > 0 && total <= 65535 ? total : null;
}

export function buildSearchDestinations(payload, country = 'us') {
  const query = `${payload.title} ${payload.artist}`.trim();
  const encodedQuery = encodeURIComponent(query).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const storefront = /^[a-z]{2}$/i.test(country) ? country.toLowerCase() : 'us';
  const withQuery = (baseUrl, parameter) => {
    const url = new URL(baseUrl);
    url.searchParams.set(parameter, query);
    return url.toString();
  };
  return [
    {
      id: 'apple',
      label: 'Apple Music',
      href: withQuery(`https://music.apple.com/${storefront}/search`, 'term'),
    },
    {
      id: 'spotify',
      label: 'Spotify',
      href: `https://open.spotify.com/search/${encodedQuery}`,
    },
    {
      id: 'tidal',
      label: 'TIDAL',
      href: withQuery('https://tidal.com/search', 'q'),
    },
    {
      id: 'soundcloud',
      label: 'SoundCloud',
      href: withQuery('https://soundcloud.com/search/sounds', 'q'),
    },
    {
      id: 'youtube',
      label: 'YouTube Music',
      href: withQuery('https://music.youtube.com/search', 'q'),
    },
    {
      id: 'bandcamp',
      label: 'Bandcamp',
      href: withQuery('https://bandcamp.com/search', 'q'),
    },
  ];
}

export function buildReferenceDestinations(payload) {
  const query = `${payload.title} ${payload.artist}`.trim();
  const url = new URL('https://www.last.fm/search');
  url.searchParams.set('q', query);
  return [{ id: 'lastfm', label: 'Last.fm', href: url.toString() }];
}

export function scoreItunesCandidate(payload, candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  if (normalizeMatchText(candidate.trackName) !== normalizeMatchText(payload.title)) return null;
  if (normalizeMatchText(candidate.artistName) !== normalizeMatchText(payload.artist)) return null;

  const expectedDuration = Math.round(Number(payload.durationSec) || 0);
  const candidateDuration = Math.round(Number(candidate.trackTimeMillis) / 1000);
  let durationDeltaSec = null;
  if (expectedDuration > 0) {
    if (!Number.isFinite(candidateDuration) || candidateDuration <= 0) return null;
    durationDeltaSec = Math.abs(expectedDuration - candidateDuration);
    if (durationDeltaSec > 4) return null;
  }

  return {
    candidate,
    durationDeltaSec,
    score: 100 - (durationDeltaSec ?? 0) * 8,
  };
}

/** Return only candidates that agree on identity and, when present, duration. */
export function selectItunesCandidates(payload, candidates, limit = 3) {
  if (!Array.isArray(candidates)) return [];
  return candidates
    .map((candidate) => scoreItunesCandidate(payload, candidate))
    .filter(Boolean)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return Number(left.candidate.trackId || 0) - Number(right.candidate.trackId || 0);
    })
    .slice(0, Math.max(0, limit));
}
