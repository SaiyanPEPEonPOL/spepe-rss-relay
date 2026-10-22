CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tracked_handle TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO workspaces(id,name,tracked_handle) VALUES ('spepe','SPEPE','SaiyanPEPE');

CREATE TABLE IF NOT EXISTS posts (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  author_handle TEXT NOT NULL,
  author_id TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('original','reply','quote','repost','unknown')),
  reply_to_post_id TEXT,
  reply_to_author TEXT,
  quote_post_id TEXT,
  quote_author TEXT,
  repost_post_id TEXT,
  repost_author TEXT,
  url TEXT NOT NULL,
  source TEXT NOT NULL,
  raw_json TEXT,
  indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS posts_by_time ON posts(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS posts_by_author ON posts(workspace_id, author_handle, created_at DESC);
CREATE INDEX IF NOT EXISTS posts_by_kind ON posts(workspace_id, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS ingestion_state (
  workspace_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  last_post_id TEXT,
  checked_at TEXT,
  last_error TEXT,
  PRIMARY KEY (workspace_id, source_key)
);
