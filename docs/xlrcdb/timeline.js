// Zoomable timeline for the editor: a thin overview of the whole song (with the visible
// window as a draggable box) and a zoomed lane with a time ruler, the waveform, one region
// per lyric line, and draggable line markers. The two live in separate hosts so the overview
// can sit in the transport's control row.
//
// The lane is two canvases: "base" (ruler, regions, waveform, markers) redraws only when the
// view or the lines change; "over" (playhead, active line, hover, drag ghost) redraws every
// frame during playback.
//
// hooks: {
//   getDuration(): seconds, getTime(): seconds, isPlaying(): bool, seek(seconds),
//   getEntries(): [{ key, time (seconds), label, isEmpty }] sorted by time,
//   getActive(): index into getEntries() or -1, getLoop(): { start, end } | null,
//   onRetime(entry, seconds, phase: "move" | "end"), onPick(entry)
// }

const RULER = 16; // css px
const LABEL_ROOM = 44; // px a region needs before its label is drawn
const MIN_SPAN = 1.5; // seconds visible at maximum zoom
const HIT = 6; // px either side of a marker that grabs it
const TICK_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];

// hosts: { overview: element, lane: element }
export function createTimeline(hosts, hooks) {
  hosts.overview.innerHTML = '<canvas class="tl-overview" aria-label="Song overview, drag to scroll the timeline"></canvas>';
  hosts.lane.innerHTML = `
    <div class="tl-lane">
      <canvas class="tl-base"></canvas>
      <canvas class="tl-over"></canvas>
      <div class="tl-tip"></div>
    </div>`;
  const overview = hosts.overview.querySelector(".tl-overview");
  const lane = hosts.lane.querySelector(".tl-lane");
  const base = hosts.lane.querySelector(".tl-base");
  const over = hosts.lane.querySelector(".tl-over");
  const tip = hosts.lane.querySelector(".tl-tip");
  const ctx = { overview: overview.getContext("2d"), base: base.getContext("2d"), over: over.getContext("2d") };

  let peaks = null;
  let overviewCache = null; // { muted, played } offscreen canvases
  let view = { start: 0, span: 0 };
  let size = { w: 0, h: 0, ow: 0, oh: 0, dpr: 1 };
  let hover = null; // { x, entry }
  let drag = null;
  let lastUserView = 0;
  const colors = {};

  // ── geometry ──
  const duration = () => hooks.getDuration() || 0;
  const timeToX = (t) => ((t - view.start) / view.span) * size.w;
  const xToTime = (x) => view.start + (x / size.w) * view.span;

  function clampView() {
    const d = duration();
    if (!d) return;
    view.span = Math.min(Math.max(view.span || d, Math.min(MIN_SPAN, d)), d);
    view.start = Math.min(Math.max(view.start, 0), Math.max(0, d - view.span));
  }

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    colors.accent = v("--accent", "#38bdf8");
    colors.text = v("--text-primary", "#f0f0f0");
    colors.secondary = v("--text-secondary", "#9a9a9a");
    colors.muted = v("--text-muted", "#6a6a6a");
    colors.wave = v("--wave-muted", "#404040");
    colors.panel = v("--bg-panel", "#1c1c1c");
    colors.bg = v("--bg-primary", "#0f0f0f");
  }

  function fitCanvas(canvas, c, w, h) {
    canvas.width = Math.max(1, Math.round(w * size.dpr));
    canvas.height = Math.max(1, Math.round(h * size.dpr));
    c.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  }

  function resize() {
    size.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const laneRect = lane.getBoundingClientRect();
    const overRect = overview.getBoundingClientRect();
    size.w = laneRect.width;
    size.h = laneRect.height;
    size.ow = overRect.width;
    size.oh = overRect.height;
    fitCanvas(base, ctx.base, size.w, size.h);
    fitCanvas(over, ctx.over, size.w, size.h);
    fitCanvas(overview, ctx.overview, size.ow, size.oh);
    readColors();
    buildOverviewCache();
    clampView();
    drawAll();
  }

  // ── drawing ──
  function drawAll() {
    drawBase();
    drawOver();
    drawOverview();
  }

  // min/max of the peak buckets covering [t0, t1)
  function peakRange(t0, t1) {
    if (!peaks) return null;
    const b0 = Math.max(0, Math.floor(t0 * peaks.perSecond));
    const b1 = Math.min(peaks.max.length, Math.max(b0 + 1, Math.ceil(t1 * peaks.perSecond)));
    if (b0 >= peaks.max.length) return null;
    let lo = 0;
    let hi = 0;
    for (let b = b0; b < b1; b++) {
      if (peaks.min[b] < lo) lo = peaks.min[b];
      if (peaks.max[b] > hi) hi = peaks.max[b];
    }
    return [lo, hi];
  }

  function tickStep() {
    const pxPerSecond = size.w / view.span;
    return TICK_STEPS.find((step) => step * pxPerSecond >= 70) ?? TICK_STEPS[TICK_STEPS.length - 1];
  }

  function drawBase() {
    const c = ctx.base;
    const { w, h } = size;
    c.clearRect(0, 0, w, h);
    const d = duration();
    if (!d || !w) return;
    const entries = hooks.getEntries();

    // regions
    entries.forEach((entry, i) => {
      const end = entries[i + 1]?.time ?? d;
      const x0 = Math.max(0, timeToX(entry.time));
      const x1 = Math.min(w, timeToX(end));
      if (x1 <= 0 || x0 >= w) return;
      c.fillStyle = i % 2 ? "rgba(255,255,255,0.035)" : "rgba(255,255,255,0.015)";
      c.fillRect(x0, RULER, x1 - x0, h - RULER);
    });

    // waveform
    const mid = RULER + (h - RULER) / 2;
    const amp = (h - RULER) / 2 - 6;
    c.fillStyle = colors.wave;
    if (peaks) {
      for (let x = 0; x < w; x++) {
        const range = peakRange(xToTime(x), xToTime(x + 1));
        if (!range) break;
        const top = mid - range[1] * amp;
        c.fillRect(x, top, 1, Math.max(1, (range[1] - range[0]) * amp));
      }
    } else {
      c.fillRect(0, mid, w, 1);
    }

    // ruler
    c.fillStyle = "rgba(0,0,0,0.25)";
    c.fillRect(0, 0, w, RULER);
    const step = tickStep();
    const minor = step / 5;
    c.fillStyle = colors.muted;
    for (let t = Math.ceil(view.start / minor) * minor; t <= view.start + view.span; t += minor) {
      const x = Math.round(timeToX(t)) + 0.5;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      c.fillRect(x, major ? RULER - 7 : RULER - 3, 1, major ? 7 : 3);
    }
    c.font = "10px 'JetBrains Mono', monospace";
    c.textBaseline = "middle";
    for (let t = Math.ceil(view.start / step) * step; t <= view.start + view.span; t += step) {
      c.fillText(formatTick(t, step), Math.round(timeToX(t)) + 4, 7);
    }

    // markers + labels; packed markers are drawn fainter so the waveform stays readable
    c.font = "11px Inter, system-ui, sans-serif";
    const visible = entries.filter((entry) => entry.time >= view.start && entry.time <= view.start + view.span).length;
    const markerAlpha = visible && w / visible < 24 ? 0.22 : 0.42;
    entries.forEach((entry, i) => {
      const x = timeToX(entry.time);
      if (x < -200 || x > w + 2) return;
      const next = entries[i + 1] ? timeToX(entries[i + 1].time) : timeToX(d);
      c.fillStyle = `rgba(240,240,240,${markerAlpha})`;
      c.fillRect(Math.round(x), RULER, 1, h - RULER);
      c.fillRect(Math.round(x) - 2, RULER, 5, 3);
      const room = next - x - 10;
      if (room > LABEL_ROOM) {
        const text = entry.isEmpty ? "♪" : entry.label;
        const width = Math.min(room, c.measureText(text).width + 10);
        c.save();
        c.beginPath();
        c.rect(x + 3, RULER, room + 2, h - RULER);
        c.clip();
        // A dark tab behind the label keeps it readable over the waveform.
        c.fillStyle = "rgba(15,15,15,0.82)";
        c.fillRect(x + 3, RULER + 3, width, 15);
        c.fillStyle = entry.isEmpty ? colors.muted : colors.text;
        c.fillText(text, x + 8, RULER + 11);
        c.restore();
      }
    });
  }

  function drawOver() {
    const c = ctx.over;
    const { w, h } = size;
    c.clearRect(0, 0, w, h);
    const d = duration();
    if (!d || !w) return;
    const entries = hooks.getEntries();

    const loop = hooks.getLoop?.();
    if (loop) {
      const x0 = timeToX(loop.start);
      const x1 = timeToX(loop.end);
      c.fillStyle = "rgba(56,189,248,0.08)";
      c.fillRect(x0, 0, x1 - x0, h);
      c.fillStyle = colors.accent;
      c.fillRect(x0, 0, x1 - x0, 2);
    }

    const active = hooks.getActive();
    if (active >= 0 && entries[active]) {
      const x0 = timeToX(entries[active].time);
      const x1 = timeToX(entries[active + 1]?.time ?? d);
      c.fillStyle = "rgba(56,189,248,0.10)";
      c.fillRect(x0, RULER, x1 - x0, h - RULER);
    }

    const hot = drag?.kind === "marker" ? drag.entry : hover?.entry;
    if (hot) {
      const x = drag?.kind === "marker" ? timeToX(drag.time) : timeToX(hot.time);
      c.fillStyle = colors.accent;
      c.fillRect(Math.round(x) - 1, RULER, 3, h - RULER);
      c.fillRect(Math.round(x) - 4, RULER, 9, 4);
    } else if (hover) {
      c.fillStyle = "rgba(240,240,240,0.25)";
      c.fillRect(Math.round(hover.x), 0, 1, h);
    }

    const px = timeToX(hooks.getTime());
    if (px >= -2 && px <= w + 2) {
      c.fillStyle = colors.text;
      c.fillRect(Math.round(px) - 1, 0, 2, h);
      c.beginPath();
      c.moveTo(px - 5, 0);
      c.lineTo(px + 5, 0);
      c.lineTo(px, 7);
      c.closePath();
      c.fill();
    }
  }

  // Whole-song waveform in both colours, so a frame is two drawImage calls.
  function buildOverviewCache() {
    overviewCache = null;
    const d = duration();
    if (!peaks || !d || !size.ow) return;
    const make = (color) => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(size.ow * size.dpr);
      canvas.height = Math.round(size.oh * size.dpr);
      const c = canvas.getContext("2d");
      c.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
      c.fillStyle = color;
      const mid = size.oh / 2;
      for (let x = 0; x < size.ow; x++) {
        const range = peakRange((x / size.ow) * d, ((x + 1) / size.ow) * d);
        if (!range) break;
        const a = Math.max(-range[0], range[1]) * (size.oh / 2 - 1);
        c.fillRect(x, mid - a, 1, Math.max(1, a * 2));
      }
      return canvas;
    };
    overviewCache = { muted: make(colors.wave), played: make(colors.accent) };
  }

  function drawOverview() {
    const c = ctx.overview;
    const { ow, oh } = size;
    c.clearRect(0, 0, ow, oh);
    const d = duration();
    if (!d || !ow) return;
    const playX = (hooks.getTime() / d) * ow;
    if (overviewCache) {
      c.drawImage(overviewCache.muted, 0, 0, ow, oh);
      c.save();
      c.beginPath();
      c.rect(0, 0, playX, oh);
      c.clip();
      c.drawImage(overviewCache.played, 0, 0, ow, oh);
      c.restore();
    } else {
      c.fillStyle = colors.wave;
      c.fillRect(0, oh / 2, ow, 1);
    }
    c.fillStyle = "rgba(240,240,240,0.35)";
    for (const entry of hooks.getEntries()) c.fillRect(Math.round((entry.time / d) * ow), 0, 1, 4);
    const vx = (view.start / d) * ow;
    const vw = Math.max(3, (view.span / d) * ow);
    c.fillStyle = "rgba(255,255,255,0.07)";
    c.fillRect(vx, 0, vw, oh);
    c.strokeStyle = colors.secondary;
    c.lineWidth = 1;
    c.strokeRect(Math.round(vx) + 0.5, 0.5, Math.round(vw) - 1, oh - 1);
    c.fillStyle = colors.text;
    c.fillRect(Math.round(playX), 0, 1, oh);
  }

  // ── view changes ──
  function setView(start, span, byUser = true) {
    view = { start, span };
    clampView();
    if (byUser) lastUserView = performance.now();
    drawAll();
  }

  function zoomAround(t, factor) {
    const ratio = view.span ? (t - view.start) / view.span : 0.5;
    const span = view.span * factor;
    setView(t - ratio * span, span);
  }

  function follow() {
    if (!hooks.isPlaying() || drag || performance.now() - lastUserView < 2500) return;
    const t = hooks.getTime();
    if (t < view.start || t > view.start + view.span * 0.9) {
      view.start = t - view.span * 0.1;
      clampView();
      drawBase();
    }
  }

  // ── hit testing ──
  function markerAt(x) {
    let best = null;
    let bestDist = HIT + 1;
    for (const entry of hooks.getEntries()) {
      const dist = Math.abs(timeToX(entry.time) - x);
      if (dist < bestDist) {
        best = entry;
        bestDist = dist;
      }
    }
    return best;
  }

  function regionAt(t) {
    const entries = hooks.getEntries();
    let found = null;
    for (const entry of entries) {
      if (entry.time <= t) found = entry;
      else break;
    }
    return found;
  }

  function showTip(x) {
    const t = xToTime(x);
    const region = regionAt(t);
    const label = hover?.entry
      ? `Drag to retime · ${formatTime(hover.entry.time)}`
      : `${formatTime(t)}${region && !region.isEmpty ? `  ·  ${truncate(region.label, 36)}` : ""}`;
    tip.textContent = drag?.kind === "marker" ? formatTime(drag.time) : label;
    tip.style.left = `${Math.min(Math.max(x, 40), size.w - 40)}px`;
    tip.style.display = "block";
  }

  // ── lane interaction ──
  function laneX(e) {
    return e.clientX - lane.getBoundingClientRect().left;
  }

  function onLaneDown(e) {
    if (!duration() || e.button !== 0) return;
    const x = laneX(e);
    lane.setPointerCapture(e.pointerId);
    const hit = markerAt(x);
    if (hit) {
      drag = { kind: "marker", entry: hit, key: hit.key, time: hit.time, moved: false };
    } else {
      drag = { kind: "scrub" };
      hooks.seek(xToTime(x));
    }
    drawOver();
  }

  function onLaneMove(e) {
    const x = laneX(e);
    if (drag?.kind === "marker") {
      drag.time = Math.min(Math.max(xToTime(x), 0), duration());
      drag.moved = true;
      hooks.onRetime(drag.entry, drag.time, "move");
      // The editor re-rendered; pick the same line back up by key.
      drag.entry = hooks.getEntries().find((entry) => entry.key === drag.key) ?? drag.entry;
      showTip(x);
      drawOver();
      return;
    }
    if (drag?.kind === "scrub") {
      hooks.seek(xToTime(x));
      return;
    }
    hover = { x, entry: markerAt(x) };
    lane.style.cursor = hover.entry ? "ew-resize" : "crosshair";
    showTip(x);
    drawOver();
  }

  function onLaneUp(e) {
    try {
      lane.releasePointerCapture(e.pointerId);
    } catch (_) {}
    if (drag?.kind === "marker" && drag.moved) hooks.onRetime(drag.entry, drag.time, "end");
    drag = null;
    drawOver();
  }

  function onLaneLeave() {
    if (drag) return;
    hover = null;
    tip.style.display = "none";
    drawOver();
  }

  function onLaneDblClick(e) {
    const region = regionAt(xToTime(laneX(e)));
    if (region) hooks.onPick(region);
  }

  // Vertical wheel / pinch zooms around the cursor; horizontal scroll (or Shift) pans.
  function onWheel(e) {
    if (!duration()) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? size.w : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
      const delta = e.shiftKey && !dx ? dy : dx;
      setView(view.start + (delta / size.w) * view.span, view.span);
    } else {
      zoomAround(xToTime(laneX(e)), Math.exp(dy * (e.ctrlKey ? 0.012 : 0.0025)));
    }
  }

  // ── overview interaction ──
  function overviewTime(e) {
    const rect = overview.getBoundingClientRect();
    return Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1) * duration();
  }

  function onOverviewDown(e) {
    if (!duration() || e.button !== 0) return;
    overview.setPointerCapture(e.pointerId);
    const t = overviewTime(e);
    if (t >= view.start && t <= view.start + view.span) {
      drag = { kind: "pan", grab: t - view.start };
    } else {
      drag = { kind: "pan", grab: view.span / 2 };
      setView(t - view.span / 2, view.span);
      hooks.seek(t);
    }
  }

  function onOverviewMove(e) {
    if (drag?.kind !== "pan") return;
    setView(overviewTime(e) - drag.grab, view.span);
  }

  function onOverviewUp(e) {
    try {
      overview.releasePointerCapture(e.pointerId);
    } catch (_) {}
    if (drag?.kind === "pan") drag = null;
  }

  lane.addEventListener("pointerdown", onLaneDown);
  lane.addEventListener("pointermove", onLaneMove);
  lane.addEventListener("pointerup", onLaneUp);
  lane.addEventListener("pointercancel", onLaneUp);
  lane.addEventListener("pointerleave", onLaneLeave);
  lane.addEventListener("dblclick", onLaneDblClick);
  lane.addEventListener("wheel", onWheel, { passive: false });
  overview.addEventListener("pointerdown", onOverviewDown);
  overview.addEventListener("pointermove", onOverviewMove);
  overview.addEventListener("pointerup", onOverviewUp);
  window.addEventListener("resize", resize);

  return {
    resize,
    setPeaks(next) {
      peaks = next;
      buildOverviewCache();
      drawAll();
    },
    // New song length: show all of it.
    reset() {
      view = { start: 0, span: duration() };
      clampView();
      drawAll();
    },
    // Lines changed (typing, stamping, dragging).
    refresh() {
      drawBase();
      drawOver();
      drawOverview();
    },
    // Every playback frame and after seeks.
    tick() {
      follow();
      drawOver();
      drawOverview();
    },
    zoomIn: () => zoomAround(hooks.isPlaying() ? hooks.getTime() : view.start + view.span / 2, 0.5),
    zoomOut: () => zoomAround(view.start + view.span / 2, 2),
    fit: () => setView(0, duration()),
    // Bring a time into view without changing the zoom.
    reveal(t) {
      if (t < view.start || t > view.start + view.span) setView(t - view.span * 0.25, view.span, false);
    },
    destroy() {
      window.removeEventListener("resize", resize);
    }
  };
}

function formatTime(seconds) {
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

function formatTick(t, step) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const digits = step < 0.1 ? 2 : step < 1 ? 1 : 0;
  return `${m}:${s.toFixed(digits).padStart(digits ? 3 + digits : 2, "0")}`;
}

function truncate(text, n) {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}
