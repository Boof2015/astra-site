import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatPublishedDate,
  padRotation,
  searchTextForRotation,
  validateRotations,
} from './relay-content.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let relayAssetVersion = 'dev';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function themeBootScript() {
  return `<script>(function(){var s=null;try{s=localStorage.getItem('astra-relay-theme')}catch(e){}var d=s==='paper'||s==='ink'?s:matchMedia('(prefers-color-scheme: dark)').matches?'ink':'paper';document.documentElement.dataset.theme=d;var m=document.querySelector('meta[name="theme-color"]');if(m)m.content=d==='ink'?'#0f0f0f':'#f0f0f0'})()</script>`;
}

function header(archiveHref) {
  return `<header class="site-header">
    <a class="relay-brand" href="/relay/" aria-label="Astral Relay home">
      <img src="/relay/assets/astral-relay-logo.svg" alt="Astral Relay">
    </a>
    <nav class="header-actions" aria-label="Relay navigation">
      <a href="${archiveHref}">ARCHIVE</a>
      <button class="theme-toggle" type="button" data-theme-toggle aria-label="Switch to ink theme">
        <span class="theme-paper">PAPER</span><i aria-hidden="true">/</i><span class="theme-ink">INK</span>
      </button>
    </nav>
  </header>`;
}

function featured(record, { current = false, detail = false } = {}) {
  const rotation = padRotation(record.number);
  const label = current ? `CURRENT ROTATION <span>· ${rotation}</span>` : `ROTATION <span>· ${rotation}</span>`;
  const detailLink = `/relay/${rotation}/`;
  const artwork = `<span class="artwork-frame">
          <img class="featured-art" src="/relay/${escapeHtml(record.artwork)}" alt="Cover artwork for ${escapeHtml(record.title)} by ${escapeHtml(record.artist)}" data-transition-art data-rotation="${record.number}">
        </span>`;
  const artworkFrame = current
    ? `<a class="featured-art-link" href="${detailLink}" aria-label="Open rotation ${rotation}: ${escapeHtml(record.title)}">${artwork}</a>`
    : `<div class="featured-art-link">${artwork}</div>`;
  return `<section class="featured" aria-labelledby="featured-title" data-featured-rotation="${record.number}">
    <p class="section-label" data-signal-meta="label">${label}</p>
    <div class="featured-grid">
      ${artworkFrame}
      <div class="featured-copy">
        <div class="track-identity" data-signal-source>
          <p class="featured-artist" data-signal-meta="artist">${escapeHtml(record.artist)}</p>
          <div class="title-register">
            <h1 id="featured-title" data-signal-title>${escapeHtml(record.title)}</h1>
          </div>
          ${record.featureLine ? `<p class="feature-line" data-signal-meta="feature">${escapeHtml(record.featureLine)}</p>` : ''}
          <time datetime="${record.publishedOn}" data-signal-meta="date">${formatPublishedDate(record.publishedOn)}</time>
        </div>
        <a class="signal-action" href="${escapeHtml(record.signalUrl)}" data-signal-action="action">
          <span>FIND THIS TRACK</span><b aria-hidden="true">→</b>
        </a>
        <p class="signal-helper" data-signal-action="helper">OPENS SIGNAL · CHOOSE YOUR SERVICE</p>
      </div>
    </div>
  </section>`;
}

function about() {
  return `<section class="about" aria-label="About Astral Relay">
    <article>
      <p class="section-label">01 / RELAY</p>
      <h2>One track.<br>Every Wednesday.</h2>
      <p>Astral Relay is one track, selected each week, presented through motion design and music visualization.</p>
    </article>
    <article>
      <p class="section-label">02 / VISUALS</p>
      <h2>Rendered<br>with Prism.</h2>
      <p>The oscilloscope and spectrum analyzer used in Relay are rendered with <a href="/prism/">Prism</a>.</p>
    </article>
  </section>`;
}

function footer() {
  return `<footer class="site-footer">
    <span>ASTRAL RELAY</span>
    <span>A PROJECT BY <a href="/">ASTRA MUSIC</a></span>
  </footer>`;
}

function documentShell({ title, description, canonical, image, body, bodyClass = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#f0f0f0">
  <meta name="description" content="${escapeHtml(description)}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${image}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="1200">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${image}">
  <link rel="canonical" href="${canonical}">
  <title>${escapeHtml(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  ${themeBootScript()}
  <link rel="stylesheet" href="/relay/styles.css?v=${relayAssetVersion}">
  <link rel="expect" href="#relay-view" blocking="render">
  <script src="/relay/transition.js?v=${relayAssetVersion}" blocking="render"></script>
  <script type="module" src="/relay/app.js?v=${relayAssetVersion}" blocking="render"></script>
</head>
<body class="${bodyClass}">
  ${body}
</body>
</html>`;
}

function archiveRecord(record) {
  const rotation = padRotation(record.number);
  return `<a class="archive-record" href="/relay/${rotation}/" data-rotation="${record.number}" data-search="${escapeHtml(searchTextForRotation(record))}">
    <span class="archive-art"><img src="/relay/${escapeHtml(record.artwork)}" alt="" loading="lazy" data-transition-art data-rotation="${record.number}"></span>
    <span class="archive-copy" data-signal-source>
      <span class="archive-topline"><b>${rotation}</b><time datetime="${record.publishedOn}">${formatPublishedDate(record.publishedOn)}</time></span>
      <strong>${escapeHtml(record.artist)}</strong>
      <em>${escapeHtml(record.title)}</em>
    </span>
    <span class="archive-arrow" aria-hidden="true">→</span>
  </a>`;
}

function indexPage(records) {
  const current = records.at(-1);
  const previous = records.filter((record) => record.number !== current.number).reverse();
  const archive = previous.map((record) => archiveRecord(record)).join('\n');
  const body = `${header('#archive')}
  <main id="relay-view">
    ${featured(current, { current: true })}
    <section class="archive" id="archive" aria-labelledby="archive-title">
      <div class="archive-heading">
        <div>
          <h2 id="archive-title">Archive</h2>
        </div>
        <label class="archive-search">
          <span class="sr-only">Search by rotation number, artist, or title</span>
          <span aria-hidden="true">/</span>
          <input type="search" inputmode="search" autocomplete="off" spellcheck="false" placeholder="NUMBER, ARTIST, OR TITLE" data-archive-search>
        </label>
      </div>
      <p class="archive-status sr-only" data-archive-status aria-live="polite">${previous.length} ${previous.length === 1 ? 'ROTATION' : 'ROTATIONS'}</p>
      <div class="archive-grid" data-archive-grid>${archive}</div>
      <p class="archive-empty" data-archive-empty${previous.length ? ' hidden' : ''}>${previous.length ? 'NO ROTATIONS MATCH THAT SEARCH.' : 'NO PREVIOUS ROTATIONS YET.'}</p>
    </section>
    ${about()}
  </main>
  ${footer()}`;
  return documentShell({
    title: 'Astral Relay — Weekly Rotation Archive',
    description: `Astral Relay rotation ${padRotation(current.number)}: ${current.title} by ${current.artist}. Browse the weekly archive and listen through Signal.`,
    canonical: 'https://astramusic.dev/relay/',
    image: `https://astramusic.dev/relay/${current.artwork}`,
    body,
    bodyClass: 'archive-index',
  });
}

function detailNavigation(records, index) {
  const previous = records[index - 1];
  const next = records[index + 1];
  return `<nav class="rotation-navigation" aria-label="Adjacent rotations">
    ${previous ? `<a href="/relay/${padRotation(previous.number)}/"><span>PREVIOUS</span><b>← ${padRotation(previous.number)}</b></a>` : '<span></span>'}
    ${next ? `<a href="/relay/${padRotation(next.number)}/"><span>NEXT</span><b>${padRotation(next.number)} →</b></a>` : `<a href="/relay/#archive"><span>INDEX</span><b>ARCHIVE →</b></a>`}
  </nav>`;
}

function detailPage(record, records, index) {
  const rotation = padRotation(record.number);
  const description = `Astral Relay rotation ${rotation}: ${record.title} by ${record.artist}. Find the track through Astra Signal.`;
  const body = `${header('/relay/#archive')}
  <main id="relay-view">
    ${featured(record, { detail: true })}
    ${detailNavigation(records, index)}
    ${about()}
  </main>
  ${footer()}`;
  return documentShell({
    title: `${rotation} — ${record.title} by ${record.artist} | Astral Relay`,
    description,
    canonical: `https://astramusic.dev/relay/${rotation}/`,
    image: `https://astramusic.dev/relay/${record.artwork}`,
    body,
    bodyClass: 'rotation-detail',
  });
}

export async function generateRelaySite({
  root = projectRoot,
  sourceRoot = path.join(root, 'relay'),
  outputRoot = path.join(root, 'docs', 'relay'),
} = {}) {
  const raw = JSON.parse(await readFile(path.join(sourceRoot, 'rotations.json'), 'utf8'));
  const records = await validateRotations(raw, sourceRoot);
  const assetSources = await Promise.all([
    readFile(path.join(sourceRoot, 'styles.css')),
    readFile(path.join(sourceRoot, 'transition.js')),
    readFile(path.join(sourceRoot, 'app.js')),
  ]);
  const assetHash = createHash('sha256');
  assetSources.forEach((source) => assetHash.update(source));
  relayAssetVersion = assetHash.digest('hex').slice(0, 12);

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await cp(path.join(sourceRoot, 'assets'), path.join(outputRoot, 'assets'), { recursive: true });
  await cp(path.join(sourceRoot, 'styles.css'), path.join(outputRoot, 'styles.css'));
  await cp(path.join(sourceRoot, 'transition.js'), path.join(outputRoot, 'transition.js'));
  await cp(path.join(sourceRoot, 'app.js'), path.join(outputRoot, 'app.js'));
  await writeFile(path.join(outputRoot, 'index.html'), indexPage(records));

  for (const [index, record] of records.entries()) {
    const directory = path.join(outputRoot, padRotation(record.number));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'index.html'), detailPage(record, records, index));
  }
  return records;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const records = await generateRelaySite();
  process.stdout.write(`Built Astral Relay index and ${records.length} rotation page${records.length === 1 ? '' : 's'}.\n`);
}
