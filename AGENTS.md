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

Selection and delivery are separate endpoints. `/run-select` runs selection → summarization (produces `done` articles); `/run-deliver` ships **one** ready article (text + voice). Both are token-gated and **fire-and-forget** — they kick the work off via `ctx.waitUntil` and return immediately (`... started — watch logs`), so a browser/curl disconnect can't cancel a slow in-flight run (voice synthesis alone can take ~a minute). Watch `npm run tail` for the outcome. `?force=1` bypasses the delivery-hours gate (and, for deliver, the per-subscriber rate limit) so the bot can be exercised at night:
```
curl 'http://localhost:8787/run-select/<BOT_TOKEN>?force=1'
curl 'http://localhost:8787/run-deliver/<BOT_TOKEN>?force=1'   # hit repeatedly to drain the backlog
```
Without `force`, both honor delivery hours (and deliver honors the rate limit), exactly like the crons.

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
- `5-59/10 * * * *` → `cron/deliver.ts` (ship ONE ready `done` article: text first, then its voice as a reply). Interleaved at :05,:15,… between the fetch ticks so audio synthesis never shares a run with fetch.
- `30 5,6,7,8,9,10,11,12,13,14,15,16 * * *` → `cron/select.ts` (Gemini selects top 3 → Gemini summarizes into `done` articles)

If you change a cron expression in `wrangler.toml`, update the matching `case` in `index.ts` or that handler silently stops firing.

### Timezone: crons are UTC but delivery is gated to Tehran (UTC+3:30)

Both `select.ts` and `deliver.ts` skip when the current hour is outside `DELIVERY_START_HOUR`–`DELIVERY_END_HOUR` (9–21) in `Asia/Tehran` (shared `isWithinDeliveryHours` in `utils/time.ts`). Because Tehran is UTC+**3:30**, a cron on whole UTC hours lands at `:30` past the Tehran hour. The select cron runs hourly at UTC minute `:30` on hours `5..16`, mapping to **09:00–20:00 Tehran** (one run per hour in the window; 17:30 UTC / 21:00 Tehran excluded). The deliver cron fires every 10 min but its runtime gate makes night ticks no-ops. When editing the select schedule, keep the UTC→Tehran mapping on clean hours and never on/after 21:00, or the run fires only to hit the delivery-hours skip.

### Data flow

`sources` → fetch cron pulls one source/run (keyword-filtered by `utils/filter.ts`, deduped by `url_hash`) → `articles` (status `raw`) → select cron sends up to `BATCH_SELECT_SIZE` (newest first) raw titles to Gemini → Gemini picks `SELECT_TOP_N` (3) → marks the rest `skipped` → Gemini summarizes the 3 into `done` articles (`delivered=0`) → the separate **deliver cron** ships one `done` article per tick: sends the text (marking `delivered=1` once it reaches ≥1 subscriber), then generates the voice and sends it as a reply that quotes the text.

- Article states: `raw → selected → done` (or `failed`); non-selected articles marked `skipped`. `cleanupOldArticles` deletes rows (including stuck `processing`) older than 24h; it removes dependent `delivery_log` rows **first** because the FK has no `ON DELETE CASCADE`. `fetchCron` also runs cleanup inside try/catch so a cleanup error can't block inserts.
- Cross-source dedup is handled by the **selector LLM prompt** (pick one article per story), not a code module — `utils/dedup.ts` was removed.
- First subscriber to `/start` becomes admin (`is_admin=1`), enforced in the `upsertSubscriber` SQL — not in app code.
- `/start` sends only a greeting (no sample article).
- Delivery respects Tehran delivery hours (see above) and a rolling rate limit of `MAX_MESSAGES_PER_HOUR` (3) successful sends per subscriber per hour (`getSubscriberMessageCount` counts `delivery_log` rows from the last hour, checked every deliver tick so the 10-min cadence still can't exceed 3/hour). The deliver cron sends one article per tick — no in-run category rotation.
- Sources are managed via `seed.sql` only — no bot commands for add/remove.

### External model services

- **Gemini selection** (`services/selector.ts`): sends up to `BATCH_SELECT_SIZE` raw titles to primary `GEMINI_MODEL` via `generativelanguage.googleapis.com`, `temperature: 1`, `responseMimeType: application/json`. On rate-limit (429) it falls back to `GEMMA_MODEL`. Strips ```` ```json ```` fences before parsing; retries with backoff on 429/503.
- **Gemini summarize/translate** (`services/gemini.ts`): same primary/fallback pair. Prompt targets 2–4 finished paragraphs under ~900 chars so summaries fit one Telegram message; `maxOutputTokens` 4096 to avoid mid-output truncation.
- **Voice audio** (`services/tts.ts`): `AUDIO_MODEL` (`gemini-2.5-flash-native-audio-latest`) is a **Live API** model — WebSocket-only (`fetch` with `Upgrade: websocket` → `response.webSocket.accept()`), not `generateContent`. Sends a `setup` (audio modality + `AUDIO_VOICE` + a Persian system instruction with pronunciation guidance — abbreviations spelled out, English tech terms kept English) then a text turn; collects base64 PCM (16-bit mono, `AUDIO_SAMPLE_RATE` 24kHz) from `serverContent.modelTurn.parts[].inlineData` until `turnComplete`. Text is split into short `AUDIO_CHUNK_CHARS` (700) chunks — the voice **drifts robotic within a long single generation**, so each chunk is a fresh turn and the PCM is concatenated. `utils/audio.ts` wraps the PCM in a WAV container (no deps) for Telegram `sendAudio`. Gated by `SEND_AUDIO`; any failure is swallowed so text still ships. Per-chunk `CONNECT_TIMEOUT_MS`/`GENERATION_TIMEOUT_MS` bound a single stalled turn.
- **One article, text-first, per deliver tick.** `deliverCron` (`cron/deliver.ts`) sends the text to every eligible subscriber and marks the article `delivered=1` **before** the voice pass, then generates the WAV once and sends it as a reply to each subscriber's text message (`sendAudio(..., replyToMessageId)`) so the audio quotes the article. Ordering is deliberate: a voice pass can take ~a minute and the Live API sometimes stalls a turn, and a single Worker invocation cannot hold that long — awaited inline it gets `canceled` on client disconnect, deferred past response end it gets `waitUntil() ... cancelled` by the time limit. Sending text first means the summary always ships and the article is never lost to a slow/stalled synthesis; the voice is pure best-effort. Because delivery is its own cron (one article per invocation), there's no per-run audio budget — the old `deliver()`/`deliverAudio()` two-pass-in-select design and `AUDIO_PASS_BUDGET_MS` are gone. Splitting audio off select is what removed the `exceededCpu` kills that silently dropped voices.

Both Gemini stages share the one `GEMINI_API_KEY` and its free-tier quota.

### Bot commands (`src/bot/commands.ts`)

`/start` (subscribe; first user becomes admin), `/stop` (unsubscribe), `/sources` (list feeds), `/status` (admin-only pipeline stats). No `/add` or `/remove` — sources come from `seed.sql`.

## Conventions

- D1 = SQLite: use `datetime('now')`, `INSERT OR IGNORE`, `ON CONFLICT`. Booleans stored as `INTEGER` 0/1.
- RSS parsing (`src/services/rss.ts`) is dependency-free string/regex and auto-detects Atom vs RSS. Do **not** add a DOM/XML library — PLAN.md mandates zero external runtime dependencies.
- `src/types.ts` `Env` interface is the source of truth for bindings/secrets: `DB`, `BOT_TOKEN`, `GEMINI_API_KEY`.
- All user-facing Telegram text is Persian, informal tone (use "تو" not "شما", keep tech terms in English). Prompt templates live in `src/services/gemini.ts` (summarize/translate) and `src/services/selector.ts` (selection).
- Tuning knobs (batch sizes, thresholds, delivery hours, keyword lists, model names) are centralized in `src/utils/constants.ts`.
