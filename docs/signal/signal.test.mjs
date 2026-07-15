import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeSignalImage,
  decodeSignalLink,
  encodeSignal,
  encodeSignalLink,
  rasterizeSignal,
} from './vendor/astra-signal.js';
import {
  buildSearchDestinations,
  buildSignalPageUrl,
  extractSignalLink,
  formatDuration,
  selectItunesCandidates,
} from './signal-core.js';

const payload = {
  artist: 'N!GHT',
  title: '#iwannadance',
  durationSec: 213,
};

test('extracts and validates custom, web-fragment, and raw v3 links', () => {
  const signalLink = encodeSignalLink(payload);
  const frame = signalLink.slice('astra:signal:v3:'.length);
  assert.equal(extractSignalLink(signalLink), signalLink);
  assert.equal(extractSignalLink(`https://astramusic.dev/signal/#${signalLink}`), signalLink);
  assert.equal(extractSignalLink(`#v3:${frame}`), signalLink);
  assert.equal(extractSignalLink(frame), signalLink);
  assert.equal(extractSignalLink('astra:signal:v2:nope'), null);
  assert.equal(extractSignalLink('not a signal'), null);
});

test('builds a private fragment URL that preserves Unicode and punctuation metadata', () => {
  const signalLink = encodeSignalLink({ artist: 'ナナツカゼ', title: 'Replay!', durationSec: 201 });
  const url = buildSignalPageUrl(signalLink);
  assert.equal(url.startsWith('https://astramusic.dev/signal/#astra:signal:v3:'), true);
  assert.deepEqual(decodeSignalLink(extractSignalLink(url)), {
    version: 3,
    type: 'metadata',
    artist: 'ナナツカゼ',
    title: 'Replay!',
    durationSec: 201,
  });
});

test('creates user-initiated search destinations without dropping punctuation', () => {
  const destinations = buildSearchDestinations(payload, 'ca');
  assert.deepEqual(destinations.map((entry) => entry.id), ['apple', 'spotify', 'youtube', 'bandcamp', 'lastfm']);
  assert.equal(decodeURIComponent(new URL(destinations[2].href).searchParams.get('q')), 'N!GHT #iwannadance');
  assert.equal(destinations[0].href.startsWith('https://music.apple.com/ca/'), true);
});

test('accepts only Apple candidates agreeing on artist, title, and duration', () => {
  const base = {
    trackId: 12,
    trackName: '#iwannadance',
    artistName: 'N!GHT',
    collectionName: 'Night Drive',
    trackTimeMillis: 214000,
    trackViewUrl: 'https://music.apple.com/track/12',
  };
  const candidates = selectItunesCandidates(payload, [
    { ...base, trackId: 15, trackTimeMillis: 217000 },
    { ...base, trackId: 11, trackTimeMillis: 213000 },
    { ...base, trackId: 10, artistName: 'N GHT' },
    { ...base, trackId: 9, trackTimeMillis: 221000 },
    { ...base, trackId: 8, trackName: 'I Wanna Dance' },
  ]);
  assert.deepEqual(candidates.map((entry) => entry.candidate.trackId), [11, 15]);
  assert.deepEqual(candidates.map((entry) => entry.durationDeltaSec), [0, 4]);
});

test('formats whole-second durations for display', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(213), '3:33');
});

test('the vendored browser decoder reads a rendered Unicode Signal image', () => {
  const layout = encodeSignal({ artist: 'ナナツカゼ', title: 'Replay', durationSec: 214 });
  const image = rasterizeSignal(layout, { scale: 6 });
  assert.deepEqual(decodeSignalImage(image).payload, layout.payload);
});
