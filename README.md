# SPEPE X Relay

A free relay for **@SaiyanPEPE** that checks X's public syndication timeline and forwards new posts to Discord and/or Telegram.

No X API key and no RSS feed are required.

## How it works

GitHub Actions runs every 5 minutes and fetches the public embedded timeline for:

`@SaiyanPEPE`

It remembers post IDs in `state.json`, so the same post is not sent twice.

By default it forwards original posts only. Replies and reposts are ignored.

## Required GitHub secrets

Add these under:

**Settings → Secrets and variables → Actions**

### Discord

`DISCORD_WEBHOOK_URL`

### Telegram

`TELEGRAM_BOT_TOKEN`

`TELEGRAM_CHAT_ID`

You can configure Discord only, Telegram only, or both.

There is no longer an `RSS_URL` secret.

## First run

Open:

**Actions → SPEPE X Relay → Run workflow**

The first run records the posts already visible in the X timeline and sends nothing. This prevents old posts from flooding the channels.

After that, new eligible posts are forwarded automatically.

## Settings

The workflow currently uses:

- X handle: `SaiyanPEPE`
- check interval: every 5 minutes
- replies: excluded
- reposts: excluded
- max posts sent in one run: 5

## Important limitation

This uses X's public syndication/embed endpoint rather than the paid X API. It requires no login or API key, but it is unofficial for this use case and X can change or rate-limit it.

If that happens, the Discord/Telegram relay can stay intact and only the X fetcher needs to be replaced.

## Security

Never commit Discord webhook URLs, Telegram bot tokens, cookies, or other credentials into the repository. Store them only as GitHub Actions secrets.
