export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("SPEPE community webhook alive", { status: 200 });
    }

    if (url.pathname !== "/telegram" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    if (env.TELEGRAM_WEBHOOK_SECRET) {
      const supplied = request.headers.get("x-telegram-bot-api-secret-token");
      if (supplied !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const update = await request.json();
    ctxSafeDispatch(env, "command", JSON.stringify(update));
    return new Response("OK", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env, "scan", ""));
  }
};

function ctxSafeDispatch(env, mode, update) {
  return dispatch(env, mode, update).catch(err => {
    console.error(err);
  });
}

async function dispatch(env, mode, telegramUpdate) {
  if (!env.GITHUB_TOKEN) throw new Error("Missing GITHUB_TOKEN");

  const endpoint =
    "https://api.github.com/repos/SaiyanPEPEonPOL/spepe-rss-relay/" +
    "actions/workflows/community.yml/dispatches";

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "spepe-community-worker",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: JSON.stringify({
      ref: "main",
      inputs: {
        mode,
        telegram_update: telegramUpdate || ""
      }
    })
  });

  if (!response.ok) {
    throw new Error(`GitHub dispatch failed: ${response.status} ${await response.text()}`);
  }
}
