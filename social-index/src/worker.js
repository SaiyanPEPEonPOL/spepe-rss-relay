import { normalizeXPost } from "./normalize.js";

const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
const isAuthorized = (request, secret) =>
  !!secret && request.headers.get("authorization") === `Bearer ${secret}`;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(Number(n)) ? Number(n) : lo));
const columns = ["workspace_id","id","author_handle","author_id","text","created_at","kind","reply_to_post_id","reply_to_author","quote_post_id","quote_author","repost_post_id","repost_author","url","source","raw_json"];

async function upsert(db, post, raw) {
  const payload = { ...post, raw_json: JSON.stringify(raw).slice(0, 50000) };
  const params = columns.map(k => payload[k] ?? null);
  await db.prepare(`INSERT INTO posts (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})
    ON CONFLICT(workspace_id,id) DO UPDATE SET
    author_handle=excluded.author_handle,author_id=excluded.author_id,
    text=excluded.text,created_at=excluded.created_at,kind=excluded.kind,
    reply_to_post_id=excluded.reply_to_post_id,reply_to_author=excluded.reply_to_author,
    quote_post_id=excluded.quote_post_id,quote_author=excluded.quote_author,
    repost_post_id=excluded.repost_post_id,repost_author=excluded.repost_author,
    url=excluded.url,source=excluded.source,raw_json=excluded.raw_json,
    indexed_at=CURRENT_TIMESTAMP`).bind(...params).run();
}

async function getPosts(db, url) {
  const ws = url.searchParams.get("workspace") || "spepe";
  const kind = url.searchParams.get("kind");
  const author = url.searchParams.get("author")?.replace(/^@/, "").toLowerCase();
  const since = url.searchParams.get("since");
  const limit = Math.floor(clamp(url.searchParams.get("limit") || 50, 1, 100));
  const clauses = ["workspace_id = ?"]; const values = [ws];
  if (kind) { clauses.push("kind = ?"); values.push(kind); }
  if (author) { clauses.push("lower(author_handle) = ?"); values.push(author); }
  if (since) { clauses.push("created_at >= ?"); values.push(since); }
  const result = await db.prepare(`SELECT workspace_id,id,author_handle,author_id,text,created_at,kind,reply_to_post_id,reply_to_author,quote_post_id,quote_author,repost_post_id,repost_author,url,source FROM posts WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`).bind(...values,limit).all();
  return { workspace: ws, posts: result.results || [], count: result.results?.length || 0 };
}

async function fetchXRecent(env, workspace = "spepe") {
  if (!env.X_BEARER_TOKEN) return { skipped: "X_BEARER_TOKEN not configured" };
  // Explicit opt-in prevents unplanned chargeable reads.
  if (env.ENABLE_X_INGESTION !== "true") return { skipped: "ENABLE_X_INGESTION is not true" };
  const ws = await env.DB.prepare("SELECT * FROM workspaces WHERE id = ?").bind(workspace).first();
  if (!ws) throw new Error("Unknown workspace");
  const key = "recent-search";
  const state = await env.DB.prepare("SELECT last_post_id FROM ingestion_state WHERE workspace_id = ? AND source_key = ?").bind(workspace,key).first();
  const query = `(from:${ws.tracked_handle} OR to:${ws.tracked_handle} OR @${ws.tracked_handle} OR $SPEPE)`;
  const params = new URLSearchParams({
    query, max_results:"100",
    "tweet.fields":"author_id,created_at,referenced_tweets",
    "expansions":"author_id,referenced_tweets.id,referenced_tweets.id.author_id",
    "user.fields":"username"
  });
  if (state?.last_post_id) params.set("since_id", state.last_post_id);
  const response = await fetch(`https://api.x.com/2/tweets/search/recent?${params}`, {
    headers: { Authorization: `Bearer ${env.X_BEARER_TOKEN}` }
  });
  if (!response.ok) {
    const error = `HTTP ${response.status}: ${(await response.text()).slice(0, 250)}`;
    await env.DB.prepare(`INSERT INTO ingestion_state(workspace_id,source_key,checked_at,last_error) VALUES(?,?,?,?)
       ON CONFLICT(workspace_id,source_key) DO UPDATE SET checked_at=excluded.checked_at,last_error=excluded.last_error`)
      .bind(workspace,key,new Date().toISOString(),error).run();
    throw new Error(error);
  }
  const data = await response.json();
  const users = new Map((data.includes?.users || []).map(u => [String(u.id),u.username]));
  const referenced = new Map((data.includes?.tweets || []).map(t => [String(t.id),t]));
  let maxId = state?.last_post_id || "0";
  let count = 0;
  for (const t of (data.data || [])) {
    const enriched = {
      ...t,
      author_handle:users.get(String(t.author_id)),
      referenced_tweets:(t.referenced_tweets || []).map(ref => ({
        ...ref, author_handle:users.get(String(referenced.get(String(ref.id))?.author_id)) || null
      }))
    };
    if (!enriched.author_handle) continue;
    const normalized = normalizeXPost(enriched,workspace,"x-api");
    await upsert(env.DB,normalized,enriched);
    if (BigInt(t.id) > BigInt(maxId)) maxId = String(t.id);
    count++;
  }
  await env.DB.prepare(`INSERT INTO ingestion_state(workspace_id,source_key,last_post_id,checked_at,last_error) VALUES(?,?,?,?,NULL)
      ON CONFLICT(workspace_id,source_key) DO UPDATE SET last_post_id=excluded.last_post_id,checked_at=excluded.checked_at,last_error=NULL`)
    .bind(workspace,key,maxId,new Date().toISOString()).run();
  return { workspace, indexed:count, newest_id:maxId };
}

export default {
  async fetch(request,env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ service:"SPEPE Social Index", status:env.DB ? "ready":"database_not_bound", ingestion_enabled:env.ENABLE_X_INGESTION === "true" });
    if (!env.DB) return json({ error:"Bind a D1 database as DB" },503);
    try {
      if (url.pathname === "/v1/posts" && request.method === "GET") {
        if (!isAuthorized(request,env.INDEX_READ_TOKEN)) return json({error:"unauthorized"},401);
        return json(await getPosts(env.DB,url));
      }
      if (url.pathname === "/v1/ingest" && request.method === "POST") {
        if (!isAuthorized(request,env.INDEX_WRITE_TOKEN)) return json({error:"unauthorized"},401);
        const body=await request.json();
        const workspace=body.workspace || "spepe";
        if (!Array.isArray(body.posts) || body.posts.length>100) return json({error:"Expected posts array of <=100"},400);
        let indexed=0;
        for(const raw of body.posts) { await upsert(env.DB,normalizeXPost(raw,workspace,"manual"),raw); indexed++; }
        return json({indexed});
      }
      if (url.pathname === "/v1/collect" && request.method === "POST") {
        if (!isAuthorized(request,env.INDEX_WRITE_TOKEN)) return json({error:"unauthorized"},401);
        return json(await fetchXRecent(env));
      }
      return json({error:"not_found"},404);
    } catch(err) { console.error("social-index:",err);return json({error:String(err.message||err).slice(0,200)},500); }
  },
  async scheduled(event,env,ctx) {
    if (env.ENABLE_X_INGESTION !== "true" || !env.DB) return;
    ctx.waitUntil(fetchXRecent(env).catch(err=>console.error("social-index cron:",err)));
  }
};
