import {
  decodeSignalImage,
  decodeSignalLink,
  encodeSignal,
  encodeSignalLink,
  rasterizeSignal,
} from './vendor/astra-signal.js';
import {
  buildReferenceDestinations,
  buildSearchDestinations,
  buildSignalPageUrl,
  extractSignalLink,
  formatDuration,
  selectItunesCandidates,
} from './signal-core.js';

const MAX_IMAGE_DIM = 2048;
const ITUNES_TIMEOUT_MS = 8000;

const intro = document.querySelector('#intro');
const resultSection = document.querySelector('#result');
const dropZone = document.querySelector('#drop-zone');
const imageInput = document.querySelector('#image-input');
const linkForm = document.querySelector('#link-form');
const linkInput = document.querySelector('#link-input');
const inputError = document.querySelector('#input-error');
const statusDot = document.querySelector('#status-dot');
const sourceStatus = document.querySelector('#source-status');
const decodeAnother = document.querySelector('#decode-another');
const signalCanvas = document.querySelector('#signal-canvas');
const trackTitle = document.querySelector('#track-title');
const trackArtist = document.querySelector('#track-artist');
const trackDuration = document.querySelector('#track-duration');
const serviceGrid = document.querySelector('#service-grid');
const referenceGrid = document.querySelector('#reference-grid');
const shareButton = document.querySelector('#share-button');
const lookupButton = document.querySelector('#lookup-button');
const lookupResults = document.querySelector('#lookup-results');

let activePayload = null;
let activeSignalLink = null;

function browserCountry() {
  const region = String(navigator.language || '').split('-')[1];
  return /^[a-z]{2}$/i.test(region) ? region.toLowerCase() : 'us';
}

function setInputError(message = '') {
  inputError.textContent = message;
  statusDot.classList.toggle('error', Boolean(message));
  statusDot.classList.toggle('ready', !message);
  sourceStatus.textContent = message
    ? 'Input rejected'
    : activePayload
      ? 'Valid Signal decoded locally'
      : 'Waiting for local input';
}

function setDropBusy(busy) {
  dropZone.disabled = busy;
  dropZone.querySelector('.drop-title').textContent = busy
    ? 'Reading Signal…'
    : 'Choose Signal image';
  if (busy) {
    statusDot.classList.remove('ready', 'error');
    sourceStatus.textContent = 'Decoding image locally';
  } else {
    setInputError(inputError.textContent);
  }
}

function renderSignal(payload) {
  const layout = encodeSignal(payload);
  const raster = rasterizeSignal(layout, { scale: 5 });
  signalCanvas.width = raster.width;
  signalCanvas.height = raster.height;
  const context = signalCanvas.getContext('2d');
  context.putImageData(new ImageData(raster.data, raster.width, raster.height), 0, 0);
}

function renderServices(payload) {
  serviceGrid.replaceChildren();
  for (const service of buildSearchDestinations(payload, browserCountry())) {
    const link = document.createElement('a');
    link.className = `service-link service-${service.id}`;
    link.href = service.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = service.label;
    serviceGrid.append(link);
  }

  referenceGrid.replaceChildren();
  for (const service of buildReferenceDestinations(payload)) {
    const link = document.createElement('a');
    link.href = service.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = `${service.label} ↗`;
    referenceGrid.append(link);
  }
}

function showPayload(payload, signalLink, { updateLocation = true } = {}) {
  activePayload = payload;
  activeSignalLink = signalLink;
  renderSignal(payload);
  renderServices(payload);
  trackTitle.textContent = payload.title || 'Untitled track';
  trackArtist.textContent = payload.artist || 'Unknown artist';
  trackDuration.textContent = formatDuration(payload.durationSec);
  lookupResults.replaceChildren();
  lookupButton.disabled = false;
  lookupButton.textContent = 'Check Apple catalog';
  intro.hidden = true;
  resultSection.hidden = false;
  setInputError();

  if (updateLocation) {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = signalLink;
    history.replaceState(null, '', url);
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function decodeLinkValue(value, options) {
  const signalLink = extractSignalLink(value);
  if (!signalLink) throw new Error('That is not an Astra Signal v3 link.');
  const payload = decodeSignalLink(signalLink);
  showPayload(payload, signalLink, options);
}

async function imageSourceFromFile(file) {
  if ('createImageBitmap' in window) return createImageBitmap(file);
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = sourceUrl;
    await image.decode();
    return image;
  } catch (error) {
    URL.revokeObjectURL(sourceUrl);
    throw error;
  }
}

async function decodeImageFile(file) {
  if (!(file instanceof Blob) || !file.type.startsWith('image/')) {
    throw new Error('Choose a PNG, screenshot, or camera photo.');
  }
  const source = await imageSourceFromFile(file);
  try {
    const sourceWidth = source.width;
    const sourceHeight = source.height;
    const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(source, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    const decoded = decodeSignalImage({ data: image.data, width, height });
    const signalLink = encodeSignalLink(decoded.payload);
    showPayload(decoded.payload, signalLink);
  } finally {
    if (typeof source.close === 'function') source.close();
    if (source instanceof HTMLImageElement) URL.revokeObjectURL(source.src);
  }
}

function itunesSearch(payload) {
  return new Promise((resolve, reject) => {
    const callbackName = `__astraSignalItunes_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const script = document.createElement('script');
    const timeout = window.setTimeout(() => finish(new Error('Apple catalog lookup timed out.')), ITUNES_TIMEOUT_MS);

    function finish(error, data) {
      window.clearTimeout(timeout);
      script.remove();
      delete window[callbackName];
      if (error) reject(error);
      else resolve(data);
    }

    window[callbackName] = (data) => finish(null, data);
    script.onerror = () => finish(new Error('Apple catalog lookup is unavailable.'));
    const parameters = new URLSearchParams({
      term: `${payload.artist} ${payload.title}`,
      country: browserCountry().toUpperCase(),
      media: 'music',
      entity: 'song',
      limit: '15',
      callback: callbackName,
    });
    script.src = `https://itunes.apple.com/search?${parameters}`;
    document.head.append(script);
  });
}

function largerArtwork(url) {
  return typeof url === 'string' ? url.replace(/100x100(?:bb)?/, '300x300bb') : '';
}

function appendLookupStatus(message) {
  const status = document.createElement('p');
  status.className = 'lookup-status';
  status.textContent = message;
  lookupResults.append(status);
}

function renderCatalogMatches(matches) {
  lookupResults.replaceChildren();
  if (matches.length === 0) {
    appendLookupStatus('No exact Apple catalog match passed the artist, title, and duration checks. The service searches above are still available.');
    return;
  }

  appendLookupStatus(matches.length === 1
    ? 'One recording agrees with the Signal metadata.'
    : 'More than one catalog version agrees. Choose the one you recognize.');

  for (const { candidate, durationDeltaSec } of matches) {
    const row = document.createElement('article');
    row.className = 'catalog-match';

    const artwork = document.createElement('img');
    artwork.src = largerArtwork(candidate.artworkUrl100);
    artwork.alt = '';
    artwork.loading = 'lazy';

    const copy = document.createElement('div');
    copy.className = 'catalog-match-copy';
    const title = document.createElement('strong');
    title.textContent = candidate.trackName;
    const detail = document.createElement('span');
    const durationNote = durationDeltaSec === null ? '' : ` · ${formatDuration(Math.round(candidate.trackTimeMillis / 1000))}`;
    detail.textContent = `${candidate.artistName} · ${candidate.collectionName || 'Apple Music'}${durationNote}`;
    copy.append(title, detail);

    const open = document.createElement('a');
    open.href = candidate.trackViewUrl;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.textContent = 'Open in Apple Music ↗';
    row.append(artwork, copy, open);
    lookupResults.append(row);
  }
}

dropZone.addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', async () => {
  const file = imageInput.files?.[0];
  if (!file) return;
  setInputError();
  setDropBusy(true);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try {
    await decodeImageFile(file);
  } catch {
    setInputError("Couldn't read a valid Signal from that image.");
  } finally {
    setDropBusy(false);
    imageInput.value = '';
  }
});

for (const eventName of ['dragenter', 'dragover']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add('is-dragging');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove('is-dragging');
  });
}
dropZone.addEventListener('drop', async (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (!file) return;
  setInputError();
  setDropBusy(true);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try {
    await decodeImageFile(file);
  } catch {
    setInputError("Couldn't read a valid Signal from that image.");
  } finally {
    setDropBusy(false);
  }
});

document.addEventListener('paste', async (event) => {
  if (document.activeElement === linkInput) return;
  const file = [...(event.clipboardData?.files ?? [])].find((candidate) => candidate.type.startsWith('image/'));
  if (!file) return;
  setInputError();
  setDropBusy(true);
  try {
    await decodeImageFile(file);
  } catch {
    setInputError("Couldn't read a valid Signal from that pasted image.");
  } finally {
    setDropBusy(false);
  }
});

linkForm.addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    decodeLinkValue(linkInput.value);
  } catch {
    setInputError('That link does not contain a valid Astra Signal v3 frame.');
  }
});

decodeAnother.addEventListener('click', () => {
  activePayload = null;
  activeSignalLink = null;
  resultSection.hidden = true;
  intro.hidden = false;
  linkInput.value = '';
  setInputError();
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

shareButton.addEventListener('click', async () => {
  if (!activeSignalLink) return;
  const url = buildSignalPageUrl(activeSignalLink, window.location.href);
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Astra Signal', text: activePayload ? `${activePayload.title} — ${activePayload.artist}` : 'Astra Signal', url });
    } else {
      await navigator.clipboard.writeText(url);
      shareButton.textContent = 'Link copied';
      window.setTimeout(() => { shareButton.textContent = 'Share Signal'; }, 1400);
    }
  } catch (error) {
    if (error?.name !== 'AbortError') shareButton.textContent = 'Could not share';
  }
});

lookupButton.addEventListener('click', async () => {
  if (!activePayload || lookupButton.disabled) return;
  lookupButton.disabled = true;
  lookupButton.textContent = 'Checking…';
  lookupResults.replaceChildren();
  appendLookupStatus('Searching Apple’s catalog…');
  try {
    const response = await itunesSearch(activePayload);
    renderCatalogMatches(selectItunesCandidates(activePayload, response?.results, 3));
  } catch (error) {
    lookupResults.replaceChildren();
    appendLookupStatus(error instanceof Error ? error.message : 'Apple catalog lookup is unavailable.');
  } finally {
    lookupButton.disabled = false;
    lookupButton.textContent = 'Check again';
  }
});

const initialLink = extractSignalLink(window.location.hash);
if (initialLink) {
  try {
    decodeLinkValue(initialLink, { updateLocation: false });
  } catch {
    setInputError('This page URL contains an invalid or corrupted Astra Signal.');
  }
}
