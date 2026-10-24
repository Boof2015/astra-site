// Audio engine for the editor: playback, decoding, loudness normalization, waveform peaks,
// looping, active-line tracking and embedded-lyric extraction. Drawing lives in timeline.js.
//
// els:   { audio, playBtn, time }
// hooks: { getOrder(): [{ timestamp }] sorted by time, getOffset(): ms,
//          onActiveLine(orderIndex), onTick(seconds), onDuration(sec), onPeaks(peaks),
//          onEmbeddedLyrics(text, name) }

import { formatPlaybackTime } from "./render.js";

// Waveform resolution kept after decoding: enough to zoom down to ~10ms per pixel.
const PEAKS_PER_SECOND = 200;

export function createAudioEngine(els, hooks) {
  const { audio, playBtn, time } = els;

  let audioCtx = null;
  let mediaSrc = null;
  let gainNode = null;
  let normGain = 1;
  let rate = 1;
  let audioURL = null;
  let activePos = -1;
  let rafId = 0;
  let loop = null; // { start, end } in seconds

  function ensureGraph() {
    if (audioCtx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
    mediaSrc = audioCtx.createMediaElementSource(audio);
    gainNode = audioCtx.createGain();
    gainNode.gain.value = normGain;
    mediaSrc.connect(gainNode).connect(audioCtx.destination);
  }
  function applyGain() {
    if (gainNode) gainNode.gain.value = normGain;
  }

  // min/max per bucket (channels mixed down) plus a loudness-normalization gain.
  async function decode(buf) {
    normGain = 1;
    applyGain();
    let tmpCtx = null;
    try {
      ensureGraph();
      const ctx = audioCtx || (tmpCtx = new (window.AudioContext || window.webkitAudioContext)());
      const audioBuf = await ctx.decodeAudioData(buf);
      const channels = [];
      for (let c = 0; c < Math.min(2, audioBuf.numberOfChannels); c++) channels.push(audioBuf.getChannelData(c));
      const length = channels[0].length;
      const bucket = Math.max(1, Math.round(audioBuf.sampleRate / PEAKS_PER_SECOND));
      const count = Math.ceil(length / bucket);
      const min = new Float32Array(count);
      const max = new Float32Array(count);
      let peak = 0;
      let sumSquares = 0;
      for (let b = 0; b < count; b++) {
        let lo = 0;
        let hi = 0;
        const end = Math.min(length, (b + 1) * bucket);
        for (let i = b * bucket; i < end; i++) {
          const v = channels.length === 2 ? (channels[0][i] + channels[1][i]) * 0.5 : channels[0][i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
          sumSquares += v * v;
        }
        min[b] = lo;
        max[b] = hi;
        if (-lo > peak) peak = -lo;
        if (hi > peak) peak = hi;
      }
      if (peak > 0) {
        for (let b = 0; b < count; b++) {
          min[b] /= peak;
          max[b] /= peak;
        }
      }
      const rms = Math.sqrt(sumSquares / length);
      if (rms > 0) {
        const TARGET_RMS = 0.1;
        const CEILING = 0.97;
        let g = TARGET_RMS / rms;
        if (peak > 0) g = Math.min(g, CEILING / peak);
        normGain = Math.max(0.1, Math.min(g, 4));
      }
      applyGain();
      hooks.onPeaks?.({ min, max, perSecond: audioBuf.sampleRate / bucket, duration: audioBuf.duration });
    } catch (e) {
      hooks.onPeaks?.(null);
    } finally {
      if (tmpCtx) tmpCtx.close();
    }
  }

  // Binary search over the playback-ordered lines for the one playing at ms.
  function positionAt(ms) {
    const order = hooks.getOrder();
    let lo = 0;
    let hi = order.length - 1;
    let res = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (order[mid].timestamp <= ms) {
        res = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return res;
  }
  function syncActive(force) {
    const pos = positionAt(audio.currentTime * 1000 - (hooks.getOffset() || 0));
    if (pos === activePos && !force) return;
    activePos = pos;
    hooks.onActiveLine(pos);
  }

  function updateTime() {
    time.textContent = `${formatPlaybackTime(audio.currentTime || 0)} / ${formatPlaybackTime(audio.duration || 0)}`;
  }

  function frame() {
    if (loop && audio.currentTime >= loop.end) audio.currentTime = loop.start;
    updateTime();
    syncActive(false);
    hooks.onTick?.(audio.currentTime);
    rafId = requestAnimationFrame(frame);
  }
  function startLoop() {
    if (!rafId) rafId = requestAnimationFrame(frame);
  }
  function stopLoop() {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  // ── events ──
  const onPlayClick = () => toggle();
  const onPlay = () => {
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    playBtn.classList.add("playing");
    startLoop();
  };
  const onPause = () => {
    playBtn.classList.remove("playing");
    stopLoop();
    updateTime();
    hooks.onTick?.(audio.currentTime);
  };
  const onEnded = () => {
    playBtn.classList.remove("playing");
    stopLoop();
  };
  const onLoadedMeta = () => {
    audio.playbackRate = rate; // a new source resets the rate; re-apply it
    updateTime();
    if (isFinite(audio.duration)) hooks.onDuration(audio.duration);
  };
  const onSeeked = () => {
    updateTime();
    syncActive(true);
    hooks.onTick?.(audio.currentTime);
  };

  playBtn.addEventListener("click", onPlayClick);
  audio.addEventListener("play", onPlay);
  audio.addEventListener("pause", onPause);
  audio.addEventListener("ended", onEnded);
  audio.addEventListener("loadedmetadata", onLoadedMeta);
  audio.addEventListener("seeked", onSeeked);

  async function loadFile(file) {
    if (audioURL) URL.revokeObjectURL(audioURL);
    audioURL = URL.createObjectURL(file);
    audio.src = audioURL;
    loop = null;
    let buf = null;
    try {
      buf = await file.arrayBuffer();
    } catch (e) {
      return;
    }
    const lyrics = extractEmbeddedLyrics(buf); // sync, before decodeAudioData detaches the buffer
    decode(buf);
    if (lyrics && hooks.onEmbeddedLyrics) hooks.onEmbeddedLyrics(lyrics, file.name);
  }

  function seek(seconds) {
    if (!audio.src || !isFinite(audio.duration)) return;
    audio.currentTime = Math.min(audio.duration, Math.max(0, seconds));
    updateTime();
    syncActive(true);
    hooks.onTick?.(audio.currentTime);
  }

  function toggle() {
    if (!audio.src) return;
    if (audio.paused) audio.play();
    else audio.pause();
  }

  function destroy() {
    stopLoop();
    playBtn.removeEventListener("click", onPlayClick);
    audio.removeEventListener("play", onPlay);
    audio.removeEventListener("pause", onPause);
    audio.removeEventListener("ended", onEnded);
    audio.removeEventListener("loadedmetadata", onLoadedMeta);
    audio.removeEventListener("seeked", onSeeked);
    try {
      audio.pause();
    } catch (_) {}
    if (audioURL) URL.revokeObjectURL(audioURL);
    if (audioCtx) audioCtx.close().catch(() => {});
  }

  return {
    loadFile,
    destroy,
    seek,
    toggle,
    play: () => audio.src && audio.play(),
    pause: () => audio.pause(),
    hasAudio: () => !!audio.src,
    isPlaying: () => !audio.paused,
    currentTime: () => audio.currentTime || 0,
    currentTimeMs: () => (audio.currentTime || 0) * 1000,
    duration: () => (isFinite(audio.duration) ? audio.duration : 0),
    setRate: (value) => {
      rate = value > 0 ? value : 1;
      audio.playbackRate = rate;
    },
    // Loop [start, end) seconds, or clear with null.
    setLoop: (range) => {
      loop = range && range.end > range.start ? range : null;
    },
    getLoop: () => loop,
    refreshSync: () => syncActive(true)
  };
}

// ── embedded lyrics: read lyric tags out of the audio file (no deps) ──
function synchsafe(u8, p) {
  return (u8[p] << 21) | (u8[p + 1] << 14) | (u8[p + 2] << 7) | u8[p + 3];
}
function readU32BE(u8, p) {
  return u8[p] * 16777216 + (u8[p + 1] << 16) + (u8[p + 2] << 8) + u8[p + 3];
}
function readU32LE(u8, p) {
  return u8[p] + (u8[p + 1] << 8) + (u8[p + 2] << 16) + u8[p + 3] * 16777216;
}
function tidy(s) {
  return s ? s.replace(/\r\n?/gu, "\n").trim() : "";
}
function decodeByEnc(bytes, enc) {
  let label = "utf-8";
  if (enc === 0) label = "iso-8859-1";
  else if (enc === 1) label = bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-16le";
  else if (enc === 2) label = "utf-16be";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch (e) {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
function descAndNext(u8, p, end, enc) {
  const start = p;
  let descEnd;
  if (enc === 1 || enc === 2) {
    while (p + 1 < end && !(u8[p] === 0 && u8[p + 1] === 0)) p += 2;
    descEnd = p;
    p += 2;
  } else {
    while (p < end && u8[p] !== 0) p += 1;
    descEnd = p;
    p += 1;
  }
  return { descBytes: u8.subarray(start, descEnd), next: p };
}
function isLyricKey(k) {
  k = k.toUpperCase();
  return k === "LYRICS" || k === "UNSYNCEDLYRICS" || k === "LYRICS:LRC";
}
function id3Lyrics(u8) {
  const major = u8[3];
  const flags = u8[5];
  const end = Math.min(u8.length, 10 + synchsafe(u8, 6));
  let pos = 10;
  if (flags & 0x40) {
    const extSize = major === 4 ? synchsafe(u8, pos) : readU32BE(u8, pos);
    pos += major === 4 ? extSize : 4 + extSize;
  }
  let fallback = null;
  while (pos + 10 <= end) {
    const id = String.fromCharCode(u8[pos], u8[pos + 1], u8[pos + 2], u8[pos + 3]);
    if (!/^[A-Z0-9]{4}$/u.test(id)) break;
    const fsize = major === 4 ? synchsafe(u8, pos + 4) : readU32BE(u8, pos + 4);
    const fstart = pos + 10;
    const fend = fstart + fsize;
    if (fsize <= 0 || fend > end) break;
    if (id === "USLT") {
      const enc = u8[fstart];
      const { next } = descAndNext(u8, fstart + 4, fend, enc);
      const text = tidy(decodeByEnc(u8.subarray(next, fend), enc));
      if (text) return text;
    } else if (id === "TXXX" && fallback === null) {
      const enc = u8[fstart];
      const { descBytes, next } = descAndNext(u8, fstart + 1, fend, enc);
      if (isLyricKey(decodeByEnc(descBytes, enc))) {
        const v = tidy(decodeByEnc(u8.subarray(next, fend), enc));
        if (v) fallback = v;
      }
    }
    pos = fend;
  }
  return fallback;
}
function parseVorbisComments(u8, start, end) {
  let p = start;
  p += 4 + readU32LE(u8, p);
  if (p + 4 > end) return null;
  const count = readU32LE(u8, p);
  p += 4;
  const dec = new TextDecoder("utf-8");
  for (let i = 0; i < count && p + 4 <= end; i++) {
    const len = readU32LE(u8, p);
    p += 4;
    if (len < 0 || p + len > end) break;
    const entry = dec.decode(u8.subarray(p, p + len));
    p += len;
    const eq = entry.indexOf("=");
    if (eq > 0 && isLyricKey(entry.slice(0, eq))) {
      const v = tidy(entry.slice(eq + 1));
      if (v) return v;
    }
  }
  return null;
}
function flacLyrics(u8) {
  let pos = 4;
  while (pos + 4 <= u8.length) {
    const header = u8[pos];
    const type = header & 0x7f;
    const len = (u8[pos + 1] << 16) | (u8[pos + 2] << 8) | u8[pos + 3];
    const start = pos + 4;
    if (type === 4) {
      const r = parseVorbisComments(u8, start, start + len);
      if (r) return r;
    }
    pos = start + len;
    if (header & 0x80) break;
  }
  return null;
}
function oggLyrics(u8) {
  for (let i = 0; i + 7 < u8.length; i++) {
    if (u8[i] === 0x03 && u8[i + 1] === 0x76 && u8[i + 2] === 0x6f && u8[i + 3] === 0x72 && u8[i + 4] === 0x62 && u8[i + 5] === 0x69 && u8[i + 6] === 0x73) {
      const r = parseVorbisComments(u8, i + 7, u8.length);
      if (r) return r;
    }
  }
  return null;
}
function mp4Lyrics(u8) {
  function dataText(start, end) {
    let p = start;
    while (p + 8 <= end) {
      const size = readU32BE(u8, p);
      const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
      if (size < 8) break;
      if (type === "data") {
        const txt = tidy(new TextDecoder("utf-8").decode(u8.subarray(p + 16, Math.min(end, p + size))));
        if (txt) return txt;
      }
      p += size;
    }
    return null;
  }
  function walk(start, end) {
    let p = start;
    while (p + 8 <= end) {
      let size = readU32BE(u8, p);
      let header = 8;
      const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
      if (size === 1) {
        size = readU32BE(u8, p + 12);
        header = 16;
      }
      if (size < header) break;
      const cs = p + header;
      const ce = Math.min(end, p + size);
      if (type === "©lyr") {
        const r = dataText(cs, ce);
        if (r) return r;
      } else if (type === "meta") {
        const r = walk(cs + 4, ce);
        if (r) return r;
      } else if (type === "moov" || type === "udta" || type === "ilst") {
        const r = walk(cs, ce);
        if (r) return r;
      }
      p += size;
    }
    return null;
  }
  return walk(0, u8.length);
}
export function extractEmbeddedLyrics(buf) {
  try {
    const u8 = new Uint8Array(buf);
    if (u8.length < 12) return null;
    if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) return id3Lyrics(u8);
    if (u8[0] === 0x66 && u8[1] === 0x4c && u8[2] === 0x61 && u8[3] === 0x43) return flacLyrics(u8);
    if (u8[0] === 0x4f && u8[1] === 0x67 && u8[2] === 0x67 && u8[3] === 0x53) return oggLyrics(u8);
    if (u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) return mp4Lyrics(u8);
    return null;
  } catch (e) {
    return null;
  }
}
