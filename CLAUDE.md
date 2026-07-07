# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Cloudflare Worker (TypeScript) running a Telegram bot that aggregates RSS tech news, uses Gemini to pick the best stories, summarizes/translates them to Persian via Gemini, and delivers them on cron triggers. D1 (SQLite) is the only store; zero runtime dependencies.

**`AGENTS.md` is the primary source of deeper guidance** (setup gotchas, conventions, local cron testing). Read it. This file captures the big picture and points out where the docs have drifted from the code.

## Doc drift — trust the code, not PLAN.md

`PLAN.md` describes an older 3-cron design (`fetch` / `process` / `deliver`) that no longer exists. The code has **2 crons**: `fetch` and `select`, where `select` does selection → summarization → delivery in a single pass. `PLAN.md` also predates the move to a Gemini-based selection stage (it still describes DeepSeek/NVIDIA). AGENTS.md is kept in sync with the code. When docs and code disagree, the code (`src/index.ts`, `wrangler.toml`, `src/types.ts`) wins.

## Commands

- `npm run dev` — `wrangler dev` (local Worker at http://localhost:8787)
- `npm test` — Vitest, run once; `npm run test:watch` for watch mode
- `npm run deploy` / `npm run tail` — deploy / live logs
- `npm run db:local` | `db:remote` — apply `schema.sql`; `migrate:*` applies `migration_001_category_score.sql`; `seed:*` applies `seed.sql`
- No lint script. Typecheck manually: `npx tsc --noEmit` (`tsconfig.json` is `strict` + `noEmit`)

Run a single test: `npx vitest run src/services/rss.test.ts` (or `-t "<name>"` to filter by test name).

Tests live next to source as `*.test.ts` and cover **pure logic only** (RSS parse, media extraction, Gemini summarize/select JSON handling, Telegram formatting/escaping). No D1 or live network in tests — `fetch` is stubbed with `vi.stubGlobal`.

## Local cron testing

`wrangler dev` exposes `/__scheduled?cron=<expr>` (URL-encode spaces as `+`):
```
curl 'http://localhost:8787/__scheduled?cron=*/10+*+*+*+*'
```

## Architecture

Entry `src/index.ts` exports `default { fetch, scheduled }`:
- `fetch` — POST `/webhook/<BOT_TOKEN>` (Telegram updates, token in path) and `/health`
- `scheduled` — dispatches to a cron handler by **exact string match** of `event.cron`

### Cron dispatch coupling (silent-failure risk)

The `switch` in `src/index.ts` matches literal cron strings from `wrangler.toml`. **If you change a cron expression in one file you must change the matching `case` in the other, or that handler silently stops firing.** Current pairing:
- `*/10 * * * *` → `cron/fetch.ts`
- `30 5,8,11,14,16 * * *` → `cron/select.ts`

### Timezone: the crons are UTC but delivery is gated to Tehran (UTC+3:30)

`select.ts` refuses to run outside `DELIVERY_START_HOUR`–`DELIVERY_END_HOUR` (9–21) in `Asia/Tehran` (`constants.ts`). Because Tehran is UTC+**3:30**, a cron on whole UTC hours lands at `:30` past the Tehran hour. The select cron uses `30 5,8,11,14,16` (UTC) precisely so the runs map to **09:00 / 12:00 / 15:00 / 18:00 / 20:00 Tehran** — on-the-hour and inside the window. When editing the select schedule, verify the UTC→Tehran mapping stays on clean hours and never falls on/after 21:00, or the run fires only to be skipped by the delivery-hours guard.

### Data flow

`sources` → `fetch` cron pulls **one** source per run (rotated via `fetch_order`), filters with `utils/filter.ts` keyword lists, dedups by `url_hash`, inserts as `status='raw'` → `select` cron sends up to `BATCH_SELECT_SIZE` (300, newest first) raw titles to Gemini, which returns `SELECT_TOP_N` (10) picks; the rest are marked `skipped` → Gemini summarizes/translates the picks → delivers to active `subscribers`.

- Article states: `raw → selected → done` (or `failed`); non-picks → `skipped`. `lockArticle` gates concurrent processing.
- Delivery ordering: `rotateCategories` in `select.ts` interleaves categories so no more than `MAX_SAME_CATEGORY_IN_ROW` of one category ship consecutively.
- Rate limits: `MAX_MESSAGES_PER_HOUR` per subscriber; blocked users are auto-deactivated (`deactivateSubscriber`) on Telegram `BLOCKED`.
- First subscriber to `/start` becomes admin (`is_admin=1`) — enforced in `upsertSubscriber` SQL, not app code.
- Sources are managed via `seed.sql` only; no bot commands add/remove them.

### Bindings

`src/types.ts` `Env` is the source of truth for secrets/bindings: `DB`, `BOT_TOKEN`, `GEMINI_API_KEY`. Secrets are not in the repo (`wrangler secret put ...`; `.dev.vars` for local).

## Conventions

- **Zero runtime deps is a hard rule.** RSS parsing (`services/rss.ts`) is dependency-free regex that auto-detects Atom vs RSS — do not add a DOM/XML library.
- D1 = SQLite: `datetime('now')`, `INSERT OR IGNORE`, `ON CONFLICT`; booleans are `INTEGER` 0/1.
- All user-facing Telegram text is **Persian, informal** ("تو" not "شما"), tech terms kept in English. Prompt templates live in `services/gemini.ts` and `services/selector.ts`.
- Tuning knobs (batch sizes, thresholds, hours, keyword lists) are centralized in `src/utils/constants.ts`.
