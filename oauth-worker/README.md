# xlrcdb OAuth broker

A tiny stateless Cloudflare Worker that completes the GitHub OAuth web flow for
the xlrcdb editor. It exchanges the `?code=` GitHub returns for a user access
token, holding the client secret server-side. It stores nothing and serves no
content, so it does not change xlrcdb's "GitHub is the content host / no stateful
backend" posture. It is the one server-side piece the contribution flow needs.

## One-time setup

1. **Register a GitHub OAuth App** (Settings → Developer settings → OAuth Apps → New).
   - Homepage URL: `https://astramusic.dev/xlrcdb/`
   - Authorization callback URL: `https://astramusic.dev/xlrcdb/`
   - Note the **Client ID**; generate a **Client secret**.

2. **Deploy the Worker** (needs the Cloudflare `wrangler` CLI):
   ```sh
   cd oauth-worker
   # edit wrangler.toml: set GITHUB_CLIENT_ID and ALLOWED_ORIGIN
   wrangler secret put GITHUB_CLIENT_SECRET   # paste the secret when prompted
   wrangler deploy
   ```
   Wrangler prints the Worker URL, e.g. `https://xlrcdb-oauth.<you>.workers.dev`.

3. **Wire the site.** In [docs/xlrcdb/github.js](../docs/xlrcdb/github.js), set `CONFIG`:
   ```js
   clientId: "<your OAuth App client id>",
   tokenExchangeUrl: "https://xlrcdb-oauth.<you>.workers.dev/",
   ```
   (`redirectUri` already defaults to `<origin>/xlrcdb/`.)

Until `CONFIG.clientId` and `CONFIG.tokenExchangeUrl` are filled, the editor's
"Submit via PR" button reports that sign-in isn't configured and contributors
fall back to Export / Copy + a manual PR.

## Scope

The OAuth App requests `public_repo` so the flow can fork `Boof2015/xlrcdb`,
push a branch, and open a PR on the contributor's behalf. No other scope.

## Local testing

`wrangler dev` runs the Worker locally; point `tokenExchangeUrl` at the dev URL
and set `ALLOWED_ORIGIN` to your local site origin (e.g. `http://localhost:8000`).
