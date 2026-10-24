// The pre-submit review sheet: what's about to be sent, anything worth fixing first, a
// required rights acknowledgement, then the submission's progress and result in place.
//
// summarizeSubmission() is pure (unit-tested). createReviewSheet() owns the dialog:
//   hooks: { onConfirm({ newArtist }), onGoFix(issue), onClose() }
//   open(data), setProgress(kind, message, result?), close(), isOpen()

import { findUntimedLines } from "./editor-validation.js";
import { languageName } from "./languages.js";
import { DATA_REPO, DATA_REPO_URL } from "./data.js";

const LEGAL_URL = `${DATA_REPO_URL}/blob/main/LEGAL.md`;

// The submission checklist. github.js reports progress with these keys plus a technical
// detail (login, branch, file path, PR number) that's shown beside each label.
const STEPS = [
  { key: "account", label: "Checking your GitHub account" },
  { key: "fork", label: "Preparing your copy of xlrcdb" },
  { key: "branch", label: "Creating a branch for this change" },
  { key: "commit", label: "Uploading the lyrics" },
  { key: "pr", label: "Opening the pull request" }
];

// ISO 15924 script codes (what Intl.Locale reports) to Unicode script properties. Combined
// codes cover the writing systems that mix scripts.
const UNICODE_SCRIPTS = {
  Latn: ["Latin"], Cyrl: ["Cyrillic"], Grek: ["Greek"], Arab: ["Arabic"], Hebr: ["Hebrew"],
  Thai: ["Thai"], Deva: ["Devanagari"], Beng: ["Bengali"], Taml: ["Tamil"], Telu: ["Telugu"],
  Knda: ["Kannada"], Mlym: ["Malayalam"], Gujr: ["Gujarati"], Guru: ["Gurmukhi"],
  Sinh: ["Sinhala"], Ethi: ["Ethiopic"], Geor: ["Georgian"], Armn: ["Armenian"],
  Khmr: ["Khmer"], Laoo: ["Lao"], Mymr: ["Myanmar"], Tibt: ["Tibetan"],
  Hang: ["Hangul"], Hira: ["Hiragana"], Kana: ["Katakana"], Hani: ["Han"],
  Jpan: ["Han", "Hiragana", "Katakana"], Kore: ["Hangul", "Han"], Hans: ["Han"], Hant: ["Han"]
};

// The script a translation language is written in ("en" -> Latn, "ko" -> Kore,
// "ja-Latn" -> Latn), as a letter-matching regex; null when unknown.
export function translationScript(tag) {
  try {
    const script = new Intl.Locale(tag).maximize().script;
    const names = script && UNICODE_SCRIPTS[script];
    if (!names) return null;
    return { code: script, test: new RegExp(`[${names.map((name) => `\\p{Script=${name}}`).join("")}]`, "u") };
  } catch {
    return null;
  }
}

// Is most of the line's lettering already in that script?
function writtenIn(text, script) {
  let letters = 0;
  let matching = 0;
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    letters++;
    if (script.test.test(ch)) matching++;
  }
  return letters === 0 || matching / letters >= 0.5;
}

// What the reviewer needs to know about the lyrics themselves.
export function summarizeSubmission(parsed, source) {
  const seen = new Set();
  const lines = [];
  for (const line of parsed?.lines ?? []) {
    if (seen.has(line.line)) continue; // multi-timestamp lines count once
    seen.add(line.line);
    lines.push(line);
  }
  const lyrics = lines.filter((line) => !line.isEmpty);
  const gaps = lines.filter((line) => line.isEmpty);
  // Coverage per translation language. A line only needs a translation into a language
  // when it isn't already written in that language's script (an English line needs no
  // [>en]; a romaji [>ja-Latn] is only expected on lines in Japanese script). When every
  // line shares the script (English lyrics, Spanish translation) all lines count.
  const langs = [...new Set(lyrics.flatMap((line) => line.translations.filter((t) => t.text.trim()).map((t) => t.lang)))];
  const translations = langs.map((lang) => {
    const script = translationScript(lang);
    let pool = script ? lyrics.filter((line) => !writtenIn(line.text, script)) : lyrics;
    const byScript = pool.length > 0 && pool.length < lyrics.length;
    if (!pool.length) pool = lyrics;
    const has = (line) => line.translations.some((t) => t.lang === lang && t.text.trim());
    const count = pool.filter(has).length;
    const firstMissing = pool.find((line) => !has(line))?.line ?? 0;
    return { lang, count, total: pool.length, script: byScript ? script.code : null, firstMissing };
  });
  const voices = [...new Set(lyrics.map((line) => line.voice).filter(Boolean))];
  // Every timestamp counts here, including a chorus line's repeats.
  const last = (parsed?.lines ?? []).reduce((max, line) => Math.max(max, line.timestamp), 0);
  return {
    lyricLines: lyrics.length,
    untimed: findUntimedLines(source).length,
    gaps: gaps.length,
    endsAt: lines.length ? last : null,
    translations,
    furigana: lyrics.some((line) => line.furigana.length > 0),
    wordTiming: lyrics.some((line) => line.words.length > 0),
    voices
  };
}

export function createReviewSheet(host, hooks) {
  let data = null;
  let phase = "closed"; // review | working | done | error
  let lastFocus = null;

  host.className = "rv-backdrop";
  host.hidden = true;
  host.addEventListener("click", onClick);
  host.addEventListener("input", onInput);
  host.addEventListener("keydown", onKeydown);

  function open(next) {
    data = { ...next, active: null, details: {}, headline: "", result: null, error: null, lockHeight: 0 };
    phase = "review";
    lastFocus = document.activeElement;
    host.hidden = false;
    render();
    host.querySelector(".rv-sheet")?.focus({ preventScroll: true });
  }

  function close() {
    if (phase === "working") return; // a submission in flight finishes first
    phase = "closed";
    host.hidden = true;
    host.innerHTML = "";
    lastFocus?.focus?.({ preventScroll: true });
    hooks.onClose?.();
  }

  // Mirrors the editor's submit lifecycle. Busy updates carry { step, detail } for the
  // checklist; a busy message without a step (a sign-in redirect) becomes the headline.
  function setProgress(kind, message, info = {}) {
    if (phase === "closed") return;
    if (kind === "busy") {
      phase = "working";
      if (info.step) {
        data.active = info.step;
        if (info.detail) data.details[info.step] = info.detail;
      } else if (message) {
        data.headline = message;
      }
    } else if (kind === "done") {
      phase = "done";
      data.result = info;
    } else if (kind === "idle" && message) {
      phase = "error";
      data.error = message;
    }
    render();
  }

  function onClick(e) {
    if (e.target === host && phase !== "working") return close();
    const action = e.target.closest("[data-rv]")?.dataset.rv;
    if (!action) return;
    if (action === "close") close();
    else if (action === "confirm") confirm();
    else if (action === "back") {
      phase = "review";
      data.error = null;
      data.lockHeight = 0;
      render();
    } else if (action === "fix") {
      const issue = data.warnings[Number(e.target.closest("[data-rv]").dataset.index)];
      close();
      if (issue) hooks.onGoFix(issue);
    } else if (action === "line") {
      const line = Number(e.target.closest("[data-rv]").dataset.line);
      close();
      if (line) hooks.onGoFix({ line });
    }
  }

  function onInput(e) {
    if (e.target.id === "rvRights") {
      host.querySelector('[data-rv="confirm"]').disabled = !e.target.checked;
      data.rights = e.target.checked;
    } else if (e.target.id === "rvLatin") {
      data.newArtist.latin = e.target.value;
    } else if (e.target.id === "rvPron") {
      data.newArtist.pronunciation = e.target.value;
    }
  }

  function onKeydown(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  }

  function confirm() {
    if (!data.rights) return;
    // Keep the review's size for the whole submission, so nothing resizes or re-centers.
    data.lockHeight = host.querySelector(".rv-sheet")?.getBoundingClientRect().height || 0;
    phase = "working";
    data.active = null;
    data.details = {};
    data.headline = "";
    data.error = null;
    data.result = null;
    render();
    hooks.onConfirm({ newArtist: data.newArtist });
  }

  function render() {
    const d = data;
    const title = escapeHtml(d.title || "Untitled");
    const sub = [d.artist, d.length].filter(Boolean).map(escapeHtml).join(" · ");
    host.innerHTML = `
      <div class="rv-sheet" role="dialog" aria-modal="true" aria-labelledby="rvTitle" tabindex="-1"${d.lockHeight && phase !== "review" ? ` style="min-height:${d.lockHeight}px"` : ""}>
        <header class="rv-head">
          <div>
            <p class="rv-eyebrow">${d.mode === "edit" ? "Review your edit" : "Review your submission"}</p>
            <h2 id="rvTitle">${title}</h2>
            ${sub ? `<p class="rv-sub">${sub}</p>` : ""}
          </div>
          ${phase === "working" ? "" : '<button class="rv-close" type="button" data-rv="close" aria-label="Close">×</button>'}
        </header>
        ${d.simulate ? '<div class="rv-sim"><strong>Simulation.</strong> Nothing is sent to GitHub; the steps are played back so you can see the flow.</div>' : ""}
        <div class="rv-body">${phase === "review" ? reviewBody(d) : progressBody(d, phase)}</div>
        <footer class="rv-foot">${phase === "review" ? reviewFoot(d) : progressFoot(d, phase)}</footer>
      </div>`;
  }

  return { open, close, setProgress, isOpen: () => phase !== "closed" };
}

function reviewBody(d) {
  const s = d.summary;
  const artist = d.artistResolution?.status === "existing"
    ? `<span class="rv-chip ok">Existing artist</span>`
    : `<span class="rv-chip new">New artist</span>`;
  const newArtistFields = d.artistResolution?.status === "new" && d.mode !== "edit" ? `
      <div class="rv-newartist">
        <p>xlrcdb will create <strong>${escapeHtml(d.artist)}</strong> as a new artist. Optional details:</p>
        <label><span>Name in Latin letters</span><input id="rvLatin" type="text" value="${escapeHtml(d.newArtist.latin)}" placeholder="e.g. Kamellia"></label>
        <label><span>Pronunciation</span><input id="rvPron" type="text" value="${escapeHtml(d.newArtist.pronunciation)}" placeholder="optional"></label>
      </div>` : "";

  const langs = d.langs.map((tag) => {
    const name = languageName(tag) || tag;
    const primary = tag.toLowerCase() === (d.lang || "").toLowerCase();
    return `<span class="rv-chip">${escapeHtml(name)}${primary ? " <em>primary</em>" : ""}</span>`;
  }).join("");

  const timing = s.untimed
    ? `${s.lyricLines} of ${s.lyricLines + s.untimed} lines timed`
    : `All ${s.lyricLines} ${s.lyricLines === 1 ? "line" : "lines"} timed`;
  const ends = s.endsAt !== null ? ` · ends at ${formatClock(s.endsAt)}` : "";

  // One row per translation language, with a plain status instead of raw numbers.
  const translationRows = s.translations.map(({ lang, count, total, firstMissing }) => {
    const done = count === total;
    const pct = total ? Math.round((count / total) * 100) : 0;
    const status = done
      ? `<span class="rv-ok">Done</span> · ${total} ${total === 1 ? "line" : "lines"}`
      : `${count} of ${total} lines · <span class="rv-warn">${total - count} missing</span>`;
    const show = !done && firstMissing ? `<button class="issue-fix" type="button" data-rv="line" data-line="${firstMissing}">Show</button>` : "";
    return `
      <div class="rv-tr-row">
        <span class="rv-tr-name">${escapeHtml(languageName(lang) || lang)}</span>
        <span class="rv-bar${done ? " full" : ""}"><i style="width:${pct}%"></i></span>
        <span class="rv-tr-status">${status}</span>
        ${show}
      </div>`;
  }).join("");
  const skipNote = s.translations.some((t) => t.script)
    ? '<p class="rv-note">Lines already in that language are skipped.</p>'
    : "";

  const extras = [
    s.furigana && "Furigana",
    s.wordTiming && "Word timing",
    s.voices.length && `Voices ${s.voices.map(escapeHtml).join(", ")}`
  ].filter(Boolean);

  const warnings = d.warnings.length ? `
      <section class="rv-section">
        <h3>${d.warnings.length} ${d.warnings.length === 1 ? "suggestion" : "suggestions"} before you send</h3>
        <p class="rv-muted">These don't block the submission.</p>
        <ul class="rv-warnings">
          ${d.warnings.map((issue, i) => `
            <li><i></i><span>${escapeHtml(issue.message)}</span><button class="issue-fix" type="button" data-rv="fix" data-index="${i}">Go fix</button></li>`).join("")}
        </ul>
      </section>` : "";

  const dest = d.mode === "edit"
    ? `Edits <code>${escapeHtml(d.targetPath)}</code> in place.`
    : "Adds a new track. xlrcdb gives it a permanent ID once it's merged.";

  return `
    <section class="rv-section">
      <dl class="rv-facts">
        <dt>Artist</dt><dd>${escapeHtml(d.artist)} ${artist}</dd>
        <dt>Languages</dt><dd class="rv-chips">${langs || "—"}</dd>
        <dt>Duplicate check</dt><dd>${d.mode === "edit" ? "Edit of an existing track" : '<span class="rv-ok">Not in xlrcdb yet</span>'}</dd>
        <dt>File</dt><dd>${dest}</dd>
      </dl>
      ${newArtistFields}
    </section>
    <section class="rv-section">
      <dl class="rv-facts">
        <dt>Timing</dt><dd>${timing}<span class="rv-muted">${ends}</span></dd>
        <dt>Translations</dt><dd>${translationRows ? `${translationRows}${skipNote}` : '<span class="rv-muted">None</span>'}</dd>
        ${extras.length ? `<dt>Extras</dt><dd class="rv-chips">${extras.map((x) => `<span class="rv-chip">${x}</span>`).join("")}</dd>` : ""}
      </dl>
    </section>
    ${warnings}
    <section class="rv-section rv-where">
      <h3>What happens next</h3>
      <p>${whereText(d)}</p>
    </section>`;
}

function whereText(d) {
  const repo = `${DATA_REPO.owner}/${DATA_REPO.repo}`;
  const who = d.account?.login ? ` from <strong>@${escapeHtml(d.account.login)}</strong>` : "";
  const signIn = d.simulate || d.account?.authed ? "" : " You'll sign in with GitHub first.";
  return `This opens a pull request on <code>${repo}</code>${who}.${signIn} It merges automatically once the format checks pass, usually within a few minutes, and the track shows up in search shortly after.`;
}

function reviewFoot(d) {
  return `
    <label class="rv-rights">
      <input id="rvRights" type="checkbox"${d.rights ? " checked" : ""}>
      <span>I have the rights to publish these lyrics: I wrote them, or I have permission from whoever did. <a href="${LEGAL_URL}" target="_blank" rel="noopener">Content policy</a></span>
    </label>
    <div class="rv-actions">
      <button class="rv-btn" type="button" data-rv="close">Back to editor</button>
      <button class="rv-btn primary" type="button" data-rv="confirm"${d.rights ? "" : " disabled"}>${d.mode === "edit" ? "Open edit PR" : "Open pull request"}${d.simulate ? " (simulated)" : ""}</button>
    </div>`;
}

// Same layout from the first step to the result: a status line that updates in place, and
// the full checklist from the start (waiting, working, done or failed).
function progressBody(d, phase) {
  const activeIndex = STEPS.findIndex((step) => step.key === d.active);
  const rows = STEPS.map((step, i) => {
    let state = "pending";
    if (phase === "done") state = "done";
    else if (i < activeIndex) state = "done";
    else if (i === activeIndex) state = phase === "error" ? "failed" : "active";
    const detail = d.details[step.key];
    return `
      <li class="${state}">
        <i aria-hidden="true"></i>
        <span class="rv-step-label">${escapeHtml(step.label)}</span>
        <span class="rv-step-detail"${detail ? ` title="${escapeHtml(detail)}"` : ""}>${detail ? escapeHtml(detail) : ""}</span>
      </li>`;
  }).join("");

  let icon = '<span class="rv-status-icon spin" aria-hidden="true"></span>';
  let title = d.headline || "Opening your pull request…";
  let line = "Keep this tab open until it finishes. It usually takes a few seconds.";
  if (phase === "done") {
    const r = d.result || {};
    icon = '<span class="rv-status-icon ok" aria-hidden="true">✓</span>';
    title = d.mode === "edit" ? "Edit submitted" : "Submitted";
    line = r.simulated
      ? "Simulated, so no pull request was created. It merges automatically once the checks pass, then shows up in search."
      : `${r.url ? `<a class="rv-pr" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">View pull request${r.number ? ` #${r.number}` : ""}</a> · ` : ""}It merges automatically once the checks pass, usually within a few minutes, then shows up in search.`;
  } else if (phase === "error") {
    icon = '<span class="rv-status-icon bad" aria-hidden="true">!</span>';
    title = "That didn't go through";
    line = escapeHtml(d.error || "Something went wrong.");
  }

  return `
    <div class="rv-status ${phase}">
      ${icon}
      <div>
        <h3>${escapeHtml(title)}</h3>
        <p>${phase === "done" ? line : phase === "error" ? line : escapeHtml(line)}</p>
      </div>
    </div>
    <ol class="rv-steps">${rows}</ol>`;
}

function progressFoot(d, phase) {
  if (phase === "done") return '<div class="rv-actions"><a class="rv-btn" href="#/">Browse xlrcdb</a><button class="rv-btn primary" type="button" data-rv="close">Back to editor</button></div>';
  if (phase === "error") return '<div class="rv-actions"><button class="rv-btn" type="button" data-rv="close">Close</button><button class="rv-btn primary" type="button" data-rv="back">Back to review</button></div>';
  // Same height as the button rows so the footer doesn't change size when it finishes.
  return '<div class="rv-actions"><button class="rv-btn" type="button" disabled>Working…</button></div>';
}

// 2:54, the way people read song positions.
function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function formatMs(ms) {
  const total = Math.max(0, Math.round(ms));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const cs = Math.floor((total % 1000) / 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}
