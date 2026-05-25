// Stateless GitHub OAuth token-exchange broker for the xlrcdb editor.
//
// Why this exists: a pure static site can't finish GitHub's OAuth web flow on
// its own (the code->token exchange needs the client secret, and the device
// flow endpoints don't send CORS headers). This Worker holds the secret and
// does only the exchange. It stores nothing and hosts no content, so it does
// not change xlrcdb's "no stateful backend / GitHub is the content host" posture.
//
// Deploy with Cloudflare Wrangler (see README.md in this folder). Required:
//   - var  GITHUB_CLIENT_ID      (public; must match the value in github.js CONFIG)
//   - secret GITHUB_CLIENT_SECRET
//   - var  ALLOWED_ORIGIN        e.g. https://astramusic.dev

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Max-Age": "86400"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405, cors);
    }

    let code;
    try {
      ({ code } = await request.json());
    } catch (_) {
      return json({ error: "bad_request" }, 400, cors);
    }
    if (!code) {
      return json({ error: "missing_code" }, 400, cors);
    }

    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code
      })
    });
    const data = await response.json();

    if (data.error || !data.access_token) {
      return json({ error: data.error || "exchange_failed", error_description: data.error_description }, 400, cors);
    }
    // Return only the token (and scope). The secret never leaves the Worker.
    return json({ access_token: data.access_token, scope: data.scope, token_type: data.token_type }, 200, cors);
  }
};

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors }
  });
}
