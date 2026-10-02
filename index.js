import fs from "node:fs/promises";
import Parser from "rss-parser";

const {
  RSS_URL,
  DISCORD_WEBHOOK_URL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  RELAY_NAME = "SPEPE Relay",
  STATE_FILE = "state.json",
  INITIALIZE_ONLY = "true",
  MAX_POSTS_PER_RUN = "5"
} = process.env;

if (!RSS_URL) throw new Error("Missing RSS_URL GitHub secret.");

if (!DISCORD_WEBHOOK_URL && !(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)) {
  throw new Error("Configure Discord and/or Telegram destination secrets.");
}

const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "Mozilla/5.0 SPEPE-RSS-Relay/1.0" }
});

async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  } catch {
    return { seen: [], initialized: false };
  }
}

async function writeState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function stripHtml(input = "") {
  return input
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function getId(item) {
  return item.guid || item.id || item.link || `${item.title}|${item.pubDate}`;
}

function xLinkFromItem(item) {
  const link = item.link || "";
  const match = link.match(/\/([^/?#]+)\/status\/(\d+)/);
  return match ? `https://x.com/${match[1]}/status/${match[2]}` : link;
}

function itemText(item) {
  const raw = stripHtml(
    item.contentSnippet || item.title || item.content || item.summary || ""
  );
  return raw.length > 1400 ? raw.slice(0, 1397) + "..." : raw;
}

async function sendDiscord(item) {
  if (!DISCORD_WEBHOOK_URL) return;
  const content = [
    "🐸⚡ **NEW $SPEPE TRANSMISSION**",
    "",
    itemText(item),
    "",
    xLinkFromItem(item)
  ].filter(Boolean).join("\n");

  const response = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: RELAY_NAME,
      content,
      allowed_mentions: { parse: [] }
    })
  });

  if (!response.ok) {
    throw new Error(`Discord error ${response.status}: ${await response.text()}`);
  }
}

async function sendTelegram(item) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const text = [
    "🐸⚡ NEW $SPEPE TRANSMISSION",
    "",
    itemText(item),
    "",
    xLinkFromItem(item)
  ].filter(Boolean).join("\n");

  const endpoint = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: false
    })
  });

  if (!response.ok) {
    throw new Error(`Telegram error ${response.status}: ${await response.text()}`);
  }
}

async function main() {
  const feed = await parser.parseURL(RSS_URL);
  const state = await readState();

  const items = (feed.items || []).map(item => ({
    ...item,
    _id: getId(item)
  }));

  if (!items.length) {
    console.log("Feed returned no items.");
    return;
  }

  if (!state.initialized && INITIALIZE_ONLY.toLowerCase() === "true") {
    state.seen = items.slice(0, 50).map(i => i._id);
    state.initialized = true;
    await writeState(state);
    console.log(`Initialized with ${state.seen.length} existing feed items. Nothing sent.`);
    return;
  }

  const seen = new Set(state.seen || []);
  const newItems = items
    .filter(item => !seen.has(item._id))
    .slice(0, Number(MAX_POSTS_PER_RUN))
    .reverse();

  for (const item of newItems) {
    await sendDiscord(item);
    await sendTelegram(item);
    seen.add(item._id);
    console.log(`Relayed: ${item.title || item.link || item._id}`);
  }

  state.seen = Array.from(new Set([...items.map(i => i._id), ...seen])).slice(0, 100);
  state.initialized = true;
  state.lastRun = new Date().toISOString();

  await writeState(state);
  console.log(newItems.length ? `Relayed ${newItems.length} new item(s).` : "No new items.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
