export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(triggerRelay(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("SPEPE relay timer is alive", { status: 200 });
    }

    if (url.pathname === "/trigger") {
      if (!env.TRIGGER_SECRET) {
        return new Response("Manual trigger disabled", { status: 403 });
      }

      const supplied = request.headers.get("authorization");
      if (supplied !== `Bearer ${env.TRIGGER_SECRET}`) {
        return new Response("Unauthorized", { status: 401 });
      }

      const result = await triggerRelay(env);
      return new Response(result, { status: 200 });
    }

    return new Response("SPEPE relay timer", { status: 200 });
  }
};

async function triggerRelay(env) {
  if (!env.GITHUB_TOKEN) {
    throw new Error("Missing GITHUB_TOKEN secret");
  }

  const endpoint =
    "https://api.github.com/repos/SaiyanPEPEonPOL/spepe-rss-relay/" +
    "actions/workflows/relay.yml/dispatches";

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "spepe-relay-cloudflare-timer",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: JSON.stringify({ ref: "main" })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub dispatch failed: ${response.status} ${body}`);
  }

  return "Relay dispatched";
}
// relay verification touch
