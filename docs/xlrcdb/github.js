// GitHub contribution flow for xlrcdb: browser-side OAuth (via a stateless
// token-exchange broker) plus the fork -> branch -> commit -> PR sequence.
//
// A pure static site cannot complete GitHub's OAuth web flow on its own: the
// code->token exchange needs the client secret, and the device-flow endpoints
// don't send CORS headers. So a tiny stateless broker (see oauth-worker/) holds
// the secret and performs the exchange. It stores nothing and hosts no content,
// preserving the project's "no stateful backend" posture.
//
// Fill CONFIG once the OAuth App + broker are deployed; until then the flow
// reports "not configured" and the editor's Export/Copy fallback stays usable.

import { DATA_REPO } from "./data.js";

const CONFIG = {
  clientId: "Ov23likASNKQOx8gHrgM",  // GitHub OAuth App client id (public)
  tokenExchangeUrl: "https://xlrcdb-oauth.garbage-b9a.workers.dev/",
  scope: "public_repo",
  redirectUri: `${location.origin}/xlrcdb/`
};

const TOKEN_KEY = "xlrcdb-gh-token";
const STATE_KEY = "xlrcdb-oauth-state";
const RETURN_KEY = "xlrcdb-oauth-return";
const PENDING_KEY = "xlrcdb-oauth-pending";

const API = "https://api.github.com";
const UPSTREAM = DATA_REPO;     // { owner, repo }
const BASE_BRANCH = "main";

export function createGitHub() {
  function isConfigured() {
    return !!CONFIG.clientId && !!CONFIG.tokenExchangeUrl;
  }
  function token() {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || "";
    } catch (_) {
      return "";
    }
  }
  function isAuthed() {
    return !!token();
  }
  function logout() {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch (_) {}
  }

  // Stash editor state so a login redirect can return to the same work.
  function login(returnHash, pending) {
    if (!isConfigured()) {
      return { ok: false, reason: "not-configured" };
    }
    const stateValue = randomString(24);
    try {
      sessionStorage.setItem(STATE_KEY, stateValue);
      sessionStorage.setItem(RETURN_KEY, returnHash || location.hash || "#/submit");
      if (pending) sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
    } catch (_) {}
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", CONFIG.clientId);
    url.searchParams.set("redirect_uri", CONFIG.redirectUri);
    url.searchParams.set("scope", CONFIG.scope);
    url.searchParams.set("state", stateValue);
    location.assign(url.toString());
    return { ok: true };
  }

  // Called on page load. If we're returning from GitHub with ?code=, exchange it.
  // Returns { returned, hash, pending } so the app can restore the editor.
  async function handleRedirect() {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const stateValue = params.get("state");
    if (!code) return { returned: false };

    let expected = "";
    let hash = "#/submit";
    let pending = null;
    try {
      expected = sessionStorage.getItem(STATE_KEY) || "";
      hash = sessionStorage.getItem(RETURN_KEY) || hash;
      pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null");
      sessionStorage.removeItem(STATE_KEY);
      sessionStorage.removeItem(RETURN_KEY);
      sessionStorage.removeItem(PENDING_KEY);
    } catch (_) {}

    // Clean the OAuth params out of the URL regardless of outcome.
    history.replaceState(null, "", `${location.pathname}${hash}`);

    if (!stateValue || stateValue !== expected) {
      return { returned: true, error: "OAuth state mismatch; please retry sign-in.", hash };
    }
    try {
      const response = await fetch(CONFIG.tokenExchangeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code })
      });
      const data = await response.json();
      if (!response.ok || !data.access_token) {
        throw new Error(data.error_description || data.error || "Token exchange failed");
      }
      sessionStorage.setItem(TOKEN_KEY, data.access_token);
      return { returned: true, hash, pending };
    } catch (error) {
      return { returned: true, error: error.message || "Sign-in failed", hash };
    }
  }

  async function getUser() {
    const user = await api("GET", "/user");
    return user;
  }

  // Track contribution flow (new or edit). onProgress(text) for status updates.
  async function submitTrack(submission, onProgress = () => {}) {
    const path = submission.mode === "edit" && submission.trackPath
      ? submission.trackPath
      : `incoming/${crypto.randomUUID()}.xlrc`;
    // Single .xlrc only: the data-repo PR gate requires incoming/ to be .xlrc files,
    // so a new artist is auto-created by CI from [ar:] (latin/pronunciation, if any,
    // are noted in the PR body for a maintainer or a follow-up alias edit).
    return openFilePr({
      branchPrefix: `xlrcdb-${submission.mode}`,
      files: [{ path, text: submission.text, fetchSha: submission.mode === "edit" }],
      title: prTitle(submission),
      body: prBody(submission),
      onProgress
    });
  }

  // Artist record edit flow (alias / latin / pronunciation changes to a .toml).
  async function submitArtist(artistEdit, onProgress = () => {}) {
    return openFilePr({
      branchPrefix: "xlrcdb-artist",
      files: [{ path: artistEdit.path, text: artistEdit.text, fetchSha: true }],
      title: `Update artist: ${artistEdit.canonicalName}`,
      body: `Edited artist record \`${artistEdit.artistId}\` via the [xlrcdb editor](https://astramusic.dev/xlrcdb/).`,
      onProgress
    });
  }

  // Shared core: fork -> branch off upstream main -> commit file(s) -> open PR.
  async function openFilePr({ branchPrefix, files, title, body, onProgress }) {
    if (!isAuthed()) throw new Error("Not signed in");

    onProgress("Reading your GitHub account");
    const user = await getUser();

    onProgress("Preparing your fork");
    await ensureFork(user.login);
    // Bring the fork's main up to date with upstream (best-effort). Branching off
    // the UPSTREAM head 404s when the fork is behind, so we base the branch on the
    // fork's own main, which always exists in the fork.
    await syncFork(user.login).catch(() => {});

    onProgress("Locating the latest main");
    const baseSha = await refSha(user.login, UPSTREAM.repo, BASE_BRANCH);

    const branch = `${branchPrefix}-${Date.now().toString(36)}`;
    onProgress("Creating a branch");
    await createRef(user.login, UPSTREAM.repo, branch, baseSha);

    for (const file of files) {
      onProgress(`Committing ${file.path.split("/").pop()}`);
      // For in-place edits we need the blob sha that the branch points at.
      let sha = file.sha;
      if (file.fetchSha) {
        sha = await fileSha(user.login, UPSTREAM.repo, file.path, branch);
      }
      await putFile(user.login, UPSTREAM.repo, file.path, file.text, branch, {
        message: title,
        sha
      });
    }

    onProgress("Opening the pull request");
    const pr = await api("POST", `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/pulls`, {
      title,
      head: `${user.login}:${branch}`,
      base: BASE_BRANCH,
      body,
      maintainer_can_modify: true
    });

    onProgress("Pull request opened");
    return { url: pr.html_url, number: pr.number };
  }

  async function fileSha(owner, repo, path, branch) {
    try {
      const data = await api("GET", `/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`);
      return data.sha;
    } catch (_) {
      return undefined;
    }
  }

  // ── low-level helpers ──
  async function api(method, path, body) {
    const response = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token()}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (response.status === 401) {
      logout();
      throw new Error("GitHub session expired; please sign in again.");
    }
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(data.message ? `GitHub: ${data.message}` : `GitHub error ${response.status}`);
    }
    return data;
  }

  async function ensureFork(login) {
    try {
      await api("GET", `/repos/${login}/${UPSTREAM.repo}`);
      return;
    } catch (_) {
      // not forked yet
    }
    await api("POST", `/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/forks`);
    // Forking is async; poll until the fork is queryable.
    for (let i = 0; i < 10; i++) {
      await delay(1500);
      try {
        await api("GET", `/repos/${login}/${UPSTREAM.repo}`);
        return;
      } catch (_) {}
    }
    throw new Error("Timed out waiting for your fork to be created.");
  }

  // Fast-forward the fork's branch to upstream so the branch base exists locally.
  async function syncFork(login) {
    await api("POST", `/repos/${login}/${UPSTREAM.repo}/merge-upstream`, { branch: BASE_BRANCH });
  }

  async function refSha(owner, repo, branch) {
    const ref = await api("GET", `/repos/${owner}/${repo}/git/ref/heads/${branch}`);
    return ref.object.sha;
  }

  async function createRef(owner, repo, branch, sha) {
    await api("POST", `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha
    });
  }

  async function putFile(owner, repo, path, text, branch, { message, sha }) {
    await api("PUT", `/repos/${owner}/${repo}/contents/${encodePath(path)}`, {
      message,
      content: utf8ToBase64(text),
      branch,
      ...(sha ? { sha } : {})
    });
  }

  return { isConfigured, isAuthed, login, logout, handleRedirect, getUser, submitTrack, submitArtist };
}

function prTitle(s) {
  return `${s.mode === "edit" ? "Edit" : "Add"}: ${s.artist} - ${s.title}`;
}

function prBody(s) {
  const lines = [
    `Submitted via the [xlrcdb editor](https://astramusic.dev/xlrcdb/).`,
    "",
    `- **Artist:** ${s.artist}`,
    `- **Title:** ${s.title}`,
    `- **Length:** ${s.length}`
  ];
  if (s.artistResolution?.status === "existing" && s.artistId) {
    // CI hint: resolve [ar:] to this existing artist.
    lines.push("", `Artist-Id: ${s.artistId}`);
  }
  if (s.artistResolution?.status === "new") {
    lines.push("", "New artist; CI will create the record from `[ar:]`.");
    const meta = s.newArtist || {};
    if (meta.canonical_name_latin) lines.push(`- Latin name (apply via an artist edit after merge): ${meta.canonical_name_latin}`);
    if (meta.pronunciation) lines.push(`- Pronunciation (apply via an artist edit after merge): ${meta.pronunciation}`);
  }
  return lines.join("\n");
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function randomString(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, length);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
