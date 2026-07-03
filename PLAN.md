# Negent — Implementation Plan

## Context

Build a Telegram bot on **Cloudflare Workers free tier** that aggregates tech/AI/programming news from international RSS feeds, summarizes and translates them to Persian (informal tone) using Google Gemini free API, and sends each article as a separate Telegram message every 3 hours. No VPS, no paid services.

## Architecture

3 Cron Triggers (of 5 allowed) + D1 database + Telegram webhook:

```
FETCH (*/20 * * * *)          PROCESS (1-59/20 * * * *)       DELIVER (0 */3 * * *)
Fetch ONE RSS source          Pick ONE raw article             Send all done articles
per run, rotate               → Gemini summarize+translate     to all subscribers
through pool                  → Save Persian summary           via Telegram API
Save raw articles to D1       to D1                            Mark as delivered
```

Each invocation does minimal CPU work (<5ms). All heavy lifting (fetch, Gemini, Telegram API, D1) is I/O and doesn't count toward the 10ms CPU limit.

## Project Structure

```
negent/
├── wrangler.toml              # Worker config, crons, D1 binding
├── package.json
├── tsconfig.json
├── schema.sql                 # D1 schema
└── src/
    ├── index.ts               # Entry: cron dispatcher + webhook handler
    ├── types.ts               # TypeScript interfaces
    ├── db.ts                  # D1 query helpers
    ├── cron/
    │   ├── fetch.ts           # Fetch one RSS source, save articles
    │   ├── process.ts         # Gemini summarize+translate one article
    │   └── deliver.ts         # Send to Telegram subscribers
    ├── services/
    │   ├── rss.ts             # Lightweight RSS/Atom parser (no deps)
    │   ├── gemini.ts          # Gemini API client
    │   ├── telegram.ts        # Telegram Bot API client
    │   └── media.ts           # Media URL extraction from RSS
    ├── bot/
    │   └── commands.ts        # /start, /stop, /sources, /add, /remove
    └── utils/
        └── constants.ts       # Config values
```

Zero external runtime dependencies. RSS parsed with indexOf/regex, not a DOM library.

## D1 Schema

4 tables:
- **sources** — RSS feed pool (url, name, active, fetch_order for rotation). User-modifiable via bot commands.
- **articles** — Raw + processed articles (url_hash for dedup, status: raw→processing→done→failed, summary_fa, media_url/media_type, retry_count max 3)
- **subscribers** — Telegram users (chat_id, is_active, is_admin). First /start user becomes admin.
- **delivery_log** — Per-subscriber send tracking for error handling.

Dedup: `UNIQUE INDEX` on `url_hash` (SHA-256 of normalized URL). `INSERT OR IGNORE` handles collisions with zero extra queries.

## Cron Details

### Fetch (every 20 min)
1. Pick source with lowest `fetch_order`
2. `fetch()` RSS URL
3. Parse items with lightweight string-based XML extractor
4. Normalize URLs (strip utm_* params), compute SHA-256 hash
5. `INSERT OR IGNORE` into articles (dedup by url_hash)
6. Extract media from `<enclosure>`, `<media:content>`, `<media:thumbnail>`, or first `<img>`
7. Advance source's `fetch_order` to end of rotation

### Process (every 20 min, offset 1 min)
1. Unstick articles stuck in 'processing' >10 min
2. Pick oldest raw/failed (retry<3) article
3. Optimistic lock: `UPDATE SET status='processing' WHERE status IN ('raw','failed')`
4. Call Gemini 2.0 Flash with single prompt: summarize + translate to informal Persian + JSON output
5. Save `summary_fa`, set `status='done'`
6. On error: set `status='failed'`, increment `retry_count`

### Deliver (every 3 hours)
1. Select up to 10 done+undelivered articles
2. Select all active subscribers
3. For each article x subscriber:
   - Has photo? → `sendPhoto` with caption
   - Has video? → `sendVideo` with caption
   - Otherwise → `sendMessage` with HTML
4. Handle: 429 → stop batch (next cron picks up), 403 → deactivate subscriber
5. Mark articles as delivered

## Gemini Integration

Model: `gemini-2.0-flash` with `responseMimeType: "application/json"`, temperature 0.3.

Single prompt: summarize in 2-3 paragraphs, informal Persian (use "تو" not "شما"), keep tech terms in English, return `{"summary": "..."}`.

Usage: ~72 req/day out of 1500 free = 4.8%.

## Telegram Bot Commands

| Command | Action |
|---------|--------|
| `/start` | Subscribe (first user = admin) |
| `/stop` | Unsubscribe |
| `/sources` | List all sources with status |
| `/add <url> [name]` | Add RSS source (admin only) |
| `/remove <id>` | Remove source (admin only) |

Webhook registered at `https://negent.<subdomain>.workers.dev/webhook/<BOT_TOKEN>`.

## Default Sources

1. TechCrunch — `https://techcrunch.com/feed/`
2. The Verge — `https://www.theverge.com/rss/index.xml`
3. Ars Technica — `https://feeds.arstechnica.com/arstechnica/index`
4. Hacker News — `https://hnrss.org/frontpage`
5. OpenAI Blog — `https://openai.com/blog/rss.xml`
6. Dev.to — `https://dev.to/feed`

## Free Tier Budget (daily worst case)

| Resource | Used | Limit | % |
|----------|------|-------|---|
| D1 reads | ~1,800 | 5,000,000 | 0.04% |
| D1 writes | ~2,600 | 100,000 | 2.6% |
| Gemini calls | 72 | 1,500 | 4.8% |
| Worker invocations | ~200 | 100,000 | 0.2% |

## Telegram Message Format

```
<b>عنوان خبر به فارسی</b>

پاراگراف اول خلاصه فارسی با لحن غیررسمی...

پاراگراف دوم...

پاراگراف سوم (اختیاری)...

🔗 <a href="URL">منبع</a> | 📡 TechCrunch
```

If article has media → sent via `sendPhoto`/`sendVideo` with the above as caption.
If caption exceeds 1024 chars → fallback to `sendMessage` + media URL as link.

## Error Handling

- RSS fetch fails → skip, advance rotation, retry next cycle
- Gemini error/rate limit → mark article `failed`, retry up to 3 times
- Article stuck in `processing` >10 min → reset to `failed`
- Telegram 429 → stop batch, next cron picks up remaining
- Telegram 403 (blocked) → deactivate subscriber
- `sendPhoto` fails → fallback to `sendMessage`

## Implementation Order

1. Scaffold project (wrangler, package.json, tsconfig, types)
2. D1 schema + seed default sources
3. RSS parser + media extractor
4. Gemini service
5. Telegram service
6. Fetch cron
7. Process cron
8. Deliver cron
9. Webhook handler + bot commands
10. Wire everything in index.ts

## Verification

1. `wrangler dev` → test cron triggers locally via `curl localhost:8787/__scheduled?cron=...`
2. Verify RSS parsing against all 6 default feeds
3. Verify Gemini returns valid Persian JSON
4. Send test message to own Telegram via `/start`
5. `wrangler deploy` → verify crons fire via `wrangler tail`
6. Register webhook → test `/start`, `/sources`, `/add`, `/remove`
