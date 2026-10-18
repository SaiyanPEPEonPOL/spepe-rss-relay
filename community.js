import fs from "node:fs/promises";

const {
  X_HANDLE = "SaiyanPEPE",
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  COMMUNITY_STATE_FILE = "community-state.json",
  COMMUNITY_MODE = "scan",
  TELEGRAM_UPDATE_JSON = ""
} = process.env;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN.");

const API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const POINTS = { reply: 1, quote: 2, mention: 3 };
const HOURLY_CAPS = { reply: 3, quote: 3, mention: 3 };
const MILESTONES = [25, 50, 100, 250, 500, 1000];

async function readState() {
  try {
    const s = JSON.parse(await fs.readFile(COMMUNITY_STATE_FILE, "utf8"));
    return {
      links: s.links || {},
      pendingLinks: s.pendingLinks || {},
      activities: Array.isArray(s.activities) ? s.activities : [],
      seen: Array.isArray(s.seen) ? s.seen : [],
      initialized: Boolean(s.initialized),
      badges: s.badges || {},
      milestoneSeen: s.milestoneSeen || {},
      lastPromoDate: s.lastPromoDate || null,
      lastWeeklyRecapKey: s.lastWeeklyRecapKey || null,
      announcementTop: Number.isFinite(Number(s.announcementTop)) ? Number(s.announcementTop) : 10,
      raidSuppressed: s.raidSuppressed || {},
      raidLastPublicAt: s.raidLastPublicAt || {}
    };
  } catch {
    return {
      links: {},
      pendingLinks: {},
      activities: [],
      seen: [],
      initialized: false,
      badges: {},
      milestoneSeen: {},
      lastPromoDate: null,
      lastWeeklyRecapKey: null,
      announcementTop: 10,
      raidSuppressed: {},
      raidLastPublicAt: {}
    };
  }
}

async function writeState(state) {
  await fs.writeFile(COMMUNITY_STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const p = await r.json().catch(() => null);
  if (!r.ok || !p?.ok) throw new Error(`Telegram ${method} failed: ${r.status} ${JSON.stringify(p)}`);
  return p.result;
}

async function sendText(chatId, text, extra = {}) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...extra
  });
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cleanHandle(v = "") {
  return v.trim().replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "");
}

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "SPEPE-LINK-";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function nowChicagoParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short",
    hour12: false
  }).formatToParts(date);
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}

function localDateKey(date = new Date()) {
  const p = nowChicagoParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function weekStartKey(date = new Date()) {
  const d = new Date(date);
  const p = nowChicagoParts(d);
  const local = new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`);
  const day = local.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  local.setUTCDate(local.getUTCDate() + diff);
  return localDateKey(local);
}

function monthKey(date = new Date()) {
  const p = nowChicagoParts(date);
  return `${p.year}-${p.month}`;
}

function snowflakeDate(id) {
  try {
    const n = BigInt(String(id));
    return new Date(Number((n >> 22n) + 1288834974657n));
  } catch {
    return null;
  }
}

function isWithinDaysBySnowflake(id, days) {
  const d = snowflakeDate(id);
  if (!d || Number.isNaN(d.getTime())) return false;
  const age = Date.now() - d.getTime();
  return age >= 0 && age <= days * 24 * 60 * 60 * 1000;
}

function todaySuppressed(state) {
  const key = localDateKey();
  if (!state.raidSuppressed[key]) state.raidSuppressed[key] = [];
  for (const k of Object.keys(state.raidSuppressed)) {
    if (k !== key) delete state.raidSuppressed[k];
  }
  return state.raidSuppressed[key];
}

function typeLabel(type) {
  if (type === "quote") return "Quote post";
  if (type === "reply") return "Reply";
  if (type === "mention") return "Original mention";
  return type;
}

function raidActivityEligible(a, today = localDateKey()) {
  if (!a || !["reply", "quote", "mention"].includes(a.type)) return false;
  const activityDay = a.raidDate || localDateKey(new Date(a.at));
  if (activityDay !== today) return false;
  if (a.type === "quote" &&
      (!a.sourcePostId || !isWithinDaysBySnowflake(a.sourcePostId, 5))) {
    return false;
  }
  if (a.type === "reply" &&
      a.sourcePostId &&
      !isWithinDaysBySnowflake(a.sourcePostId, 5)) {
    return false;
  }
  return true;
}

async function isOwnerOrAdmin(userId) {
  if (!TELEGRAM_CHAT_ID) return false;
  try {
    const member = await tg("getChatMember", {
      chat_id: TELEGRAM_CHAT_ID,
      user_id: Number(userId)
    });
    return member?.status === "creator" || member?.status === "administrator";
  } catch {
    return false;
  }
}

function activityDate(a) {
  return new Date(a.at);
}

function periodScore(state, telegramId, period) {
  const now = new Date();
  return state.activities
    .filter(a => a.telegramId === telegramId)
    .filter(a => {
      if (period === "all") return true;
      const d = activityDate(a);
      if (period === "weekly") return weekStartKey(d) === weekStartKey(now);
      if (period === "monthly") return monthKey(d) === monthKey(now);
      return true;
    })
    .reduce((n, a) => n + Number(a.points || 0), 0);
}

function rows(state, period = "all") {
  return Object.entries(state.links)
    .map(([telegramId, link]) => ({
      telegramId,
      handle: link.handle,
      score: periodScore(state, telegramId, period)
    }))
    .sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle));
}

function activeDates(state, telegramId) {
  return [...new Set(
    state.activities
      .filter(a => a.telegramId === telegramId)
      .map(a => localDateKey(new Date(a.at)))
  )].sort();
}

function streakInfo(state, telegramId) {
  const dates = activeDates(state, telegramId);
  if (!dates.length) return { current: 0, longest: 0 };

  let longest = 1;
  let run = 1;
  for (let i = 1; i < dates.length; i++) {
    const a = new Date(dates[i - 1] + "T12:00:00Z");
    const b = new Date(dates[i] + "T12:00:00Z");
    const diff = Math.round((b - a) / 86400000);
    if (diff === 1) run++;
    else run = 1;
    longest = Math.max(longest, run);
  }

  const today = localDateKey();
  const y = new Date();
  y.setUTCDate(y.getUTCDate() - 1);
  const yesterday = localDateKey(y);
  let current = 0;
  if (dates.at(-1) === today || dates.at(-1) === yesterday) {
    current = 1;
    for (let i = dates.length - 1; i > 0; i--) {
      const a = new Date(dates[i - 1] + "T12:00:00Z");
      const b = new Date(dates[i] + "T12:00:00Z");
      if (Math.round((b - a) / 86400000) === 1) current++;
      else break;
    }
  }
  return { current, longest };
}

function earnedBadges(state, telegramId) {
  const acts = state.activities.filter(a => a.telegramId === telegramId);
  const replies = acts.filter(a => a.type === "reply").length;
  const quotes = acts.filter(a => a.type === "quote").length;
  const mentions = acts.filter(a => a.type === "mention").length;
  const total = acts.reduce((n, a) => n + a.points, 0);
  const streak = streakInfo(state, telegramId).longest;
  const badges = [];
  if (replies >= 25) badges.push("Frontliner");
  if (quotes >= 10) badges.push("Signal Booster");
  if (mentions >= 10) badges.push("SPEPE Herald");
  if (streak >= 7) badges.push("7-Day Streak");
  if (total >= 250) badges.push("Super Saiyan Supporter");
  if (total >= 1000) badges.push("Legendary Supporter");
  return badges;
}

function countLastHour(state, telegramId, type) {
  const floor = Date.now() - 60 * 60 * 1000;
  return state.activities.filter(a =>
    a.telegramId === telegramId &&
    a.type === type &&
    new Date(a.at).getTime() >= floor
  ).length;
}

function hasQuoteCreditForSource(state, telegramId, sourcePostId) {
  if (!sourcePostId) return false;
  return state.activities.some(a =>
    a.telegramId === telegramId &&
    a.type === "quote" &&
    String(a.sourcePostId || "") === String(sourcePostId)
  );
}

function highlightedToday(state, telegramId) {
  const today = localDateKey();
  return state.activities.some(a =>
    a.telegramId === telegramId &&
    a.highlighted === true &&
    localDateKey(new Date(a.at)) === today
  );
}

async function searchX(query, limit = 30) {
  const params = new URLSearchParams({
    q: query, feed: "latest", format: "json",
    limit: String(limit), nocache: "true"
  });

  let r = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fetch("https://x.pcstyle.dev/api/v1/search?" + params, {
      headers: { "User-Agent": USER_AGENT, "Accept": "application/json" }
    });

    if (r.ok) break;

    if (r.status === 429 && attempt < 2) {
      const waitMs = 1200 * (attempt + 1);
      console.log(`x.md rate limited for "${query}". Retrying in ${waitMs}ms.`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      continue;
    }

    if (r.status === 429) {
      console.log(`x.md still rate limited for "${query}". Skipping this source until the next scan.`);
      return [];
    }

    throw new Error(`x.md search failed: ${r.status}`);
  }

  if (!r?.ok) return [];
  const data = await r.json();
  return (Array.isArray(data.posts) ? data.posts : []).map(t => {
    const id = String(t.id_str || t.id || t.rest_id || "");
    const author = t.user?.screen_name || t.author?.screen_name || t.author?.username || "";
    const text = t.full_text || t.text || t.content || t.legacy?.full_text || "";
    const url = t.url || t.permalink || (id && author ? `https://x.com/${author}/status/${id}` : "");
    const replyTargetId = String(
      t.in_reply_to_status_id_str ||
      t.inReplyToId ||
      t.inReplyToTweetId ||
      t.legacy?.in_reply_to_status_id_str ||
      ""
    );

    const replyTargetAuthor =
      t.in_reply_to_screen_name ||
      t.inReplyToScreenName ||
      t.replyingTo ||
      t.legacy?.in_reply_to_screen_name ||
      "";

    const quoted =
      t.quoted_status ||
      t.quotedStatus ||
      t.quoted_tweet ||
      t.quotedTweet ||
      t.quote ||
      null;

    const quoteTargetAuthor =
      quoted?.user?.screen_name ||
      quoted?.author?.screen_name ||
      quoted?.author?.username ||
      "";

    let quoteTargetId = String(
      t.quoted_status_id_str ||
      t.quotedStatusId ||
      quoted?.id_str ||
      quoted?.id ||
      quoted?.rest_id ||
      ""
    );

    if (!quoteTargetId) {
      const match = text.match(/https?:\/\/(?:www\.)?x\.com\/SaiyanPEPE\/status\/(\d+)/i);
      if (match) quoteTargetId = match[1];
    }

    return {
      id, author, text,
      url: url.startsWith("http") ? url : `https://x.com${url}`,
      replyTargetId,
      replyTargetAuthor,
      quoteTargetId,
      quoteTargetAuthor,
      reply: Boolean(
        replyTargetId || t.replyingTo
      ),
      quote: Boolean(
        quoteTargetId || quoted
      )
    };
  }).filter(p => p.id && p.author && p.url);
}

function linkedIdByHandle(state, handle) {
  const h = handle.toLowerCase();
  return Object.entries(state.links)
    .find(([, link]) => String(link.handle).toLowerCase() === h)?.[0] || null;
}

function classify(post, spepePostIds = new Set(), sources = new Set()) {
  if (/SPEPE-LINK-[A-Z0-9]+/i.test(post.text)) return "verification";

  const quotesSpepe =
    post.quoteTargetAuthor?.toLowerCase() === X_HANDLE.toLowerCase() ||
    (post.quoteTargetId && spepePostIds.has(String(post.quoteTargetId))) ||
    /https?:\/\/(?:www\.)?x\.com\/SaiyanPEPE\/status\//i.test(post.text) ||
    sources.has("quote");

  const repliesSpepe =
    post.replyTargetAuthor?.toLowerCase() === X_HANDLE.toLowerCase() ||
    (post.replyTargetId && spepePostIds.has(String(post.replyTargetId))) ||
    sources.has("reply");

  if (quotesSpepe) return "quote";
  if (repliesSpepe) return "reply";
  if (/\$SPEPE\b|@SaiyanPEPE\b/i.test(post.text)) return "mention";
  return null;
}

async function handleVerification(state, post) {
  const matches = Object.entries(state.pendingLinks).filter(([, p]) =>
    p.handle.toLowerCase() === post.author.toLowerCase() &&
    post.text.includes(p.code)
  );

  for (const [telegramId, pending] of matches) {
    state.links[telegramId] = {
      handle: pending.handle,
      linkedAt: new Date().toISOString()
    };
    delete state.pendingLinks[telegramId];

    await sendText(telegramId, [
      `✅ Linked @${pending.handle} successfully.`,
      "",
      "Your verification post did not earn points.",
      "Use /rank to see your standing and /top weekly to see the leaderboard."
    ].join("\n"));
  }

  return matches.length > 0;
}

async function announceCommunityPost(post, type, points) {
  if (!TELEGRAM_CHAT_ID) return;
  const title = type === "quote"
    ? `🔥 COMMUNITY QUOTE +${points}`
    : `⚡ COMMUNITY MENTION +${points}`;
  const body = post.text.replace(/https?:\/\/\S+/gi, "").trim();
  await sendText(TELEGRAM_CHAT_ID, [
    title,
    `@${post.author} is showing support.`,
    "",
    body.slice(0, 900),
    "",
    post.url
  ].filter(Boolean).join("\n"));
}

async function maybeMilestone(state, telegramId) {
  const total = periodScore(state, telegramId, "all");
  const seen = new Set(state.milestoneSeen[telegramId] || []);
  const newly = MILESTONES.filter(m => total >= m && !seen.has(m));
  if (!newly.length) return;
  state.milestoneSeen[telegramId] = [...seen, ...newly].sort((a,b)=>a-b);
  const handle = state.links[telegramId]?.handle;
  if (TELEGRAM_CHAT_ID && handle) {
    await sendText(TELEGRAM_CHAT_ID,
      `🏅 @${handle} just crossed ${newly.at(-1)} community support points!`
    );
  }
}

async function scanCommunity(state) {
  const linkedHandles = Object.values(state.links)
    .map(link => cleanHandle(link.handle || ""))
    .filter(Boolean);

  const pendingHandles = Object.values(state.pendingLinks)
    .filter(p => {
      const created = new Date(p.createdAt || 0).getTime();
      return created && Date.now() - created <= 24 * 60 * 60 * 1000;
    })
    .map(p => cleanHandle(p.handle || ""))
    .filter(Boolean)
    .slice(0, 10);

  const [replies, mentions, quoteSearch, spepePosts, ...userFeeds] = await Promise.all([
    searchX(`to:${X_HANDLE}`, 30),
    searchX(`$SPEPE OR @${X_HANDLE}`, 30),
    searchX(`url:x.com/${X_HANDLE}/status`, 30),
    searchX(`from:${X_HANDLE}`, 100),
    ...linkedHandles.slice(0, 20).map(handle => searchX(`from:${handle}`, 20)),
    ...pendingHandles.map(handle => searchX(`from:${handle}`, 10))
  ]);

  const linkedFeeds = userFeeds.slice(0, linkedHandles.slice(0, 20).length);
  const pendingFeeds = userFeeds.slice(linkedHandles.slice(0, 20).length);

  const spepePostIds = new Set(spepePosts.map(p => String(p.id)));

  const map = new Map();
  for (const [source, arr] of [["reply", replies], ["mention", mentions], ["quote", quoteSearch]]) {
    for (const p of arr) {
      const existing = map.get(p.id) || { ...p, sources: new Set() };
      existing.sources.add(source);
      if (source === "reply") existing.reply = true;
      if (source === "quote") existing.quote = true;
      map.set(p.id, existing);
    }
  }

  for (const arr of linkedFeeds) {
    for (const p of arr) {
      const existing = map.get(p.id) || { ...p, sources: new Set() };
      existing.sources.add("linked-feed");
      if (p.reply) existing.reply = true;
      if (p.quote) existing.quote = true;
      map.set(p.id, existing);
    }
  }

  for (const arr of pendingFeeds) {
    for (const p of arr) {
      const existing = map.get(p.id) || { ...p, sources: new Set() };
      existing.sources.add("pending-feed");
      if (p.reply) existing.reply = true;
      if (p.quote) existing.quote = true;
      map.set(p.id, existing);
    }
  }

  const current = [...map.values()]
    .filter(p => p.author.toLowerCase() !== X_HANDLE.toLowerCase())
    .sort((a,b) => BigInt(a.id) > BigInt(b.id) ? 1 : -1);

  const seen = new Set(state.seen);

  if (!state.initialized) {
    for (const p of current) seen.add(p.id);
    state.seen = [...seen].slice(-1500);
    state.initialized = true;
    console.log(`Initialized community scanner with ${current.length} existing posts.`);
    return;
  }

  for (const post of current) {
    if (seen.has(post.id)) continue;
    seen.add(post.id);

    if (await handleVerification(state, post)) {
      console.log(`Verified link from @${post.author}`);
      continue;
    }

    const type = classify(post, spepePostIds, post.sources || new Set());
    if (!POINTS[type]) continue;

    if ((type === "reply" || type === "quote")) {
      const sourceId = type === "quote" ? post.quoteTargetId : post.replyTargetId;
      const sourceConfirmedBySearch =
        type === "reply" &&
        post.sources?.has("reply");

      if (sourceId) {
        if (!isWithinDaysBySnowflake(sourceId, 5)) {
          console.log(`Old ${type} source ignored for @${post.author}: ${sourceId}`);
          continue;
        }
      } else if (!sourceConfirmedBySearch) {
        console.log(`Unverifiable ${type} source ignored for @${post.author}: missing source ID`);
        continue;
      }
    }

    const telegramId = linkedIdByHandle(state, post.author);
    if (!telegramId) continue;

    if (countLastHour(state, telegramId, type) >= HOURLY_CAPS[type]) {
      console.log(`Rolling hourly ${type} cap reached for @${post.author}`);
      continue;
    }

    if (type === "quote" && hasQuoteCreditForSource(state, telegramId, post.quoteTargetId)) {
      console.log(`Duplicate quote source ignored for @${post.author}: ${post.quoteTargetId}`);
      continue;
    }

    const points = POINTS[type];
    const weeklyRank = rows(state, "weekly").findIndex(r => r.telegramId === telegramId) + 1;
    const announcementTop = Number(state.announcementTop || 0);
    const shouldHighlight =
      announcementTop > 0 &&
      weeklyRank > 0 &&
      weeklyRank <= announcementTop &&
      (type === "quote" || type === "mention") &&
      !highlightedToday(state, telegramId);

    state.activities.push({
      id: post.id,
      telegramId,
      handle: post.author,
      type,
      points,
      sourcePostId: type === "quote" ? (post.quoteTargetId || null) : (type === "reply" ? (post.replyTargetId || null) : null),
      highlighted: shouldHighlight,
      url: post.url,
      raidEligible: true,
      raidDate: localDateKey(),
      at: new Date().toISOString()
    });
    state.activities = state.activities.slice(-5000);

    if (shouldHighlight) {
      try { await announceCommunityPost(post, type, points); } catch {}
    }

    await maybeMilestone(state, telegramId);
  }

  state.seen = [...seen].slice(-1500);
}


async function raidListText(state) {
  const today = localDateKey();
  const suppressed = new Set(todaySuppressed(state).map(String));

  let official = [];
  try {
    official = (await searchX(`from:${X_HANDLE} -filter:replies`, 20))
      .filter(p => !p.reply)
      .filter(p => localDateKey(snowflakeDate(p.id) || new Date(0)) === today)
      .filter(p => !suppressed.has(String(p.id)))
      .slice(0, 10);
  } catch {}

  const community = state.activities
    .filter(a => raidActivityEligible(a, today))
    .filter(a => a.type !== "reply")
    .filter(a => !suppressed.has(String(a.id)))
    .sort((a,b) => Number(b.points || 0) - Number(a.points || 0) || new Date(b.at) - new Date(a.at))
    .slice(0, 20);

  const lines = [
    "🐸⚡ SPEPE RAID BOARD",
    "",
    "Pick a target. Drop a real reply. Push the signal.",
    ""
  ];

  lines.push("🔥 OFFICIAL SAIYANPEPE POSTS");
  if (!official.length) lines.push("No official posts added today.");
  official.forEach((p,i) => {
    lines.push(`${i + 1}) ${p.url}`);
  });

  lines.push("", "⚡ COMMUNITY SIGNALS");
  if (!community.length) lines.push("No community posts on the board yet.");
  community.forEach((a,i) => {
    lines.push(`${i + 1}) @${a.handle} • ${typeLabel(a.type)} • +${a.points} pts`);
    lines.push(a.url);
  });

  lines.push("", "Raid Board resets daily.");
  return lines.join("\n");
}


async function raidRepliesText(state) {
  const today = localDateKey();
  const suppressed = new Set(todaySuppressed(state).map(String));

  let officialReplies = [];
  let communityReplies = [];

  try {
    const [officialAll, officialOriginals, communityFeed] = await Promise.all([
      searchX(`from:${X_HANDLE}`, 100),
      searchX(`from:${X_HANDLE} -filter:replies`, 100),
      searchX(`to:${X_HANDLE}`, 100)
    ]);

    const originalIds = new Set(officialOriginals.map(p => String(p.id)));

    officialReplies = officialAll
      .filter(p => !originalIds.has(String(p.id)))
      .filter(p => localDateKey(snowflakeDate(p.id) || new Date(0)) === today)
      .filter(p => !suppressed.has(String(p.id)))
      .sort((a,b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1);

    communityReplies = communityFeed
      .filter(p => p.author.toLowerCase() !== X_HANDLE.toLowerCase())
      .filter(p => localDateKey(snowflakeDate(p.id) || new Date(0)) === today)
      .filter(p => !suppressed.has(String(p.id)))
      .sort((a,b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1);
  } catch (err) {
    console.error("Raid Replies live search failed:", err);
  }

  const lines = [
    "⚡ SPEPE REPLY RAID",
    "",
    "Fresh replies from today. This list is live and does not depend on scoring or whether a post was already seen.",
    "",
    "🔥 OFFICIAL SPEPE REPLIES"
  ];

  if (!officialReplies.length) {
    lines.push("No official SPEPE replies found today.");
  } else {
    officialReplies.forEach((p,i) => {
      lines.push(`${i + 1}) @${X_HANDLE} • Reply`);
      lines.push(p.url, "");
    });
  }

  lines.push("", "⚡ COMMUNITY REPLIES");

  if (!communityReplies.length) {
    lines.push("No community replies found today.");
  } else {
    communityReplies.forEach((p,i) => {
      lines.push(`${i + 1}) @${p.author} • Reply`);
      lines.push(p.url, "");
    });
  }

  lines.push("", "Reply Raid resets daily.");
  return lines.join("\n");
}

function topText(state, period) {
  const label = period === "weekly" ? "THIS WEEK" : period === "monthly" ? "THIS MONTH" : "ALL TIME";
  const top = rows(state, period).slice(0, 10);
  if (!top.length) return "No ranked supporters yet.";
  return [
    `🏆 SPEPE TOP 10 — ${label}`,
    "",
    ...top.map((r, i) => `${i + 1}. @${r.handle} — ${r.score} pts`)
  ].join("\n");
}

async function handleCommand(state, update) {
  const message = update?.message || update?.channel_post;
  const from = message?.from;
  const chat = message?.chat;
  const text = message?.text?.trim() || "";
  if (!chat?.id || !text.startsWith("/")) return;

  const [raw, ...args] = text.split(/\s+/);
  const cmd = raw.toLowerCase().split("@")[0];
  const id = from?.id ? String(from.id) : "";

  if (cmd === "/start" && String(args[0] || "").toLowerCase() === "raidreplies") {
    if (chat.type !== "private") {
      return sendText(chat.id, "Open this with me in DM to view the reply raid list.");
    }

    try {
      if (message?.message_id) {
        await tg("deleteMessage", {
          chat_id: chat.id,
          message_id: message.message_id
        });
      }
    } catch {}

    return sendText(chat.id, await raidRepliesText(state));
  }

  if (cmd === "/start" || cmd === "/help") {
    await sendText(chat.id, [
      "🐸 SPEPE Community Support",
      "",
      "/link @YourXHandle — connect your X account",
      "/rank — your weekly, monthly, and all-time rank",
      "/top weekly — weekly Top 10",
      "/top monthly — monthly Top 10",
      "/top all — all-time Top 10",
      "/badges — your earned titles",
      "/streak — your activity streak",
      "/raidlist — today's SPEPE Raid Board",
      "/raidreplies — today's reply raid list (DM only)",
      "",
      "Points:",
      "Replies = 1",
      "Quote posts = 2",
      "Original $SPEPE/@SaiyanPEPE mentions = 3",
      "",
      "Anti-spam:",
      "Up to 3 counted replies, quotes, and mentions per rolling hour.",
      "Only one quote per SaiyanPEPE post can earn points.",
      "Only one community highlight per person per day.",
      "Replies and quote posts only score when the SaiyanPEPE source post is 5 days old or newer."
    ].join("\n"));
    return;
  }

  if (cmd === "/link") {
    if (!id) return sendText(chat.id, "🔒 Account linking must be done in a private chat with the bot.");
    if (chat.type !== "private") {
      return sendText(chat.id, "🔒 Account linking happens in my DMs. Open a private chat with me and use /link @YourXHandle.");
    }
    const handle = cleanHandle(args[0] || "");
    if (!handle) return sendText(chat.id, "Use /link @YourXHandle");

    const claimed = Object.entries(state.links).find(
      ([otherId, link]) => otherId !== id && link.handle.toLowerCase() === handle.toLowerCase()
    );
    if (claimed) return sendText(chat.id, `@${handle} is already linked.`);

    const code = randomCode();
    state.pendingLinks[id] = {
      handle, code, createdAt: new Date().toISOString()
    };

    await sendText(chat.id, [
      `Linking @${escapeHtml(handle)}.`,
      "",
      "Post this exact code on X in either:",
      "• a reply to @SaiyanPEPE, or",
      "• an original post that mentions @SaiyanPEPE",
      "",
      `<pre>${escapeHtml(code)}</pre>`,
      "Tap the code block above to copy it.",
      "",
      "That's it. You do NOT need to send me the X link.",
      "The regular SPEPE activity scan will detect your code and link the account automatically.",
      "",
      "⏳ Verification is checked regularly. It usually takes a few minutes, but may occasionally take longer.",
      "I'll DM you automatically once your X account is verified.",
      "Verification posts do not earn points."
    ].join("\n"), { parse_mode: "HTML" });
    return;
  }


  if (cmd === "/raidreplies") {
    if (chat.type !== "private") {
      return sendText(chat.id, "🔒 Reply raids are sent privately. Use the ⚡ Raid Replies button under /raidlist.");
    }
    return sendText(chat.id, raidRepliesText(state));
  }

  if (cmd === "/raidlist") {
    if (chat.type !== "private") {
      const last = Number(state.raidLastPublicAt[String(chat.id)] || 0);
      if (Date.now() - last < 2 * 60 * 1000) {
        return sendText(chat.id, "⚡ Raid Board was just called. Give it a minute before summoning it again.");
      }
      state.raidLastPublicAt[String(chat.id)] = Date.now();
    }
    return sendText(chat.id, await raidListText(state), {
      reply_markup: {
        inline_keyboard: [[
          {
            text: "⚡ Raid Replies",
            url: "https://t.me/SPEPE_bot?start=raidreplies"
          }
        ]]
      }
    });
  }

  if (cmd === "/raidsettings") {
    const admin = await isOwnerOrAdmin(id);
    const label = Number(state.announcementTop || 0) === 0 ? "Nobody" : `Top ${state.announcementTop} weekly supporters`;
    const lines = [
      "⚙️ SPEPE RAID SETTINGS",
      "",
      `Automatic announcements: ${label}`,
      "Raid Board resets daily.",
      "Public /raidlist cooldown: 2 minutes."
    ];
    if (admin) lines.push("", "Admin: /announcements none|1|5|10|25|50|100", "/raidremove <post number or X post ID>", "/raidclear");
    return sendText(chat.id, lines.join("\n"));
  }

  if (cmd === "/announcements") {
    if (!id) return sendText(chat.id, "Run this admin command from your user account in a group or DM.");
    if (!(await isOwnerOrAdmin(id))) return sendText(chat.id, "Admin only.");
    const rawChoice = String(args[0] || "").toLowerCase().replace(/^top/, "");
    const n = rawChoice === "none" ? 0 : Number(rawChoice);
    if (![0,1,5,10,25,50,100].includes(n)) {
      return sendText(chat.id, "Use /announcements none, 1, 5, 10, 25, 50, or 100.");
    }
    state.announcementTop = n;
    return sendText(chat.id, n === 0
      ? "📣 Automatic community post announcements are now off."
      : `📣 Automatic community post announcements are now limited to the Top ${n} weekly supporters.`);
  }

  if (cmd === "/raidclear") {
    if (!id) return sendText(chat.id, "Run this admin command from your user account in a group or DM.");
    if (!(await isOwnerOrAdmin(id))) return sendText(chat.id, "Admin only.");
    const today = localDateKey();
    const ids = state.activities.filter(a => raidActivityEligible(a, today)).map(a => String(a.id));
    state.raidSuppressed[today] = [...new Set([...(state.raidSuppressed[today] || []), ...ids])];
    return sendText(chat.id, "🧹 Today's community Raid Board has been cleared.");
  }

  if (cmd === "/raidremove") {
    if (!id) return sendText(chat.id, "Run this admin command from your user account in a group or DM.");
    if (!(await isOwnerOrAdmin(id))) return sendText(chat.id, "Admin only.");
    const arg = String(args[0] || "").trim();
    if (!arg) return sendText(chat.id, "Use /raidremove <community number or X post ID>.");

    const today = localDateKey();
    const community = state.activities
      .filter(a => raidActivityEligible(a, today))
      .filter(a => !(state.raidSuppressed[today] || []).includes(String(a.id)))
      .sort((a,b) => Number(b.points || 0) - Number(a.points || 0) || new Date(b.at) - new Date(a.at))
      .slice(0, 20);

    let postId = /^\d+$/.test(arg) && Number(arg) >= 1 && Number(arg) <= community.length
      ? String(community[Number(arg)-1].id)
      : arg.match(/status\/(\d+)/)?.[1] || (/^\d{10,}$/.test(arg) ? arg : "");

    if (!postId) return sendText(chat.id, "I couldn't identify that Raid Board post.");
    const list = todaySuppressed(state);
    if (!list.includes(String(postId))) list.push(String(postId));
    return sendText(chat.id, `🗑️ Removed post ${postId} from today's Raid Board.`);
  }

  if (cmd === "/rank") {
    if (!id) return sendText(chat.id, "Use /rank from a user chat or group message so I can identify your account.");
    const link = state.links[id];
    if (!link) return sendText(chat.id, "You are not linked yet. Use /link @YourXHandle.");
    const weekly = rows(state, "weekly").findIndex(r => r.telegramId === id) + 1;
    const monthly = rows(state, "monthly").findIndex(r => r.telegramId === id) + 1;
    const all = rows(state, "all").findIndex(r => r.telegramId === id) + 1;
    await sendText(chat.id, [
      `@${link.handle}`,
      "",
      `Weekly: #${weekly} — ${periodScore(state,id,"weekly")} pts`,
      `Monthly: #${monthly} — ${periodScore(state,id,"monthly")} pts`,
      `All-Time: #${all} — ${periodScore(state,id,"all")} pts`
    ].join("\n"));
    return;
  }

  if (cmd === "/top") {
    const p = (args[0] || "weekly").toLowerCase();
    const period = p.startsWith("month") ? "monthly" : p === "all" || p.startsWith("overall") ? "all" : "weekly";
    return sendText(chat.id, topText(state, period));
  }

  if (cmd === "/badges") {
    if (!id) return sendText(chat.id, "Use /badges from a user chat or group message so I can identify your account.");
    const link = state.links[id];
    if (!link) return sendText(chat.id, "Link your X account first with /link @YourXHandle.");
    const b = earnedBadges(state, id);
    return sendText(chat.id, b.length ? `🏅 Your badges:\n\n${b.map(x=>"• "+x).join("\n")}` : "No badges yet. Keep supporting the community.");
  }

  if (cmd === "/streak") {
    if (!id) return sendText(chat.id, "Use /streak from a user chat or group message so I can identify your account.");
    const link = state.links[id];
    if (!link) return sendText(chat.id, "Link your X account first with /link @YourXHandle.");
    const s = streakInfo(state,id);
    return sendText(chat.id, `🔥 Current streak: ${s.current} day(s)\n🏆 Longest streak: ${s.longest} day(s)`);
  }
}

async function maybePromo(state) {
  if (!TELEGRAM_CHAT_ID) return;
  const p = nowChicagoParts();
  const date = localDateKey();
  if (state.lastPromoDate === date) return;
  if (Number(p.hour) !== 11 || Number(p.minute) < 25 || Number(p.minute) > 40) return;

  await sendText(TELEGRAM_CHAT_ID, [
    "⚡ WANT TO SUPPORT THE COMMUNITY? PROVE IT.",
    "",
    "Reply. Quote. Post.",
    "",
    "1 pt — reply to @SaiyanPEPE",
    "2 pts — quote a SaiyanPEPE post",
    "3 pts — make an original post mentioning $SPEPE or @SaiyanPEPE",
    "",
    "Weekly, monthly, and all-time rankings are tracked.",
    "",
    "DM the bot and use /link @YourXHandle to start showing support today!"
  ].join("\n"));
  state.lastPromoDate = date;
}

async function maybeWeeklyRecap(state) {
  if (!TELEGRAM_CHAT_ID) return;
  const p = nowChicagoParts();
  if (p.weekday !== "Sun" || Number(p.hour) !== 19) return;
  const key = weekStartKey();
  if (state.lastWeeklyRecapKey === key) return;

  const start = weekStartKey();
  const weekActs = state.activities.filter(a => weekStartKey(new Date(a.at)) === start);
  const replies = weekActs.filter(a=>a.type==="reply").length;
  const quotes = weekActs.filter(a=>a.type==="quote").length;
  const mentions = weekActs.filter(a=>a.type==="mention").length;

  await sendText(TELEGRAM_CHAT_ID, [
    "🐸 SPEPE WEEKLY COMMUNITY RECAP",
    "",
    `${replies} replies`,
    `${quotes} quote posts`,
    `${mentions} original mentions`,
    "",
    topText(state, "weekly")
  ].join("\n"));

  state.lastWeeklyRecapKey = key;
}

async function main() {
  const state = await readState();

  if (COMMUNITY_MODE === "command") {
    if (!TELEGRAM_UPDATE_JSON) return;
    await handleCommand(state, JSON.parse(TELEGRAM_UPDATE_JSON));
  } else {
    await scanCommunity(state);
    await maybePromo(state);
    await maybeWeeklyRecap(state);
  }

  await writeState(state);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
