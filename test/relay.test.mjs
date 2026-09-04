import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  relayRoute,
  resolveTheme,
  rotationMatchesQuery,
} from '../relay/app.js';
import { generateRelaySite } from '../scripts/build-relay.mjs';
import { padRotation, searchTextForRotation, validateRotations } from '../scripts/relay-content.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(projectRoot, 'relay');
const valid = {
  number: 32,
  publishedOn: '2026-09-02',
  artist: 'Sheeno Mirin',
  title: 'Debriefing',
  featureLine: 'feat. Guest Artist',
  album: 'Harmony',
  releaseYear: 2026,
  durationSeconds: 180,
  artwork: 'assets/artwork/001.webp',
};

test('validates records, artwork, ordering, and Signal round trips', async () => {
  const records = await validateRotations([
    { ...valid, number: 33, publishedOn: '2026-09-09' },
    valid,
  ], sourceRoot);
  assert.deepEqual(records.map((record) => record.number), [32, 33]);
  assert.match(records[0].signalUrl, /^https:\/\/astramusic\.dev\/signal\/#astra:signal:v3:/);
  assert.equal(padRotation(records[0].number), '032');
});

test('rejects duplicate numbers and dates', async () => {
  await assert.rejects(
    validateRotations([valid, { ...valid }], sourceRoot),
    /Duplicate rotation number 32/,
  );
  await assert.rejects(
    validateRotations([valid, { ...valid, number: 33 }], sourceRoot),
    /Duplicate publication date 2026-09-02/,
  );
});

test('rejects invalid dates, unsafe or missing artwork, and malformed Signal payloads', async () => {
  await assert.rejects(
    validateRotations([{ ...valid, publishedOn: '2026-02-30' }], sourceRoot),
    /not a real calendar date/,
  );
  await assert.rejects(
    validateRotations([{ ...valid, artwork: '../secret.webp' }], sourceRoot),
    /safe path/,
  );
  await assert.rejects(
    validateRotations([{ ...valid, artwork: 'assets/artwork/missing.webp' }], sourceRoot),
    /does not exist/,
  );
  await assert.rejects(
    validateRotations([{ ...valid, title: 'x'.repeat(2000) }], sourceRoot),
    /Signal payload is invalid/,
  );
  await assert.rejects(
    validateRotations([{ ...valid, signalUrl: 'https://example.com/' }], sourceRoot),
    /unknown field signalUrl/,
  );
});

test('search matches padded and plain numbers, artist, title, partial text, and case', () => {
  const record = { number: valid.number, search: searchTextForRotation(valid) };
  assert.equal(rotationMatchesQuery(record, '032'), true);
  assert.equal(rotationMatchesQuery(record, '32'), true);
  assert.equal(rotationMatchesQuery(record, 'SHEENO'), true);
  assert.equal(rotationMatchesQuery(record, 'brief'), true);
  assert.equal(rotationMatchesQuery(record, 'not here'), false);
  assert.equal(rotationMatchesQuery(record, ''), true);
});

test('classifies Relay routes', () => {
  assert.deepEqual(relayRoute('https://astramusic.dev/relay/'), { kind: 'index', number: null });
  assert.deepEqual(relayRoute('https://astramusic.dev/relay/#archive'), { kind: 'index', number: null });
  assert.deepEqual(relayRoute('https://astramusic.dev/relay/032/'), { kind: 'detail', number: 32 });
  assert.deepEqual(relayRoute('https://astramusic.dev/relay/032/index.html'), { kind: 'detail', number: 32 });
  assert.equal(relayRoute('https://astramusic.dev/signal/'), null);
});

test('uses the system theme until Paper or Ink is explicitly selected', () => {
  assert.equal(resolveTheme(null, false), 'paper');
  assert.equal(resolveTheme(null, true), 'ink');
  assert.equal(resolveTheme('paper', true), 'paper');
  assert.equal(resolveTheme('ink', false), 'ink');
  assert.equal(resolveTheme('invalid', true), 'ink');
});

test('generates a semantic index and permanent page with canonical metadata', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'astral-relay-site-test-'));
  try {
    const outputRoot = path.join(temporaryRoot, 'relay');
    const sourceRecords = JSON.parse(await readFile(path.join(sourceRoot, 'rotations.json'), 'utf8'));
    const current = sourceRecords.reduce((latest, record) => (
      !latest || record.number > latest.number ? record : latest
    ), null);
    const currentRotation = padRotation(current.number);
    await generateRelaySite({ root: projectRoot, sourceRoot, outputRoot });
    const index = await readFile(path.join(outputRoot, 'index.html'), 'utf8');
    const detail = await readFile(path.join(outputRoot, currentRotation, 'index.html'), 'utf8');

    assert.match(index, /<h1 id="featured-title" data-signal-title>[^<]+<\/h1>/);
    assert.match(index, /data-archive-search/);
    assert.match(index, /data-transition-art/);
    assert.doesNotMatch(index, /data-title-noise/);
    assert.match(index, /<link rel="expect" href="#relay-view" blocking="render">/);
    assert.match(index, /prefers-color-scheme: dark/);
    assert.match(index, /s==='paper'\|\|s==='ink'/);
    assert.match(index, /<link rel="stylesheet" href="\/relay\/styles\.css\?v=[a-f0-9]{12}">/);
    assert.match(index, /<script src="\/relay\/transition\.js\?v=[a-f0-9]{12}" blocking="render"><\/script>/);
    assert.match(index, /<script type="module" src="\/relay\/app\.js\?v=[a-f0-9]{12}" blocking="render"><\/script>/);
    assert.match(index, /<main id="relay-view">/);
    assert.match(index, /astra-relay-theme/);
    assert.ok(index.includes(`href="/relay/${currentRotation}/"`));
    assert.match(index, /Astral Relay is one track, selected each week/);
    assert.ok(detail.includes(`rel="canonical" href="https://astramusic.dev/relay/${currentRotation}/"`));
    assert.ok(detail.includes(`data-transition-art data-rotation="${current.number}"`));
    assert.ok(detail.includes(`property="og:image" content="https://astramusic.dev/relay/${current.artwork}"`));
    assert.match(detail, /href="https:\/\/astramusic\.dev\/signal\/#astra:signal:v3:/);
    assert.match(detail, /The oscilloscope and spectrum analyzer used in Relay are rendered with/);
    assert.match(detail, /<span>INDEX<\/span><b>ARCHIVE →<\/b>/);
    const css = await readFile(path.join(outputRoot, 'styles.css'), 'utf8');
    const app = await readFile(path.join(outputRoot, 'app.js'), 'utf8');
    const transition = await readFile(path.join(outputRoot, 'transition.js'), 'utf8');
    assert.match(css, /relay-live-art-flight/);
    assert.match(css, /relay-live-scan/);
    assert.match(css, /relay-live-scan-sweep/);
    assert.match(css, /relay-arrival-pending main/);
    assert.match(css, /grid-template-columns: minmax\(340px, 540px\)/);
    assert.match(css, /@view-transition/);
    assert.match(css, /relay-hold-outgoing-page/);
    assert.doesNotMatch(css, /relay-live-art-scan/);
    assert.match(transition, /createArtworkFlight/);
    assert.match(transition, /prepareTextArrival/);
    assert.match(transition, /runDeparture/);
    assert.match(transition, /isAdjacentDetailNavigation/);
    assert.match(transition, /link\.closest\('\.rotation-navigation'\)/);
    assert.match(transition, /classList\.remove\('relay-departing'\)/);
    assert.match(transition, /coldOpenPending/);
    assert.match(transition, /archiveArtworkForRotation/);
    assert.match(transition, /scrollIntoView/);
    assert.match(transition, /timing\.sweepDuration \?\? 350/);
    assert.match(transition, /sweepDuration: 410/);
    assert.match(transition, /index \* 52/);
    assert.doesNotMatch(transition, /createArtworkScan/);
    assert.doesNotMatch(transition, /scrambleTitle|SIGNAL_GLYPHS|data-title-noise/);
    assert.match(transition, /addEventListener\('pageswap'/);
    assert.match(transition, /addEventListener\('pagereveal'/);
    assert.match(transition, /addEventListener\('pageshow'/);
    assert.match(transition, /restoreDepartureVisuals\(\);\n    document\.documentElement\.classList\.remove\('relay-departing'\)/);
    assert.doesNotMatch(transition, /contrast\(1\.18\) saturate\(0\.72\)/);
    assert.doesNotMatch(app, /preventDefault\(\)/);
    assert.match(css, /prefers-reduced-motion: reduce/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
