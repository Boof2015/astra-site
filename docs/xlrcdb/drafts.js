// Per-viewer drafts. Lyric text goes in localStorage; the last audio file per draft goes in
// IndexedDB so a refresh doesn't mean finding the file again. Everything here is best-effort:
// private windows and blocked storage just mean no drafts.

const NEW_KEY = "xlrcdb-submission-draft"; // the original single new-track draft
const EDIT_PREFIX = "xlrcdb-draft:";
const DB_NAME = "xlrcdb-editor";
const STORE = "audio";
const KEEP_AUDIO = 3;

export function draftKey(mode, trackId) {
  return mode === "edit" && trackId ? `edit:${trackId}` : "new";
}

// { text, base, savedAt } or null. `base` fingerprints the published file the draft started
// from, so a restore can say when the track has changed since.
export function loadTextDraft(key) {
  try {
    if (key === "new") {
      const text = localStorage.getItem(NEW_KEY);
      return text && text.trim() ? { text, base: null, savedAt: 0 } : null;
    }
    const raw = localStorage.getItem(EDIT_PREFIX + key);
    const draft = raw ? JSON.parse(raw) : null;
    return draft && typeof draft.text === "string" ? draft : null;
  } catch (_) {
    return null;
  }
}

export function saveTextDraft(key, text, base = null) {
  try {
    if (key === "new") localStorage.setItem(NEW_KEY, text);
    else localStorage.setItem(EDIT_PREFIX + key, JSON.stringify({ text, base, savedAt: Date.now() }));
  } catch (_) {}
}

export function clearTextDraft(key) {
  try {
    localStorage.removeItem(key === "new" ? NEW_KEY : EDIT_PREFIX + key);
  } catch (_) {}
}

export function fingerprint(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("no indexedDB"));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result?.result ?? result);
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveAudio(key, file) {
  try {
    const db = await openDb();
    await run(db, "readwrite", (store) => store.put({ key, name: file.name, type: file.type, blob: file, savedAt: Date.now() }));
    // Keep only the most recent few; audio files are big.
    const all = await run(db, "readonly", (store) => store.getAll());
    const stale = all.sort((a, b) => b.savedAt - a.savedAt).slice(KEEP_AUDIO);
    if (stale.length) await run(db, "readwrite", (store) => stale.forEach((item) => store.delete(item.key)));
    db.close();
  } catch (_) {}
}

// The saved audio for a draft as a File, or null.
export async function loadAudio(key) {
  try {
    const db = await openDb();
    const item = await run(db, "readonly", (store) => store.get(key));
    db.close();
    if (!item?.blob) return null;
    return new File([item.blob], item.name || "audio", { type: item.type || item.blob.type });
  } catch (_) {
    return null;
  }
}
