// Shared XLRC presentation helpers, ported from the standalone editor
// (docs/xlrc/editor/index.html) so the xlrcdb editor preview and the browse
// track view render identically: syntax colouring, furigana ruby, voice pills.

export const KANA = /^[぀-ゟ゠-ヿㇰ-ㇿｦ-ﾟ]+$/u;

export const LANG_LABELS = {
  en: "English",
  "ja-Latn": "Romaji",
  ja: "日本語",
  ko: "한국어",
  "zh-Hans": "简体",
  "zh-Hant": "繁體",
  "zh-Latn": "Pinyin",
  es: "Español",
  fr: "Français"
};

export function formatPlaybackTime(sec) {
  let safe = Number(sec);
  if (!Number.isFinite(safe) || safe < 0) safe = 0;
  const totalCentis = Math.floor(safe * 100);
  const minutes = Math.floor(totalCentis / 6000);
  const seconds = Math.floor((totalCentis % 6000) / 100);
  const centis = totalCentis % 100;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

export function mapScrollOffset(
  sourceOffset,
  sourceScrollSize,
  sourceClientSize,
  targetScrollSize,
  targetClientSize
) {
  const sourceRange = Math.max(0, sourceScrollSize - sourceClientSize);
  const targetRange = Math.max(0, targetScrollSize - targetClientSize);
  if (!sourceRange || !targetRange) return 0;
  const ratio = Math.min(1, Math.max(0, sourceOffset / sourceRange));
  return ratio * targetRange;
}

// Deterministic colour per voice label (stable across renders).
export function voiceColor(label) {
  let h = 0;
  for (const ch of label) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 70% 62%)`;
}

function span(cls, text) {
  const s = document.createElement("span");
  if (cls) s.className = cls;
  s.textContent = text;
  return s;
}

function colorizeBody(frag, body) {
  let i = 0;
  while (i < body.length) {
    if (body[i] === "<") {
      const close = body.indexOf(">", i + 1);
      if (close !== -1 && /^<\d+:\d{2}\.\d{2}>$/u.test(body.slice(i, close + 1))) {
        frag.appendChild(span("t-time", body.slice(i, close + 1)));
        i = close + 1;
        continue;
      }
    }
    if (body[i] === "[") {
      const close = body.indexOf("]", i + 1);
      const prev = body[i - 1];
      if (close !== -1 && prev && !/\s/u.test(prev) && KANA.test(body.slice(i + 1, close))) {
        frag.appendChild(span("t-furi", body.slice(i, close + 1)));
        i = close + 1;
        continue;
      }
    }
    let j = i + 1;
    while (j < body.length && body[j] !== "<" && body[j] !== "[") j++;
    frag.appendChild(document.createTextNode(body.slice(i, j)));
    i = j;
  }
}

// Returns a DocumentFragment of coloured spans for one raw source line.
export function colorizeLine(raw) {
  const frag = document.createDocumentFragment();
  if (raw.trim() === "") return frag;
  if (/^\[[A-Za-z][\w-]*:[^\]]*\]$/u.test(raw)) {
    frag.appendChild(span("t-tag", raw));
    return frag;
  }
  let m = raw.match(/^(\[>[^\]]+\])(.*)$/u);
  if (m) {
    frag.appendChild(span("t-tr", m[1]));
    colorizeBody(frag, m[2]);
    return frag;
  }
  m = raw.match(/^(\[\d+:\d{2}\.\d{2}\])(.*)$/u);
  if (m) {
    frag.appendChild(span("t-time", m[1]));
    colorizeBody(frag, m[2]);
    return frag;
  }
  frag.appendChild(document.createTextNode(raw));
  return frag;
}

// Paint the highlight overlay that sits behind the textarea caret.
export function buildHighlight(highlightEl, text, warnLines) {
  const parts = text.split(/\r?\n/u);
  highlightEl.textContent = "";
  for (let i = 0; i < parts.length; i++) {
    const lineSpan = document.createElement("span");
    lineSpan.className = warnLines.has(i + 1) ? "hl-line err" : "hl-line";
    lineSpan.appendChild(colorizeLine(parts[i]));
    highlightEl.appendChild(lineSpan);
  }
}

function renderFurigana(parent, text, furigana) {
  const ranges = [...(furigana || [])].sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const f of ranges) {
    if (f.start < cursor) continue;
    if (f.start > cursor) parent.appendChild(document.createTextNode(text.slice(cursor, f.start)));
    const ruby = document.createElement("ruby");
    ruby.appendChild(document.createTextNode(f.base));
    const rt = document.createElement("rt");
    rt.textContent = f.reading;
    ruby.appendChild(rt);
    parent.appendChild(ruby);
    cursor = f.end;
  }
  if (cursor < text.length) parent.appendChild(document.createTextNode(text.slice(cursor)));
}

export function detectedLangs(parsed) {
  const set = new Set();
  for (const l of parsed.lines) for (const t of l.translations) set.add(t.lang);
  for (const l of parsed.meta.langs || []) set.add(l);
  return [...set];
}

// Build the scrolling lyric list (used by the editor preview and track view).
// activeLang === "" shows every translation; otherwise only the chosen one.
// Returns the created line elements (index-aligned with parsed.lines) so a
// caller can drive active-line highlighting.
export function renderLyrics(container, parsed, activeLang = "", { showAll = false } = {}) {
  container.textContent = "";
  const lineEls = [];
  if (!parsed.lines.length) {
    const empty = document.createElement("div");
    empty.className = "render-empty";
    empty.textContent = "No timed lines yet. Add a [mm:ss.xx] line.";
    container.appendChild(empty);
    return lineEls;
  }

  parsed.lines.forEach((line) => {
    const el = document.createElement("div");
    el.className = "rline";

    const main = document.createElement("div");
    main.className = "rline-main";
    if (line.voice) {
      const pill = document.createElement("span");
      pill.className = "voice-pill";
      pill.textContent = line.voice;
      pill.style.color = voiceColor(line.voice);
      main.appendChild(pill);
    }
    const text = document.createElement("div");
    text.className = "rline-text";
    if (line.isEmpty) {
      text.classList.add("empty");
      text.textContent = "·";
    } else {
      renderFurigana(text, line.text, line.furigana);
    }
    main.appendChild(text);
    el.appendChild(main);

    const translations = showAll || !activeLang
      ? line.translations
      : line.translations.filter((t) => t.lang === activeLang);
    for (const tr of translations) {
      const trEl = document.createElement("div");
      trEl.className = "rline-tr";
      if (showAll || !activeLang) {
        const tag = document.createElement("span");
        tag.className = "rline-tr-lang";
        tag.textContent = LANG_LABELS[tr.lang] || tr.lang;
        trEl.appendChild(tag);
      }
      trEl.appendChild(document.createTextNode(tr.text));
      el.appendChild(trEl);
    }

    container.appendChild(el);
    lineEls.push(el);
  });

  return lineEls;
}

// Format milliseconds back into the [mm:ss.xx] timestamp body used by XLRC.
export function formatTimestamp(ms) {
  const total = Math.max(0, ms);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const centis = Math.floor((total % 1000) / 10);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}
