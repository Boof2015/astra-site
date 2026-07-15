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

export function buildSearchDestinations(payload, country = 'us') {
  const query = `${payload.artist} ${payload.title}`.trim();
  const encodedQuery = encodeURIComponent(query);
  const artist = encodeURIComponent(payload.artist);
  const title = encodeURIComponent(payload.title);
  const storefront = /^[a-z]{2}$/i.test(country) ? country.toLowerCase() : 'us';
  return [
    {
      id: 'apple',
      label: 'Apple Music',
      href: `https://music.apple.com/${storefront}/search?term=${encodedQuery}`,
    },
    {
      id: 'spotify',
      label: 'Spotify',
      href: `https://open.spotify.com/search/${encodedQuery}`,
    },
    {
      id: 'youtube',
      label: 'YouTube Music',
      href: `https://music.youtube.com/search?q=${encodedQuery}`,
    },
    {
      id: 'bandcamp',
      label: 'Bandcamp',
      href: `https://bandcamp.com/search?q=${encodedQuery}`,
    },
    {
      id: 'lastfm',
      label: 'Last.fm',
      href: `https://www.last.fm/music/${artist}/_/${title}`,
    },
  ];
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
