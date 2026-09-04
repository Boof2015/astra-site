import { stat } from 'node:fs/promises';
import path from 'node:path';
import { decodeSignalLink, encodeSignalLink } from '../docs/signal/vendor/astra-signal.js';
import { buildSignalPageUrl } from '../docs/signal/signal-core.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RECORD_FIELDS = new Set([
  'number',
  'publishedOn',
  'artist',
  'title',
  'featureLine',
  'album',
  'releaseYear',
  'durationSeconds',
  'artwork',
]);

function nonEmptyText(value, field, index) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Rotation ${index + 1}: ${field} must be non-empty text.`);
  }
  return value.trim();
}

function optionalText(value, field, index) {
  if (value === undefined) return undefined;
  return nonEmptyText(value, field, index);
}

function validateDate(value, index) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    throw new Error(`Rotation ${index + 1}: publishedOn must be an ISO date.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Rotation ${index + 1}: publishedOn is not a real calendar date.`);
  }
  return value;
}

function safeArtworkPath(value, index) {
  const artwork = nonEmptyText(value, 'artwork', index).replaceAll('\\', '/');
  if (
    artwork.startsWith('/')
    || artwork.includes('\0')
    || path.posix.normalize(artwork) !== artwork
    || artwork.split('/').includes('..')
    || !artwork.startsWith('assets/artwork/')
  ) {
    throw new Error(`Rotation ${index + 1}: artwork must be a safe path inside assets/artwork/.`);
  }
  return artwork;
}

function validateSignal(record, index) {
  try {
    const payload = {
      artist: record.artist,
      title: record.title,
      durationSec: record.durationSeconds,
    };
    const signalLink = encodeSignalLink(payload);
    const decoded = decodeSignalLink(signalLink);
    if (
      decoded.artist !== payload.artist
      || decoded.title !== payload.title
      || decoded.durationSec !== payload.durationSec
    ) {
      throw new Error('round trip changed the payload');
    }
    return buildSignalPageUrl(signalLink);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Rotation ${index + 1}: Signal payload is invalid (${message}).`);
  }
}

export function padRotation(number) {
  return String(number).padStart(3, '0');
}

export function formatPublishedDate(value) {
  const [year, month, day] = value.split('-');
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${day} ${months[Number(month) - 1]} ${year}`;
}

export async function validateRotations(input, sourceRoot) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error('Relay rotations must be a non-empty array.');
  }

  const seenNumbers = new Set();
  const seenDates = new Set();
  const records = [];
  for (const [index, value] of input.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Rotation ${index + 1}: record must be an object.`);
    }
    const unexpected = Object.keys(value).filter((field) => !RECORD_FIELDS.has(field));
    if (unexpected.length) {
      throw new Error(`Rotation ${index + 1}: unknown field ${unexpected.join(', ')}.`);
    }
    if (!Number.isInteger(value.number) || value.number <= 0) {
      throw new Error(`Rotation ${index + 1}: number must be a positive integer.`);
    }
    if (seenNumbers.has(value.number)) throw new Error(`Duplicate rotation number ${value.number}.`);
    seenNumbers.add(value.number);

    const publishedOn = validateDate(value.publishedOn, index);
    if (seenDates.has(publishedOn)) throw new Error(`Duplicate publication date ${publishedOn}.`);
    seenDates.add(publishedOn);

    if (!Number.isInteger(value.durationSeconds) || value.durationSeconds <= 0) {
      throw new Error(`Rotation ${index + 1}: durationSeconds must be a positive integer.`);
    }
    if (
      value.releaseYear !== undefined
      && (!Number.isInteger(value.releaseYear) || value.releaseYear < 1000 || value.releaseYear > 9999)
    ) {
      throw new Error(`Rotation ${index + 1}: releaseYear must be a four-digit integer.`);
    }

    const record = {
      number: value.number,
      publishedOn,
      artist: nonEmptyText(value.artist, 'artist', index),
      title: nonEmptyText(value.title, 'title', index),
      durationSeconds: value.durationSeconds,
      artwork: safeArtworkPath(value.artwork, index),
    };
    const featureLine = optionalText(value.featureLine, 'featureLine', index);
    const album = optionalText(value.album, 'album', index);
    if (featureLine) record.featureLine = featureLine;
    if (album) record.album = album;
    if (value.releaseYear !== undefined) record.releaseYear = value.releaseYear;

    const artworkPath = path.resolve(sourceRoot, record.artwork);
    const resolvedRoot = `${path.resolve(sourceRoot)}${path.sep}`;
    if (!artworkPath.startsWith(resolvedRoot)) {
      throw new Error(`Rotation ${index + 1}: artwork resolves outside the Relay source.`);
    }
    try {
      const artwork = await stat(artworkPath);
      if (!artwork.isFile()) throw new Error('not a file');
    } catch {
      throw new Error(`Rotation ${index + 1}: artwork does not exist at ${record.artwork}.`);
    }
    record.signalUrl = validateSignal(record, index);
    records.push(record);
  }

  return records.sort((left, right) => left.number - right.number);
}

export function searchTextForRotation(record) {
  return [
    padRotation(record.number),
    String(record.number),
    record.artist,
    record.title,
  ].join(' ').normalize('NFKC').toLowerCase();
}
