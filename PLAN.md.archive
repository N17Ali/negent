# Negent — Design Notes

> This started as an implementation plan and now documents the **shipped design**. Where it disagrees with the code, the code (`src/`, `wrangler.toml`, `schema.sql`, `src/utils/constants.ts`) wins. `AGENTS.md` / `CLAUDE.md` cover day-to-day workflow; this file keeps the "why" — free-tier budget, message format, error-handling rationale.

## Context

A Telegram bot on **Cloudflare Workers free tier** that aggregates tech/AI/programming/gaming news from international RSS feeds, uses **DeepSeek** to pick the most important stories, then **summarizes and translates them to Persian** (informal tone) with Google **Gemini**, and delivers each as a separate Telegram message during Tehran daytime hours. No VPS, no paid services.

## Architecture

2 Cron Triggers + D1 database + Telegram webhook:

```
FETCH  (*/10 * * * *)              SELECT  (30 5,8,11,14 * * *  UTC)
Fetch ONE RSS source per run,      = 09:00 / 12:00 / 15:00 / 18:00 Tehran (UTC+3:30)
rotate through the pool.           1. DeepSeek picks top 10 of up to 200 raw titles
Keyword-filter, dedup by           2. Gemini summarizes+translates each pick to Persian
url_hash, save as status='raw'.    3. Deliver to all active subscribers, mark delivered
```

Selection, summarization, and delivery all happen inside the **one** `select` cron (`src/cron/select.ts`) — there is no separate `process`/`deliver` cron. Each invocation does minimal CPU work; all heavy lifting (fetch, DeepSeek, Gemini, Telegram, D1) is I/O and doesn't count toward the CPU limit.

**Timezone gotcha:** the crons run in UTC but delivery is gated to 9am–9pm `Asia/Tehran`. Tehran is UTC+**3:30**, so a cron on whole UTC hours lands at `:30` past the Tehran hour. `30 5,8,11,14` maps to clean **09:00/12:00/15:00/18:00 Tehran**. The old `0 */3 * * *` landed at `:30` and its 21:30 run fired only to hit the delivery-hours skip — don't reintroduce that.

**Dispatch coupling:** `src/index.ts` matches the literal cron strings from `wrangler.toml` by exact string. Change one, change both, or the handler silently stops firing.

## Project Structure

```
negent/
├── wrangler.toml              # Worker config, crons, D1 binding
├── schema.sql                 # D1 schema
├── seed.sql                   # Default RSS sources
├── migration_001_category_score.sql
└── src/
    ├── index.ts               # Entry: cron dispatcher + webhook handler
    ├── types.ts               # Env + row interfaces (source of truth for bindings)
    ├── db.ts                  # D1 query helpers
    ├── cron/
    │   ├── fetch.ts           # Fetch one RSS source, filter, dedup, save raw
    │   └── select.ts          # DeepSeek select → Gemini summarize → deliver
    ├── services/
    │   ├── rss.ts             # Lightweight RSS/Atom parser (no deps)
    │   ├── media.ts           # Media URL extraction from RSS
    │   ├── deepseek.ts        # DeepSeek selection client (NVIDIA API)
    │   ├── gemini.ts          # Gemini summarize/translate client (+ Gemma fallback)
    │   └── telegram.ts        # Telegram Bot API client
    ├── bot/
    │   └── commands.ts        # /start, /stop, /sources, /status
    └── utils/
        ├── constants.ts       # Config values, keyword lists, model names
        ├── filter.ts          # Keyword relevance filter (fetch stage)
        └── dedup.ts           # Dedup helpers
```

Zero external runtime dependencies. RSS is parsed with string/regex, not a DOM library — keep it that way.

## D1 Schema

4 tables:
- **sources** — RSS feed pool (`url`, `name`, `active`, `fetch_order` for rotation). Seeded from `seed.sql`; no bot commands mutate it.
- **articles** — raw + processed articles. `url_hash` (SHA-256 of normalized URL) for dedup; `status` in `raw → selected → done`/`failed`, plus `skipped`, `processing`; `summary_fa`, `category`, `relevance_score`, `media_url`/`media_type`, `retry_count`, `delivered`.
- **subscribers** — Telegram users (`chat_id`, `is_active`, `is_admin`). First `/start` user becomes admin (enforced in `upsertSubscriber` SQL).
- **delivery_log** — per-subscriber send tracking; also backs the per-hour rate-limit count.

Dedup: `UNIQUE INDEX` on `url_hash`. `INSERT OR IGNORE` handles collisions with no extra queries.

## Cron Details

### Fetch (`*/10 * * * *`)
1. `cleanupOldArticles` deletes articles older than 24h (any terminal/raw status).
2. Pick the source with lowest `fetch_order`.
3. `fetch()` the RSS URL (custom User-Agent); on non-OK/error, advance rotation and bail.
4. Parse items (auto-detect Atom vs RSS), extract media from `<enclosure>`/`<media:content>`/`<media:thumbnail>`/first `<img>`.
5. Keyword-filter with `utils/filter.ts` (AI / programming / gaming term lists in `constants.ts`); skip irrelevant.
6. Compute `url_hash`, `INSERT OR IGNORE` (dedup).
7. Advance the source's `fetch_order` to the end of the rotation.

### Select (`30 5,8,11,14 * * *`)
1. Bail early if outside Tehran delivery hours (`DELIVERY_START_HOUR`–`DELIVERY_END_HOUR`).
2. Load up to `BATCH_SELECT_SIZE` (200) raw articles + recently delivered titles (for de-duplication context).
3. **DeepSeek** picks `SELECT_TOP_N` (10); mark the rest `skipped`, mark picks `selected`.
4. For each pick: optimistic `lockArticle`, then **Gemini** summarize+translate → `done` with `summary_fa`, `category`, `relevance_score`; on error → `failed`.
5. `rotateCategories` orders the ready articles so no more than `MAX_SAME_CATEGORY_IN_ROW` (3) of one category ship consecutively.
6. Deliver to each active subscriber up to their remaining hourly quota (`MAX_MESSAGES_PER_HOUR`, 10). Telegram `BLOCKED` → deactivate subscriber; `RATE_LIMITED` → stop.

## Model Integrations

### DeepSeek selection (`services/deepseek.ts`)
- Model `deepseek-ai/deepseek-v4-pro` via `https://integrate.api.nvidia.com/v1/chat/completions`, `temperature: 1`, key `NVIDIA_API_KEY`.
- Returns `{"selected": [{"id", "reason"}, ...]}`. Response may be wrapped in ```` ```json ```` fences — stripped before parse.
- Retries with backoff on 429/503/524 (524 = NVIDIA upstream timeout).

### Gemini summarize/translate (`services/gemini.ts`)
- Primary `GEMINI_MODEL` = `gemini-3.1-flash-lite`; on rate-limit, falls back to `GEMMA_MODEL` = `gemma-4-31b-it`. Key `GEMINI_API_KEY`.
- Single prompt: summarize in informal Persian (use "تو" not "شما", keep tech terms in English), return JSON with `summary` / `category` / `relevance_score`.

## Telegram Bot Commands

| Command | Action |
|---------|--------|
| `/start` | Subscribe (first user = admin); new users also get one recent article as a sample |
| `/stop` | Unsubscribe |
| `/sources` | List all sources with active/paused status |
| `/status` | Pipeline stats (admin only) |

There is **no** `/add` or `/remove` — sources are managed via `seed.sql`. Webhook route: `/webhook/<BOT_TOKEN>` (token in path), registered via Telegram `setWebhook`.

## Default Sources (`seed.sql`)

TechCrunch · The Verge · Ars Technica · Hacker News · OpenAI Blog · Dev.to · IGN · Eurogamer · Rock Paper Shotgun (9 total).

## Telegram Message Format

```
<b>عنوان خبر به فارسی</b>

پاراگراف اول خلاصه فارسی با لحن غیررسمی...

پاراگراف دوم...

🔗 <a href="URL">منبع</a> | 📡 TechCrunch
```

If the article has media it's sent via `sendPhoto`/`sendVideo` with the above as caption. Captions are bounded by `MAX_CAPTION_LENGTH`; longer text falls back to `sendMessage`.

## Error Handling

- RSS fetch fails → skip, advance rotation, retry next cycle.
- DeepSeek fails → log and skip the select run (no articles marked).
- Gemini error → mark that article `failed`; Gemini rate-limit → fall back to Gemma.
- Article stuck in `processing` >10 min → reset to `failed` (`unstickProcessing`), `retry_count++`.
- Telegram `RATE_LIMITED` → stop the batch; next cron picks up. `BLOCKED` → deactivate subscriber.
- `sendPhoto`/`sendVideo` failure → fall back to `sendMessage`.

## Free-Tier Budget (rough daily worst case)

| Resource | Notes |
|----------|-------|
| Worker invocations | ~150/day (144 fetch + 4 select) — well under 100k |
| D1 reads/writes | thousands/day — far under 5M read / 100k write |
| Gemini calls | ~40/day (≤10 picks × 4 select runs) out of 1500 free |
| DeepSeek calls | 4/day (one per select run) |

## Local Verification

1. `wrangler dev` → invoke crons via `curl 'localhost:8787/__scheduled?cron=*/10+*+*+*+*'`.
2. `npm test` for pure-logic unit tests (RSS, media, Gemini/DeepSeek JSON, Telegram formatting).
3. `/start` from your own Telegram against a deployed instance; watch `wrangler tail`.
