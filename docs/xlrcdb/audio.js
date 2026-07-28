// Audio engine for the editor: waveform, playback, scrubber, line markers,
// loudness normalization, and embedded-lyric extraction. Ported from the
// standalone editor and wrapped in a factory so the editor can mount/destroy it.
//
// els:   { audio, scrub, wave, markers, playhead, scrubTip, playBtn, time }
// hooks: { getLines(): line[], getOffset(): ms, onActiveLine(idx), onDuration(sec), onEmbeddedLyrics(text, name) }

import { formatPlaybackTime } from "./render.js";

export function createAudioEngine(els, hooks) {
  const { audio, scrub, wave, markers, playhead, scrubTip, playBtn, time } = els;
  const waveCtx = wave.getContext("2d");
  const prefersReduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let peaks = null;
  let audioCtx = null;
  let mediaSrc = null;
  let gainNode = null;
  let normGain = 1;
  let rate = 1;
  let audioURL = null;
  let activeIdx = -1;
  let rafId = 0;
  let scrubbing = false;
  const waveColors = { accent: "#38bdf8", muted: "#404040" };

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

  function refreshWaveColors() {
    const cs = getComputedStyle(document.documentElement);
    waveColors.accent = cs.getPropertyValue("--accent").trim() || waveColors.accent;
    waveColors.muted = cs.getPropertyValue("--wave-muted").trim() || waveColors.muted;
  }
  function resizeWave() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = wave.getBoundingClientRect();
    wave.width = Math.max(1, Math.round(r.width * dpr));
    wave.height = Math.max(1, Math.round(r.height * dpr));
  }
  function drawWave() {
    const w = wave.width;
    const h = wave.height;
    waveCtx.clearRect(0, 0, w, h);
    const d = audio.duration || 0;
    const playX = d ? (audio.currentTime / d) * w : 0;
    if (!peaks) {
      waveCtx.fillStyle = waveColors.muted;
      waveCtx.fillRect(0, h / 2 - 1, w, 2);
      return;
    }
    const n = peaks.length;
    const step = w / n;
    const bw = Math.max(1, step * 0.6);
    for (let i = 0; i < n; i++) {
      const cx = i * step + step / 2;
      const barH = Math.max(2, peaks[i] * h * 0.92);
      waveCtx.fillStyle = cx <= playX ? waveColors.accent : waveColors.muted;
      waveCtx.fillRect(cx - bw / 2, (h - barH) / 2, bw, barH);
    }
  }
  async function buildWaveform(buf) {
    peaks = null;
    normGain = 1;
    applyGain();
    resizeWave();
    drawWave();
    let tmpCtx = null;
    try {
      ensureGraph();
      const ctx = audioCtx || (tmpCtx = new (window.AudioContext || window.webkitAudioContext)());
      const audioBuf = await ctx.decodeAudioData(buf);
      const ch = audioBuf.getChannelData(0);
      const N = 360;
      const block = Math.max(1, Math.floor(ch.length / N));
      const p = new Float32Array(N);
      let max = 0;
      let gPeak = 0;
      let gSum = 0;
      let gCount = 0;
      for (let i = 0; i < N; i++) {
        let sum = 0;
        const start = i * block;
        for (let j = 0; j < block; j++) {
          const v = ch[start + j] || 0;
          const a = v < 0 ? -v : v;
          if (a > gPeak) gPeak = a;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / block);
        p[i] = rms;
        if (rms > max) max = rms;
        gSum += sum;
        gCount += block;
      }
      if (max > 0) for (let i = 0; i < N; i++) p[i] /= max;
      peaks = p;
      const measuredRMS = gCount ? Math.sqrt(gSum / gCount) : 0;
      if (measuredRMS > 0) {
        const TARGET_RMS = 0.1;
        const CEILING = 0.97;
        let g = TARGET_RMS / measuredRMS;
        if (gPeak > 0) g = Math.min(g, CEILING / gPeak);
        normGain = Math.max(0.1, Math.min(g, 4));
      }
      applyGain();
    } catch (e) {
      peaks = null;
    } finally {
      if (tmpCtx) tmpCtx.close();
    }
    resizeWave();
    drawWave();
  }

  function resolveActive(ms) {
    const lines = hooks.getLines();
    let lo = 0;
    let hi = lines.length - 1;
    let res = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].timestamp <= ms) {
        res = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return res;
  }
  function syncActive(force) {
    const lines = hooks.getLines();
    if (!lines.length) {
      if (activeIdx !== -1) {
        activeIdx = -1;
        hooks.onActiveLine(-1);
      }
      return;
    }
    const ms = audio.currentTime * 1000 - (hooks.getOffset() || 0);
    const idx = resolveActive(ms);
    if (idx === activeIdx && !force) return;
    activeIdx = idx;
    updateTickActive(idx);
    hooks.onActiveLine(idx);
  }

  function updateScrub() {
    const d = audio.duration || 0;
    const cur = audio.currentTime || 0;
    playhead.style.left = `${d ? (cur / d) * 100 : 0}%`;
    time.textContent = `${formatPlaybackTime(cur)} / ${formatPlaybackTime(d)}`;
    drawWave();
  }
  function renderMarkers() {
    markers.textContent = "";
    const d = audio.duration;
    const lines = hooks.getLines();
    if (!d || !lines.length) return;
    const dMs = d * 1000;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].timestamp;
      if (t > dMs) continue;
      const mk = document.createElement("div");
      mk.className = "mk";
      mk.style.left = `${(t / dMs) * 100}%`;
      mk.dataset.idx = i;
      markers.appendChild(mk);
    }
    updateTickActive(activeIdx);
  }
  function updateTickActive(idx) {
    for (const mk of markers.children) {
      const i = Number(mk.dataset.idx);
      mk.classList.toggle("active", i === idx);
      mk.classList.toggle("passed", i < idx);
    }
  }
  function seekToClientX(clientX) {
    const r = scrub.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    if (audio.duration) audio.currentTime = ratio * audio.duration;
    updateScrub();
    syncActive(true);
  }
  function showTip(clientX) {
    const d = audio.duration || 0;
    const lines = hooks.getLines();
    if (!d || !lines.length) {
      scrubTip.style.display = "none";
      return;
    }
    const r = scrub.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    const idx = resolveActive(ratio * d * 1000);
    const line = idx >= 0 ? lines[idx] : lines[0];
    const label = !line || line.isEmpty ? "instrumental" : line.text;
    scrubTip.textContent = `${formatPlaybackTime((line ? line.timestamp : 0) / 1000)}  ·  ${label.length > 40 ? `${label.slice(0, 39)}…` : label}`;
    scrubTip.style.left = `${ratio * 100}%`;
    scrubTip.style.display = "block";
  }

  function loop() {
    updateScrub();
    syncActive(false);
    rafId = requestAnimationFrame(loop);
  }
  function startLoop() {
    if (!rafId) rafId = requestAnimationFrame(loop);
  }
  function stopLoop() {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  // ── events ──
  const onPlayClick = () => {
    if (!audio.src) return;
    if (audio.paused) audio.play();
    else audio.pause();
  };
  const onPlay = () => {
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    playBtn.classList.add("playing");
    startLoop();
  };
  const onPause = () => {
    playBtn.classList.remove("playing");
    stopLoop();
    updateScrub();
  };
  const onEnded = () => {
    playBtn.classList.remove("playing");
    stopLoop();
  };
  const onLoadedMeta = () => {
    audio.playbackRate = rate; // a new source resets the rate; re-apply it
    resizeWave();
    renderMarkers();
    updateScrub();
    if (isFinite(audio.duration)) hooks.onDuration(audio.duration);
  };
  const onSeeked = () => {
    updateScrub();
    syncActive(true);
  };
  const onPointerDown = (e) => {
    if (!audio.src) return;
    scrubbing = true;
    scrub.setPointerCapture(e.pointerId);
    seekToClientX(e.clientX);
  };
  const onPointerMove = (e) => {
    if (scrubbing) seekToClientX(e.clientX);
    else showTip(e.clientX);
  };
  const onPointerUp = (e) => {
    scrubbing = false;
    try {
      scrub.releasePointerCapture(e.pointerId);
    } catch (_) {}
  };
  const onPointerLeave = () => {
    scrubTip.style.display = "none";
  };
  const onResize = () => {
    resizeWave();
    drawWave();
  };

  playBtn.addEventListener("click", onPlayClick);
  audio.addEventListener("play", onPlay);
  audio.addEventListener("pause", onPause);
  audio.addEventListener("ended", onEnded);
  audio.addEventListener("loadedmetadata", onLoadedMeta);
  audio.addEventListener("seeked", onSeeked);
  scrub.addEventListener("pointerdown", onPointerDown);
  scrub.addEventListener("pointermove", onPointerMove);
  scrub.addEventListener("pointerup", onPointerUp);
  scrub.addEventListener("pointerleave", onPointerLeave);
  window.addEventListener("resize", onResize);

  refreshWaveColors();
  resizeWave();
  drawWave();

  async function loadFile(file) {
    if (audioURL) URL.revokeObjectURL(audioURL);
    audioURL = URL.createObjectURL(file);
    audio.src = audioURL;
    let buf = null;
    try {
      buf = await file.arrayBuffer();
    } catch (e) {
      return;
    }
    const lyrics = extractEmbeddedLyrics(buf); // sync, before decodeAudioData detaches the buffer
    buildWaveform(buf);
    if (lyrics && hooks.onEmbeddedLyrics) hooks.onEmbeddedLyrics(lyrics, file.name);
  }

  function destroy() {
    stopLoop();
    playBtn.removeEventListener("click", onPlayClick);
    audio.removeEventListener("play", onPlay);
    audio.removeEventListener("pause", onPause);
    audio.removeEventListener("ended", onEnded);
    audio.removeEventListener("loadedmetadata", onLoadedMeta);
    audio.removeEventListener("seeked", onSeeked);
    scrub.removeEventListener("pointerdown", onPointerDown);
    scrub.removeEventListener("pointermove", onPointerMove);
    scrub.removeEventListener("pointerup", onPointerUp);
    scrub.removeEventListener("pointerleave", onPointerLeave);
    window.removeEventListener("resize", onResize);
    try {
      audio.pause();
    } catch (_) {}
    if (audioURL) URL.revokeObjectURL(audioURL);
    if (audioCtx) audioCtx.close().catch(() => {});
  }

  return {
    loadFile,
    destroy,
    hasAudio: () => !!audio.src,
    currentTimeMs: () => audio.currentTime * 1000,
    setRate: (value) => {
      rate = value > 0 ? value : 1;
      audio.playbackRate = rate;
    },
    refreshMarkers: renderMarkers,
    refreshSync: () => syncActive(true),
    resize: onResize
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
