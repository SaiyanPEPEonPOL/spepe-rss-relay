import fs from "node:fs/promises";

const {
  X_HANDLE = "SaiyanPEPE",
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  COMMUNITY_STATE_FILE = "community-state.json"
} = process.env;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.log("Telegram community module skipped: Telegram secrets are not configured.");
  process.exit(0);
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const BOT_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function readState() {
  try {
    const parsed = JSON.parse(await fs.readFile(COMMUNITY_STATE_FILE, "utf8"));
    return {
      telegramOffset: Number(parsed.telegramOffset || 0),
      links: parsed.links || {},
      pendingLinks: parsed.pendingLinks || {},
      scores: parsed.scores || {},
      seenActivity: Array.isArray(parsed.seenActivity) ? parsed.seenActivity : [],
      initializedActivity: Boolean(parsed.initializedActivity),
      lastPromoDate: parsed.lastPromoDate || null,
      activities: Array.isArray(parsed.activities) ? parsed.activities : []
    };
  } catch {
    return {
      telegramOffset: 0,
      links: {},
      pendingLinks: {},
      scores: {},
      seenActivity: [],
      initializedActivity: false,
      lastPromoDate: null,
      activities: []
    };
  }
}

async function writeState(state) {
  await fs.writeFile(COMMUNITY_STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

async function tg(method, body = {}) {
  const response = await fetch(`${BOT_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(
      `Telegram ${method} failed: ${response.status} ${payload ? JSON.stringify(payload) : ""}`
    );
  }
  return payload.result;
}

function cleanHandle(value = "") {
  return value.trim().replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "");
}

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "SPEPE-LINK-";
  for (let i = 0; i < 6; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function telegramDisplay(user) {
  if (user?.username) return `@${user.username}`;
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
  return name || `Telegram user ${user?.id || ""}`;
}

function scoreRows(state) {
  return Object.entries(state.links)
    .map(([telegramId, link]) => ({
      telegramId,
      handle: link.handle,
      score: Number(state.scores[telegramId] || 0)
    }))
    .sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle));
}

async function sendText(chatId, text) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  });
}

async function processCommands(state) {
  let updates = [];
  try {
    updates = await tg("getUpdates", {
      offset: state.telegramOffset || undefined,
      timeout: 0,
      allowed_updates: ["message"]
    });
  } catch (err) {
    console.warn(`Telegram command polling failed: ${err.message}`);
    return;
  }

  for (const update of updates) {
    state.telegramOffset = Math.max(state.telegramOffset, Number(update.update_id) + 1);

    const message = update.message;
    const text = message?.text?.trim() || "";
    const from = message?.from;
    const chatId = message?.chat?.id;

    if (!from?.id || !chatId || !text.startsWith("/")) continue;

    const [rawCommand, ...args] = text.split(/\s+/);
    const command = rawCommand.toLowerCase().split("@")[0];
    const telegramId = String(from.id);

    if (command === "/link") {
      const handle = cleanHandle(args[0] || "");
      if (!handle) {
        await sendText(chatId, "Use /link @YourXHandle");
        continue;
      }

      const handleKey = handle.toLowerCase();
      const alreadyClaimed = Object.entries(state.links).find(
        ([id, link]) => id !== telegramId && String(link.handle || "").toLowerCase() === handleKey
      );

      if (alreadyClaimed) {
        await sendText(chatId, `@${handle} is already linked to another Telegram account.`);
        continue;
      }

      const code = randomCode();
      state.pendingLinks[telegramId] = {
        handle,
        code,
        createdAt: new Date().toISOString()
      };

      await sendText(
        chatId,
        [
          `Linking X account @${handle}.`,
          "",
          "Post this exact code from that X account:",
          code,
          "",
          "Then come back here and use /verify.",
          "You can delete the verification post afterward. Verification posts do not earn points."
        ].join("\n")
      );
      continue;
    }

    if (command === "/verify") {
      const pending = state.pendingLinks[telegramId];
      if (!pending) {
        await sendText(chatId, "You do not have a pending link. Start with /link @YourXHandle.");
        continue;
      }

      const ageMs = Date.now() - Date.parse(pending.createdAt || 0);
      if (!Number.isFinite(ageMs) || ageMs > 24 * 60 * 60 * 1000) {
        delete state.pendingLinks[telegramId];
        await sendText(chatId, "That link code expired. Use /link again for a new one.");
        continue;
      }

      const posts = await searchX(`from:${pending.handle} ${pending.code}`, 10);
      const verified = posts.some(post =>
        post.author.toLowerCase() === pending.handle.toLowerCase() &&
        post.text.includes(pending.code)
      );

      if (!verified) {
        await sendText(
          chatId,
          "I could not find the verification post yet. X search can lag a little. Leave the post up and try /verify again in a few minutes."
        );
        continue;
      }

      state.links[telegramId] = {
        handle: pending.handle,
        telegramName: telegramDisplay(from),
        linkedAt: new Date().toISOString()
      };
      if (!(telegramId in state.scores)) state.scores[telegramId] = 0;
      delete state.pendingLinks[telegramId];

      await sendText(
        chatId,
        `Linked! @${pending.handle} is now connected to your Telegram account. Use /rank to check your score.`
      );
      continue;
    }

    if (command === "/rank") {
      const link = state.links[telegramId];
      if (!link) {
        await sendText(chatId, "You are not linked yet. Use /link @YourXHandle to join the leaderboard.");
        continue;
      }

      const rows = scoreRows(state);
      const index = rows.findIndex(row => row.telegramId === telegramId);
      const points = Number(state.scores[telegramId] || 0);

      await sendText(
        chatId,
        [
          `@${link.handle}`,
          `Rank: #${index + 1}`,
          `Points: ${points}`,
          "",
          "Replies = 1 pt • Quote posts = 2 pts • Original $SPEPE/@SaiyanPEPE mentions = 3 pts"
        ].join("\n")
      );
      continue;
    }

    if (command === "/top") {
      const rows = scoreRows(state).slice(0, 10);
      if (!rows.length) {
        await sendText(chatId, "The leaderboard is empty. Use /link @YourXHandle to get started.");
        continue;
      }

      const lines = rows.map(
        (row, i) => `${i + 1}. @${row.handle} — ${row.score} pt${row.score === 1 ? "" : "s"}`
      );
      await sendText(chatId, ["🏆 SPEPE COMMUNITY TOP 10", "", ...lines].join("\n"));
      continue;
    }

    if (command === "/help" || command === "/points") {
      await sendText(
        chatId,
        [
          "🐸 SPEPE Community Support",
          "",
          "/link @handle — connect your X account",
          "/verify — verify a pending link",
          "/rank — see your rank and points",
          "/top — see the top 10",
          "",
          "Replies = 1 pt",
          "Quote posts = 2 pts",
          "Original posts mentioning $SPEPE or @SaiyanPEPE = 3 pts"
        ].join("\n")
      );
    }
  }
}

async function searchX(query, limit = 20) {
  const params = new URLSearchParams({
    q: query,
    feed: "latest",
    format: "json",
    limit: String(limit),
    nocache: "true"
  });

  const response = await fetch("https://x.pcstyle.dev/api/v1/search?" + params.toString(), {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`x.md search failed for "${query}": HTTP ${response.status}`);
  }

  const data = await response.json();
  const raw = Array.isArray(data.posts) ? data.posts : [];

  return raw.map(tweet => {
    const id = String(tweet.id_str || tweet.id || tweet.rest_id || "");
    const author =
      tweet.user?.screen_name ||
      tweet.author?.screen_name ||
      tweet.author?.username ||
      tweet.username ||
      "";
    const text =
      tweet.full_text ||
      tweet.text ||
      tweet.content ||
      tweet.legacy?.full_text ||
      "";
    const url =
      tweet.url ||
      tweet.permalink ||
      (id && author ? `https://x.com/${author}/status/${id}` : "");

    const quoted =
      tweet.quoted_status ||
      tweet.quotedStatus ||
      tweet.quoted_tweet ||
      tweet.quotedTweet ||
      tweet.quote ||
      null;

    const quotedId = String(
      tweet.quoted_status_id_str ||
      tweet.quotedStatusId ||
      quoted?.id_str ||
      quoted?.id ||
      quoted?.rest_id ||
      ""
    );

    const quotedAuthor =
      quoted?.user?.screen_name ||
      quoted?.author?.screen_name ||
      quoted?.author?.username ||
      "";

    return {
      id,
      author,
      text,
      url: url.startsWith("http") ? url : url ? `https://x.com${url}` : "",
      quotedId,
      quotedAuthor
    };
  }).filter(post => post.id && post.author && post.url);
}

function mergeCandidates(target, posts, source) {
  for (const post of posts) {
    const existing = target.get(post.id);
    if (existing) {
      existing.sources.add(source);
      if (!existing.quotedId && post.quotedId) existing.quotedId = post.quotedId;
      if (!existing.quotedAuthor && post.quotedAuthor) existing.quotedAuthor = post.quotedAuthor;
    } else {
      target.set(post.id, { ...post, sources: new Set([source]) });
    }
  }
}

function findLinkedTelegramId(state, handle) {
  const needle = handle.toLowerCase();
  const match = Object.entries(state.links).find(
    ([, link]) => String(link.handle || "").toLowerCase() === needle
  );
  return match?.[0] || null;
}

function classifyActivity(post, recentSpepeIds) {
  if (/SPEPE-LINK-[A-Z0-9]+/i.test(post.text)) return null;
  if (post.author.toLowerCase() === X_HANDLE.toLowerCase()) return null;

  const quotesSpepe =
    post.sources.has("quote") ||
    post.quotedAuthor.toLowerCase() === X_HANDLE.toLowerCase() ||
    (post.quotedId && recentSpepeIds.has(post.quotedId)) ||
    /https?:\/\/(?:www\.)?x\.com\/SaiyanPEPE\/status\//i.test(post.text);

  if (quotesSpepe) {
    return { type: "quote", points: 2 };
  }

  if (post.sources.has("reply")) {
    return { type: "reply", points: 1 };
  }

  if (/\$SPEPE\b|@SaiyanPEPE\b/i.test(post.text)) {
    return { type: "mention", points: 3 };
  }

  return null;
}

async function announceActivity(post, activity) {
  const title = activity.type === "quote"
    ? `🔥 COMMUNITY QUOTE +${activity.points}`
    : `⚡ COMMUNITY MENTION +${activity.points}`;

  const body = post.text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const clipped = body.length > 900 ? body.slice(0, 897) + "..." : body;

  await sendText(
    TELEGRAM_CHAT_ID,
    [
      title,
      `@${post.author} is showing support.`,
      "",
      clipped,
      "",
      post.url
    ].filter(Boolean).join("\n")
  );
}

async function processCommunityActivity(state) {
  const candidates = new Map();

  const [replies, mentionsTicker, mentionsHandle, quoteSearch, spepePosts] = await Promise.all([
    searchX(`to:${X_HANDLE}`, 30),
    searchX("$SPEPE", 30),
    searchX(`@${X_HANDLE}`, 30),
    searchX(`url:x.com/${X_HANDLE}/status`, 30),
    searchX(`from:${X_HANDLE}`, 30)
  ]);

  mergeCandidates(candidates, replies, "reply");
  mergeCandidates(candidates, mentionsTicker, "mention");
  mergeCandidates(candidates, mentionsHandle, "mention");
  mergeCandidates(candidates, quoteSearch, "quote");

  const recentSpepeIds = new Set(spepePosts.map(post => post.id));
  const current = [...candidates.values()]
    .filter(post => classifyActivity(post, recentSpepeIds))
    .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? 1 : -1));

  const seen = new Set(state.seenActivity);

  if (!state.initializedActivity) {
    for (const post of current) seen.add(post.id);
    state.seenActivity = [...seen].slice(-1000);
    state.initializedActivity = true;
    console.log(`Community leaderboard initialized with ${current.length} existing activities; no retroactive points awarded.`);
    return;
  }

  for (const post of current) {
    if (seen.has(post.id)) continue;

    const activity = classifyActivity(post, recentSpepeIds);
    seen.add(post.id);
    if (!activity) continue;

    const telegramId = findLinkedTelegramId(state, post.author);
    if (!telegramId) {
      console.log(`Community activity ignored for unlinked @${post.author}: ${post.url}`);
      continue;
    }

    state.scores[telegramId] = Number(state.scores[telegramId] || 0) + activity.points;
    state.activities.push({
      id: post.id,
      handle: post.author,
      telegramId,
      type: activity.type,
      points: activity.points,
      url: post.url,
      at: new Date().toISOString()
    });
    state.activities = state.activities.slice(-500);

    console.log(
      `Awarded ${activity.points} point(s) to @${post.author} for ${activity.type}: ${post.url}`
    );

    if (activity.type === "quote" || activity.type === "mention") {
      try {
        await announceActivity(post, activity);
      } catch (err) {
        console.warn(`Community announcement failed: ${err.message}`);
      }
    }
  }

  state.seenActivity = [...seen].slice(-1000);
}

function centralNowParts() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date());

  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    dateKey: `${map.year}-${map.month}-${map.day}`,
    hour: Number(map.hour),
    minute: Number(map.minute)
  };
}

async function maybeSendDailyPromo(state) {
  const now = centralNowParts();
  if (state.lastPromoDate === now.dateKey) return;
  if (now.hour !== 11 || now.minute < 25 || now.minute > 45) return;

  await sendText(
    TELEGRAM_CHAT_ID,
    [
      "⚡ WANT TO SUPPORT THE COMMUNITY? PROVE IT.",
      "",
      "Reply. Quote. Post.",
      "",
      "1 pt — reply to @SaiyanPEPE",
      "2 pts — quote a SaiyanPEPE post",
      "3 pts — make an original post mentioning $SPEPE or @SaiyanPEPE",
      "",
      "Use /rank to see where you stand.",
      "Use /top to see the community Top 10.",
      "",
      "Don't forget to /link your X account to start showing support today!"
    ].join("\n")
  );

  state.lastPromoDate = now.dateKey;
  console.log("Sent daily SPEPE community leaderboard promo.");
}

async function setBotCommands() {
  try {
    await tg("setMyCommands", {
      commands: [
        { command: "link", description: "Link your X account" },
        { command: "verify", description: "Verify your linked X account" },
        { command: "rank", description: "See your community rank" },
        { command: "top", description: "See the Top 10" },
        { command: "points", description: "See how points work" }
      ]
    });
  } catch (err) {
    console.warn(`Could not set Telegram commands: ${err.message}`);
  }
}

async function main() {
  const state = await readState();

  await setBotCommands();
  await processCommands(state);

  try {
    await processCommunityActivity(state);
  } catch (err) {
    console.warn(`Community activity scan failed: ${err.message}`);
  }

  try {
    await maybeSendDailyPromo(state);
  } catch (err) {
    console.warn(`Daily promo failed: ${err.message}`);
  }

  await writeState(state);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
