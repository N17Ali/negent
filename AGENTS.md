# AGENTS.md

Cloudflare Worker (TypeScript) running a Telegram bot that aggregates RSS tech news, uses Gemini to pick the best stories, then summarizes/translates them to Persian via Gemini, driven by 2 cron triggers. D1 (SQLite) is the only store. Zero runtime dependencies. `PLAN.md` has extra design context (free-tier budget, message format, error-handling rationale) — but trust the code where they disagree.

## Commands

- `npm run dev` — `wrangler dev` (local Worker at http://localhost:8787)
- `npm run deploy` — `wrangler deploy`
- `npm run tail` — live logs from deployed Worker
- `npm run db:local` / `db:remote` — apply `schema.sql` to D1
- `npm run seed:local` / `seed:remote` — apply `seed.sql` (6 default RSS sources)

No test, lint, or typecheck scripts. Typecheck manually: `npx tsc --noEmit` (`tsconfig.json` has `noEmit`, `strict`).

Tests: `npm test` (Vitest, run once) or `npm run test:watch`. Tests live next to the source as `*.test.ts` and cover pure logic only (RSS parser, media extractor, Gemini JSON handling, Telegram formatting/escaping via fetch-mock payload inspection). No D1 or live network calls in tests — `fetch` is stubbed via `vi.stubGlobal`.

## Local cron testing

`wrangler dev` exposes `http://localhost:8787/__scheduled?cron=<expr>` to invoke the `scheduled` handler. URL-encode the expression (spaces as `+`):
```
curl 'http://localhost:8787/__scheduled?cron=*/20+*+*+*+*'
```

## Setup gotchas

- `wrangler.toml` has a real `database_id` committed. For a fresh D1 instance, run `wrangler d1 create negent-db` and replace it with the returned ID.
- Secrets are **not** in the repo. Set remotely via `wrangler secret put BOT_TOKEN` and `wrangler secret put GEMINI_API_KEY`. For local dev, create a `.dev.vars` with `BOT_TOKEN=...` / `GEMINI_API_KEY=...`.
- Webhook route is `/webhook/${env.BOT_TOKEN}` (token in path) — register via Telegram `setWebhook` (helper in `src/services/telegram.ts`).

## Architecture

Entry `src/index.ts` exports `default { fetch, scheduled }`:
- `fetch` — handles POST `/webhook/<BOT_TOKEN>` (Telegram updates) and `/health`.
- `scheduled` — dispatches to one of 2 cron handlers by **exact string match** of `event.cron`.

### Cron dispatch coupling (silent failure risk)

The `switch` in `src/index.ts` matches these literal cron strings from `wrangler.toml`:
- `*/10 * * * *` → `cron/fetch.ts` (fetch one RSS source, save raw articles, rotate via `fetch_order`)
- `30 5,8,11,14,16 * * *` → `cron/select.ts` (Gemini selects top 10 → Gemini summarizes → deliver to subscribers)

If you change a cron expression in `wrangler.toml`, update the matching `case` in `index.ts` or that handler silently stops firing.

### Timezone: crons are UTC but delivery is gated to Tehran (UTC+3:30)

`select.ts` skips when the current hour is outside `DELIVERY_START_HOUR`–`DELIVERY_END_HOUR` (9–21) in `Asia/Tehran`. Because Tehran is UTC+**3:30**, a cron on whole UTC hours lands at `:30` past the Tehran hour. `30 5,8,11,14,16` (UTC) is chosen so the runs map to exactly **09:00 / 12:00 / 15:00 / 18:00 / 20:00 Tehran** — on the hour and inside the window. When editing the select schedule, keep the UTC→Tehran mapping on clean hours and never on/after 21:00, or the run fires only to hit the delivery-hours skip (as it did with the old `0 */3 * * *`).

### Data flow

`sources` → fetch cron pulls one source/run (keyword-filtered by `utils/filter.ts`, deduped by `url_hash`) → `articles` (status `raw`) → select cron sends up to `BATCH_SELECT_SIZE` (300, newest first) raw titles to Gemini → Gemini picks `SELECT_TOP_N` (10) → marks the rest `skipped` → Gemini summarizes the 10 → delivers to all active `subscribers`, marks `delivered=1`.

- Article states: `raw → selected → done` (or `failed`); non-selected articles marked `skipped`. Articles stuck in `processing` >10 min reset to `failed` by `unstickProcessing` (`src/db.ts`).
- First subscriber to `/start` becomes admin (`is_admin=1`), enforced in the `upsertSubscriber` SQL — not in app code.
- First-time `/start` sends a greeting + one recent article as a sample.
- Delivery respects Tehran delivery hours (see above) and a rolling rate limit of `MAX_MESSAGES_PER_HOUR` (10) successful sends per subscriber per hour (`getSubscriberMessageCount` counts `delivery_log` rows from the last hour). `rotateCategories` interleaves categories so no more than `MAX_SAME_CATEGORY_IN_ROW` (3) of one category ship in a row.
- Sources are managed via `seed.sql` only — no bot commands for add/remove.

### External model services

- **Gemini selection** (`services/selector.ts`): sends up to `BATCH_SELECT_SIZE` raw titles to primary `GEMINI_MODEL` (`gemini-3.1-flash-lite`) via `generativelanguage.googleapis.com`, `temperature: 1`, `responseMimeType: application/json`. On rate-limit (429) it falls back to `GEMMA_MODEL` (`gemma-4-31b-it`). Strips ```` ```json ```` fences before parsing; retries with backoff on 429/503. Uses `GEMINI_API_KEY`.
- **Gemini summarize/translate** (`services/gemini.ts`): same primary/fallback pair (`GEMINI_MODEL` → `GEMMA_MODEL`). Uses `GEMINI_API_KEY`.

Both stages share the one `GEMINI_API_KEY` and its free-tier quota.

### Bot commands (`src/bot/commands.ts`)

`/start` (subscribe; first user becomes admin), `/stop` (unsubscribe), `/sources` (list feeds), `/status` (admin-only pipeline stats). No `/add` or `/remove` — sources come from `seed.sql`.

## Conventions

- D1 = SQLite: use `datetime('now')`, `INSERT OR IGNORE`, `ON CONFLICT`. Booleans stored as `INTEGER` 0/1.
- RSS parsing (`src/services/rss.ts`) is dependency-free string/regex and auto-detects Atom vs RSS. Do **not** add a DOM/XML library — PLAN.md mandates zero external runtime dependencies.
- `src/types.ts` `Env` interface is the source of truth for bindings/secrets: `DB`, `BOT_TOKEN`, `GEMINI_API_KEY`.
- All user-facing Telegram text is Persian, informal tone (use "تو" not "شما", keep tech terms in English). Prompt templates live in `src/services/gemini.ts` (summarize/translate) and `src/services/selector.ts` (selection).
- Tuning knobs (batch sizes, thresholds, delivery hours, keyword lists, model names) are centralized in `src/utils/constants.ts`.
