import fs from "node:fs/promises";

const {
  X_HANDLE = "SaiyanPEPE",
  DISCORD_WEBHOOK_URL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  RELAY_NAME = "SPEPE Relay",
  STATE_FILE = "state.json",
  INITIALIZE_ONLY = "true",
  MAX_POSTS_PER_RUN = "5",
  INCLUDE_REPLIES = "false",
  INCLUDE_REPOSTS = "false"
} = process.env;

if (!DISCORD_WEBHOOK_URL && !(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)) {
  throw new Error("Configure Discord and/or Telegram destination secrets.");
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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

function extractNextData(html) {
  const match = html.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!match) {
    throw new Error("X syndication response did not contain __NEXT_DATA__.");
  }
  return JSON.parse(match[1]);
}

function isReply(tweet) {
  return Boolean(
    tweet.in_reply_to_status_id_str ||
    tweet.in_reply_to_user_id_str ||
    tweet.in_reply_to_screen_name
  );
}

function isRepost(tweet) {
  return Boolean(tweet.retweeted_status || /^RT\s+@/i.test(tweet.full_text || tweet.text || ""));
}

function normalizeTweet(tweet) {
  const id = String(tweet.id_str || tweet.id || "");
  const handle = tweet.user?.screen_name || X_HANDLE;
  return {
    id,
    text: tweet.full_text || tweet.text || "",
    url: tweet.permalink
      ? `https://x.com${tweet.permalink}`
      : `https://x.com/${handle}/status/${id}`,
    createdAt: tweet.created_at || null,
    reply: isReply(tweet),
    repost: isRepost(tweet)
  };
}

async function fetchFromXmd() {
  const url =
    "https://x.pcstyle.dev/api/v1/profiles/" +
    encodeURIComponent(X_HANDLE) +
    "?format=json&limit=20";

  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    throw new Error(
      `x.md request failed: HTTP ${response.status}` +
      (retryAfter ? ` (retry after ${retryAfter}s)` : "")
    );
  }

  const data = await response.json();
  const rawPosts = Array.isArray(data.posts) ? data.posts : [];

  const posts = rawPosts.map(tweet => {
    const id = String(tweet.id_str || tweet.id || tweet.rest_id || "");
    const handle =
      tweet.user?.screen_name ||
      tweet.author?.screen_name ||
      tweet.author?.username ||
      X_HANDLE;
    const text =
      tweet.full_text ||
      tweet.text ||
      tweet.content ||
      tweet.legacy?.full_text ||
      "";
    const url =
      tweet.url ||
      tweet.permalink ||
      (id ? `https://x.com/${handle}/status/${id}` : "");

    return {
      id,
      text,
      url: url.startsWith("http") ? url : `https://x.com${url}`,
      createdAt: tweet.created_at || tweet.createdAt || null,
      reply: isReply(tweet),
      repost: isRepost(tweet)
    };
  }).filter(post => post.id && post.url);

  return posts;
}

async function fetchFromSyndication() {
  const url =
    "https://syndication.twitter.com/srv/timeline-profile/screen-name/" +
    encodeURIComponent(X_HANDLE);

  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml"
    }
  });

  if (!response.ok) {
    throw new Error(`X syndication request failed: HTTP ${response.status}`);
  }

  const html = await response.text();
  const data = extractNextData(html);
  const entries = data?.props?.pageProps?.timeline?.entries || [];

  return entries
    .filter(entry => entry?.type === "tweet" && entry?.content?.tweet)
    .map(entry => normalizeTweet(entry.content.tweet))
    .filter(post => post.id);
}

async function fetchRecentPosts() {
  let posts;

  try {
    posts = await fetchFromXmd();
    console.log(`Fetched ${posts.length} posts from x.md.`);
  } catch (primaryError) {
    console.warn(`Primary X source failed: ${primaryError.message}`);
    console.warn("Trying X syndication fallback...");
    posts = await fetchFromSyndication();
    console.log(`Fetched ${posts.length} posts from X syndication fallback.`);
  }

  if (INCLUDE_REPLIES.toLowerCase() !== "true") {
    posts = posts.filter(post => !post.reply);
  }

  if (INCLUDE_REPOSTS.toLowerCase() !== "true") {
    posts = posts.filter(post => !post.repost);
  }

  return posts;
}

function itemText(post) {
  const text = post.text.trim();
  return text.length > 1400 ? text.slice(0, 1397) + "..." : text;
}

async function sendDiscord(post) {
  if (!DISCORD_WEBHOOK_URL) return;

  const content = [
    "🐸⚡ **NEW $SPEPE TRANSMISSION**",
    "",
    itemText(post),
    "",
    post.url
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

async function sendTelegram(post) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const text = [
    "🐸⚡ NEW $SPEPE TRANSMISSION",
    "",
    itemText(post),
    "",
    post.url
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
  const posts = await fetchRecentPosts();
  const state = await readState();

  if (!posts.length) {
    console.log(`No eligible posts found for @${X_HANDLE}.`);
    return;
  }

  if (!state.initialized && INITIALIZE_ONLY.toLowerCase() === "true") {
    state.seen = posts.slice(0, 50).map(post => post.id);
    state.initialized = true;
    state.lastRun = new Date().toISOString();
    await writeState(state);
    console.log(`Initialized with ${state.seen.length} existing posts. Nothing sent.`);
    return;
  }

  const seen = new Set(state.seen || []);
  const newPosts = posts
    .filter(post => !seen.has(post.id))
    .slice(0, Number(MAX_POSTS_PER_RUN))
    .reverse();

  for (const post of newPosts) {
    await sendDiscord(post);
    await sendTelegram(post);
    seen.add(post.id);
    console.log(`Relayed: ${post.url}`);
  }

  state.seen = Array.from(new Set([...posts.map(post => post.id), ...seen])).slice(0, 100);
  state.initialized = true;
  state.lastRun = new Date().toISOString();

  await writeState(state);
  console.log(newPosts.length ? `Relayed ${newPosts.length} new post(s).` : "No new posts.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
