function safeWebhookSecret(value = "") {
  return String(value)
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 256);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("SPEPE community webhook alive", { status: 200 });
    }

    if (url.pathname === "/register" && request.method === "POST") {
      if (!env.TRIGGER_SECRET || request.headers.get("authorization") !== `Bearer ${env.TRIGGER_SECRET}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_WEBHOOK_SECRET", { status: 500 });
      }

      const telegramWebhookSecret = safeWebhookSecret(env.TELEGRAM_WEBHOOK_SECRET);
      if (!telegramWebhookSecret) {
        return new Response("TELEGRAM_WEBHOOK_SECRET is empty after sanitizing", { status: 500 });
      }

      const webhookUrl = `${url.origin}/telegram`;
      const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: webhookUrl,
            secret_token: telegramWebhookSecret,
            allowed_updates: ["message"],
            drop_pending_updates: false
          })
        }
      );

      const body = await response.text();
      return new Response(body, {
        status: response.ok ? 200 : response.status,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.pathname !== "/telegram" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    if (env.TELEGRAM_WEBHOOK_SECRET) {
      const supplied = request.headers.get("x-telegram-bot-api-secret-token");
      const expected = safeWebhookSecret(env.TELEGRAM_WEBHOOK_SECRET);
      if (supplied !== expected) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    const update = await request.json();
    ctx.waitUntil(dispatch(env, "command", JSON.stringify(update)));
    return new Response("OK", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env, "scan", ""));
  }
};

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
