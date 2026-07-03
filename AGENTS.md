# AGENTS.md

Cloudflare Worker (TypeScript) running a Telegram bot that aggregates RSS tech news, summarizes/translates to Persian via Gemini, driven by 3 cron triggers. D1 (SQLite) is the only store. Zero runtime dependencies. Read `PLAN.md` for full design context (architecture, free-tier budget, message format, error handling).

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

- `wrangler.toml` ships with `database_id = "placeholder-replace-after-d1-create"`. Before first deploy: run `wrangler d1 create negent-db` and replace the placeholder with the returned ID.
- Secrets are **not** in the repo. Set remotely via `wrangler secret put BOT_TOKEN` and `wrangler secret put GEMINI_API_KEY`. For local dev, create a `.dev.vars` with `BOT_TOKEN=...` / `GEMINI_API_KEY=...`.
- Webhook route is `/webhook/${env.BOT_TOKEN}` (token in path) — register via Telegram `setWebhook` (helper in `src/services/telegram.ts`).

## Architecture

Entry `src/index.ts` exports `default { fetch, scheduled }`:
- `fetch` — handles POST `/webhook/<BOT_TOKEN>` (Telegram updates) and `/health`.
- `scheduled` — dispatches to one of 3 cron handlers by **exact string match** of `event.cron`.

### Cron dispatch coupling (silent failure risk)

The `switch` in `src/index.ts` matches these literal cron strings from `wrangler.toml`:
- `*/10 * * * *` → `cron/fetch.ts` (fetch one RSS source, save raw articles, rotate via `fetch_order`)
- `1-59/10 * * * *` → `cron/process.ts` (Gemini summarize+translate one article)
- `0,15,30,45 * * * *` → `cron/deliver.ts` (send done articles to subscribers, mark delivered)

If you change a cron expression in `wrangler.toml`, update the matching `case` in `index.ts` or that handler silently stops firing.

### Data flow

`sources` → fetch cron pulls one source/run → `articles` (status `raw`) → process cron locks one article → Gemini → status `done`, `summary_fa` saved → deliver cron sends to all active `subscribers` every 15 min (9am-9pm Tehran time only, max 3 msgs/hour/subscriber), marks `delivered=1`.

- Article states: `raw → processing → done` (or `failed`); retries capped at 3 (`retry_count < 3`). Articles stuck in `processing` >10 min reset to `failed` by `unstickProcessing` (`src/db.ts`).
- First subscriber to `/start` becomes admin (`is_admin=1`), enforced in the `upsertSubscriber` SQL — not in app code.
- First-time `/start` sends a greeting + one recent article as a sample.
- Delivery respects quiet hours (9pm-9am Tehran) and rate limits (3 msgs/hour/subscriber).
- Sources are managed via `seed.sql` only — no bot commands for add/remove.

## Conventions

- D1 = SQLite: use `datetime('now')`, `INSERT OR IGNORE`, `ON CONFLICT`. Booleans stored as `INTEGER` 0/1.
- RSS parsing (`src/services/rss.ts`) is dependency-free string/regex and auto-detects Atom vs RSS. Do **not** add a DOM/XML library — PLAN.md mandates zero external runtime dependencies.
- `src/types.ts` `Env` interface is the source of truth for bindings/secrets: `DB`, `BOT_TOKEN`, `GEMINI_API_KEY`.
- All user-facing Telegram text is Persian, informal tone (use "تو" not "شما", keep tech terms in English). Prompt template lives in `src/services/gemini.ts`.
