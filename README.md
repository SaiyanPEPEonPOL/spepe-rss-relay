# SPEPE RSS Relay

A tiny feed-agnostic relay that checks an RSS/Atom feed for new X posts and forwards new items to Discord and Telegram.

## Required GitHub secrets

Add these under **Settings → Secrets and variables → Actions**:

- `RSS_URL` — an RSS/Atom feed for the X account
- `DISCORD_WEBHOOK_URL` — optional if you only want Telegram
- `TELEGRAM_BOT_TOKEN` — optional if you only want Discord
- `TELEGRAM_CHAT_ID` — required with the Telegram bot token

At least one destination must be configured.

## First run

Run **Actions → SPEPE RSS Relay → Run workflow**.

The first run records existing feed items and sends nothing so old posts do not flood your channels.

## Schedule

The workflow checks every 5 minutes.

## Security

Never commit Discord webhook URLs, Telegram bot tokens, account cookies, or other credentials into this repository. Use GitHub Actions secrets.
