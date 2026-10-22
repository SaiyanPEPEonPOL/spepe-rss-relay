// Explicit relationship types take precedence over text mentions.
// Missing reference metadata remains "unknown" rather than guessing.
export function normalizeXPost(tweet, workspaceId = "spepe", source = "x-api") {
  const id = String(tweet.id || tweet.id_str || "");
  if (!/^\d+$/.test(id)) throw new Error("Invalid X post ID");
  const authorHandle = String(tweet.author_handle || tweet.author?.username || tweet.user?.screen_name || "").replace(/^@/, "");
  if (!authorHandle) throw new Error("Missing author handle");
  const text = String(tweet.text ?? tweet.full_text ?? "");
  const refs = Array.isArray(tweet.referenced_tweets) ? tweet.referenced_tweets : [];
  const findRef = type => refs.find(ref => ref.type === type);
  const reply = findRef("replied_to");
  const quote = findRef("quoted");
  const repost = findRef("retweeted");
  const kind = repost ? "repost" : quote ? "quote" : reply ? "reply" : refs.length ? "unknown" : "original";
  const created = tweet.created_at || new Date(Number((BigInt(id) >> 22n) + 1288834974657n)).toISOString();
  const date = new Date(created);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid post timestamp");
  return {
    workspace_id: workspaceId, id, author_handle: authorHandle,
    author_id: tweet.author_id ? String(tweet.author_id) : null,
    text, created_at: date.toISOString(), kind,
    reply_to_post_id: reply?.id ? String(reply.id) : null,
    reply_to_author: reply?.author_handle || null,
    quote_post_id: quote?.id ? String(quote.id) : null,
    quote_author: quote?.author_handle || null,
    repost_post_id: repost?.id ? String(repost.id) : null,
    repost_author: repost?.author_handle || null,
    url: `https://x.com/${authorHandle}/status/${id}`,
    source
  };
}
