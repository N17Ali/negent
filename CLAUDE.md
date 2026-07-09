# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Cloudflare Worker (TypeScript) running a Telegram bot that aggregates RSS tech news, uses Gemini to pick the best stories, summarizes/translates them to Persian via Gemini, and delivers them on cron triggers. D1 (SQLite) is the only store; zero runtime dependencies.

**`AGENTS.md` is the primary source of deeper guidance** (setup gotchas, conventions, local cron testing). Read it. This file captures the big picture and points out where the docs have drifted from the code.

## Doc drift — trust the code, not PLAN.md

`PLAN.md` describes an older 3-cron design (`fetch` / `process` / `deliver`) that no longer exists. The code has **3 crons**: `fetch`, `deliver`, and `select`. `select` does selection → summarization (producing `done` articles); `deliver` ships one ready article per tick (text + voice); `fetch` pulls RSS. `PLAN.md` also predates the move to a Gemini-based selection stage (it still describes DeepSeek/NVIDIA). AGENTS.md is kept in sync with the code. When docs and code disagree, the code (`src/index.ts`, `wrangler.toml`, `src/types.ts`) wins.

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
- `5-59/10 * * * *` → `cron/deliver.ts` (interleaved at :05,:15,… between the fetch ticks so the two never share an invocation)
- `30 5,6,7,8,9,10,11,12,13,14,15,16 * * *` → `cron/select.ts`

### Timezone: the crons are UTC but delivery is gated to Tehran (UTC+3:30)

Both `select.ts` and `deliver.ts` refuse to run outside `DELIVERY_START_HOUR`–`DELIVERY_END_HOUR` (9–21) in `Asia/Tehran` via the shared `isWithinDeliveryHours` (`utils/time.ts`). Because Tehran is UTC+**3:30**, a cron on whole UTC hours lands at `:30` past the Tehran hour. The select cron runs hourly at UTC minute `:30` on hours `5..16`, mapping to **09:00–20:00 Tehran** (one run per hour inside the window; 17:30 UTC / 21:00 Tehran is excluded since delivery ends at 21:00). The deliver cron fires every 10 min but its runtime hours-gate keeps it silent outside the window, so ticks at night are no-ops. When editing the select schedule, verify the UTC→Tehran mapping stays on clean hours and never falls on/after 21:00, or the run fires only to be skipped by the delivery-hours guard.

### Data flow

`sources` → `fetch` cron pulls **one** source per run (rotated via `fetch_order`), filters with `utils/filter.ts` keyword lists, dedups by `url_hash`, inserts as `status='raw'` → `select` cron sends up to `BATCH_SELECT_SIZE` (150, newest first) raw titles to Gemini, which returns `SELECT_TOP_N` (3) picks plus a **bucket** of important runner-ups; the picks go to `selected`, the bucket stays `raw` (reconsidered next run), and everything else is marked `skipped` → Gemini summarizes/translates the picks into `done` articles (`delivered=0`) → the separate `deliver` cron ships **one** `done` article per tick: it generates the Persian **voice reading** first, then sends the text and the voice together (audio replies to / quotes the text message).

- Article states: `raw → selected → done` (or `failed`); non-picks → `skipped`, except selector "bucket" runner-ups which are left `raw` to be reconsidered next run. `lockArticle` gates concurrent processing.
- **Delivery is decoupled onto its own cron** (`cron/deliver.ts`) so each article's slow, CPU-heavy voice synthesis runs in its own Worker invocation — this is what fixed the `exceededCpu` kills that dropped voices when select summarized + delivered + voiced 3 articles in one pass. One article per tick, newest `done` first (`getUndeliveredArticles`).
- Rate limits: `MAX_MESSAGES_PER_HOUR` (3) per subscriber, enforced per tick via the rolling `delivery_log` count, so the 10-min deliver cadence still can't exceed 3/hour. Blocked users are auto-deactivated (`deactivateSubscriber`) on Telegram `BLOCKED`. An article is marked `delivered=1` once it reaches at least one subscriber.
- **Cross-source dedup is the LLM's job** (selector prompt), not a code module — the old `utils/dedup.ts` was removed. Cross-*run* dedup relies on feeding recent delivered titles into the selector prompt (`getRecentDeliveredTitles`, window 50) plus a low selector temperature (0.2).
- **Voice audio** (`services/tts.ts`): `AUDIO_MODEL` (`gemini-2.5-flash-native-audio-latest`) is a Live API model reachable only over a **WebSocket** (`fetch(url,{headers:{Upgrade:'websocket'}})` → `response.webSocket.accept()`), not `generateContent`. It returns raw 16-bit mono PCM at `AUDIO_SAMPLE_RATE` (24kHz), which `utils/audio.ts` wraps in a WAV container (no deps) for Telegram `sendAudio`. Long text is split into short `AUDIO_CHUNK_CHARS` (700) chunks because the Live API voice drifts **robotic within a long single generation** — each chunk is a fresh turn and the PCM is concatenated. The system instruction carries pronunciation guidance (abbreviations spelled out in Persian, English tech terms kept English). Gated by `SEND_AUDIO`; failures never block text delivery.
- **Cleanup FK ordering:** `cleanupOldArticles` deletes dependent `delivery_log` rows **before** `articles` (the FK has no `ON DELETE CASCADE`); doing it in the wrong order throws `FOREIGN KEY constraint failed` and — since cleanup runs first in `fetchCron` — silently blocks all inserts. `fetchCron` also wraps cleanup in try/catch as a backstop. Cleanup now includes `processing` rows, reclaiming any orphaned by a killed worker.
- First subscriber to `/start` becomes admin (`is_admin=1`) — enforced in `upsertSubscriber` SQL, not app code.
- Sources are managed via `seed.sql` only; no bot commands add/remove them.

### Bindings

`src/types.ts` `Env` is the source of truth for secrets/bindings: `DB`, `BOT_TOKEN`, `GEMINI_API_KEY`. Secrets are not in the repo (`wrangler secret put ...`; `.dev.vars` for local).

## Conventions

- **Zero runtime deps is a hard rule.** RSS parsing (`services/rss.ts`) is dependency-free regex that auto-detects Atom vs RSS — do not add a DOM/XML library.
- D1 = SQLite: `datetime('now')`, `INSERT OR IGNORE`, `ON CONFLICT`; booleans are `INTEGER` 0/1.
- All user-facing Telegram text is **Persian, informal** ("تو" not "شما"), tech terms kept in English. Prompt templates live in `services/gemini.ts` and `services/selector.ts`.
- Tuning knobs (batch sizes, thresholds, hours, keyword lists) are centralized in `src/utils/constants.ts`.
