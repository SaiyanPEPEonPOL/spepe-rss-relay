# SPEPE Social Index (shadow mode)

Independent Cloudflare Worker + D1 database for normalized X activity. **Does not change production relay or community scoring.** X API collection is disabled by default to avoid surprise charges.

## Setup

1. Cloudflare > D1 > Create database: `spepe-social-index`.
2. Obtain the D1 database ID and replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.jsonc`.
3. From this folder, run `npx wrangler d1 execute spepe-social-index --remote --file=schema.sql`.
4. Deploy a **separate** Worker: `npx wrangler deploy`. Do not overwrite `communityworker` or the relay timer.
5. Set Worker **secrets** (not plain variables): `INDEX_READ_TOKEN` and `INDEX_WRITE_TOKEN` to different long random values. Do not paste them in chat.
6. Check `/health`: it should return `status: ready` and `ingestion_enabled: false`.
7. Optional shadow data: POST `/v1/ingest` with `Authorization: Bearer <INDEX_WRITE_TOKEN>` and JSON `{"workspace":"spepe","posts":[{"id":"...","author_handle":"SaiyanPEPE","text":"example","referenced_tweets":[]}]}`. A true post timestamp is preferable to the derived snowflake timestamp.
8. GET `/v1/posts?workspace=spepe&limit=20` with `Authorization: Bearer <INDEX_READ_TOKEN>`.

## Optional official X API ingest

Requires your own valid X API developer access. Confirm endpoint access and pricing in your account before enabling. Add secret `X_BEARER_TOKEN` and only after budgeting change `ENABLE_X_INGESTION` to `true`. Run POST `/v1/collect` with write auth for controlled testing. Keep cron disabled until quality and costs are validated. Be mindful of search result pagination: this first adapter only fetches one page per invocation.

## Normalization rules

Native X `referenced_tweets` determines reply/quote/repost. Plain reposts cannot masquerade as original mentions. If metadata is unknown, do not infer a relationship from the text alone. Missing author IDs/handle mappings are skipped, not guessed. Normalize and store once, read many times.

## Guardrails before production cutover

- Compare indexed records with real post URLs from known originals, replies, quotes and reposts.
- Test API coverage (including recent search's rolling history), rate-limit behavior and pagination.
- Implement source-author validation and a watermark/backfill strategy.
- Keep X API spend capped and monitored outside the worker.
- Add per-workspace query rules beyond the current SPEPE-focused starter query.
- Replace `searchX` only after accuracy checks; preserve rollback to x.md.

This is an **initial service scaffold**, not an active x.md replacement.
