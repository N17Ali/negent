import { Env, Article } from '../types';
import { selectTopArticles } from '../services/selector';
import { summarizeAndTranslate } from '../services/gemini';
import { fetchArticleText } from '../services/extract';
import { sendArticle, sendAudio } from '../services/telegram';
import { generateAudio } from '../services/tts';
import {
  getRawArticlesBatch,
  getRecentDeliveredTitles,
  markArticlesSkipped,
  markArticlesSelected,
  getSelectedArticles,
  getUndeliveredArticles,
  lockArticle,
  markArticleDone,
  markArticleFailed,
  getActiveSubscribers,
  getSubscriberMessageCount,
  markDelivered,
  logDelivery,
  deactivateSubscriber,
} from '../db';
import {
  BATCH_SELECT_SIZE,
  SELECT_TOP_N,
  MAX_MESSAGES_PER_HOUR,
  MAX_SAME_CATEGORY_IN_ROW,
  DELIVERY_START_HOUR,
  DELIVERY_END_HOUR,
  TIMEZONE,
  SEND_AUDIO,
  AUDIO_PASS_BUDGET_MS,
} from '../utils/constants';

function isWithinDeliveryHours(): boolean {
  const hourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour: 'numeric',
    hour12: false,
  }).format(new Date());
  const hour = parseInt(hourStr, 10);
  return hour >= DELIVERY_START_HOUR && hour < DELIVERY_END_HOUR;
}

export async function selectCron(env: Env, force = false): Promise<void> {
  if (!force && !isWithinDeliveryHours()) {
    console.log('select: outside delivery hours (9am-9pm Tehran), skipping');
    return;
  }
  if (force) {
    console.log('select: force=true — bypassing delivery-hours gate and rate limit');
  }

  const { results: rawRows } = await getRawArticlesBatch(env.DB, BATCH_SELECT_SIZE);
  if (rawRows.length) {
    console.log(`select: ${rawRows.length} raw articles found`);
    await selectAndSummarize(env, rawRows);
  } else {
    console.log('select: no raw articles to select from');
  }

  // Delivery runs regardless of whether new raw articles were selected this run,
  // so any already-summarized backlog still ships.
  await deliver(env, force);
}

async function selectAndSummarize(
  env: Env,
  rawRows: { id: number; title: string; content_snippet: string | null; source_name: string | null }[]
): Promise<void> {
  const { results: recent } = await getRecentDeliveredTitles(env.DB, 30);
  const recentTitles = recent.map((r) => r.title);

  let selectedIds: number[];
  let bucketIds: number[] = [];
  try {
    const candidates = rawRows.map((r) => ({
      id: r.id,
      title: r.title,
      snippet: r.content_snippet || '',
      source: r.source_name || '',
    }));

    const { selected, bucket } = await selectTopArticles(candidates, recentTitles, env.GEMINI_API_KEY);
    selectedIds = selected.map((s) => s.id);
    bucketIds = bucket;

    console.log(
      `select: selector chose ${selectedIds.length} articles: [${selectedIds.join(',')}], ` +
        `bucketed ${bucketIds.length} for next run: [${bucketIds.join(',')}]`
    );
  } catch (err) {
    console.error('select: selector failed:', err instanceof Error ? err.message : err);
    return;
  }

  // Skip everything the selector neither picked nor bucketed. Bucketed articles are left
  // 'raw' so the next select run reconsiders them alongside newly-fetched candidates.
  const keep = new Set([...selectedIds, ...bucketIds]);
  const notSelectedIds = rawRows.map((r) => r.id).filter((id) => !keep.has(id));
  if (notSelectedIds.length) {
    await markArticlesSkipped(env.DB, notSelectedIds);
    console.log(`select: marked ${notSelectedIds.length} articles as skipped`);
  }

  if (!selectedIds.length) {
    console.log('select: no articles selected');
    return;
  }

  await markArticlesSelected(env.DB, selectedIds);

  const { results: selectedArticles } = await getSelectedArticles(env.DB);
  if (!selectedArticles.length) {
    console.log('select: no selected articles found after marking');
    return;
  }

  let succeeded = 0;
  for (const article of selectedArticles) {
    const lock = await lockArticle(env.DB, article.id);
    if (!lock.meta.changes) {
      console.log(`select: article ${article.id} could not be locked`);
      continue;
    }

    console.log(`select: summarizing article ${article.id} "${article.title}"`);

    // Fetch the full article body for the summarizer; the RSS teaser is often too
    // short to contain the key facts (numbers, records). Fall back to the teaser
    // if the page fetch yields nothing useful or is shorter than what we have.
    const teaser = article.content_snippet || '';
    const fullText = await fetchArticleText(article.url);
    const contentForSummary = fullText && fullText.length > teaser.length ? fullText : teaser;
    console.log(
      `select: article ${article.id} content ${contentForSummary.length} chars ` +
        `(${contentForSummary === teaser ? 'teaser' : 'full page'})`
    );

    try {
      const result = await summarizeAndTranslate(
        article.title,
        contentForSummary,
        article.source_name || '',
        env.GEMINI_API_KEY
      );
      console.log(
        `select: article ${article.id} [${result.category}|${result.relevance_score}] done`
      );
      await markArticleDone(
        env.DB,
        article.id,
        result.summary,
        result.full_fa,
        result.category,
        result.relevance_score
      );
      succeeded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error(`select: article ${article.id} failed: ${msg}`);
      await markArticleFailed(env.DB, article.id, msg);
    }
  }

  console.log(`select: summarized ${succeeded}/${selectedArticles.length} articles`);
}

async function deliver(env: Env, force = false): Promise<void> {
  const { results: subscribers } = await getActiveSubscribers(env.DB);
  if (!subscribers.length) {
    console.log('select: no active subscribers');
    return;
  }

  const { results: readyArticles } = await getUndeliveredArticles(env.DB, 50);
  if (!readyArticles.length) {
    console.log('select: no articles ready for delivery');
    return;
  }

  const ordered = rotateCategories(readyArticles);

  console.log(`select: delivering ${ordered.length} articles to ${subscribers.length} subscribers`);

  // Pass 1 delivers all TEXT; pass 2 voices the articles. Audio is the slowest work in the
  // run (Live API over WebSocket) and the invocation has a bounded duration, so we finish
  // every text send first — a slow or killed audio pass can then never delay or drop text.
  // Per article we record which subscribers received the text, so the audio pass can
  // synthesize the reading ONCE and fan the same WAV out to all of them.
  const audioRecipients = new Map<
    number,
    { article: Article & { source_name: string }; chatIds: number[] }
  >();

  for (const sub of subscribers) {
    // force (manual /run-select) bypasses the per-hour rate limit so the bot can be
    // exercised at night during development.
    const sentThisHour = force ? 0 : (await getSubscriberMessageCount(env.DB, sub.chat_id))?.c ?? 0;
    let remaining = MAX_MESSAGES_PER_HOUR - sentThisHour;
    let sent = 0;

    if (remaining <= 0) {
      console.log(
        `select: subscriber ${sub.chat_id} rate-limited (${sentThisHour}/${MAX_MESSAGES_PER_HOUR} this hour)`
      );
      continue;
    }

    for (const article of ordered) {
      if (sent >= SELECT_TOP_N || remaining <= 0) break;

      try {
        const messageId = await sendArticle(
          sub.chat_id,
          article,
          article.source_name || '',
          env.BOT_TOKEN
        );
        const ok = messageId != null;
        await logDelivery(env.DB, article.id, sub.chat_id, ok);
        if (ok) {
          sent++;
          remaining--;
          await markDelivered(env.DB, article.id);
          console.log(`select: article ${article.id} [${article.category}] → ${sub.chat_id} OK`);
          // Queue this subscriber for the article's voice reading (full_fa, falling back to
          // the summary). Generated once per article in pass 2, never inline here.
          const voiceText = article.full_fa || article.summary_fa;
          if (SEND_AUDIO && voiceText) {
            let entry = audioRecipients.get(article.id);
            if (!entry) {
              entry = { article, chatIds: [] };
              audioRecipients.set(article.id, entry);
            }
            entry.chatIds.push(sub.chat_id);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown';
        if (msg === 'BLOCKED') {
          console.warn(`select: subscriber ${sub.chat_id} blocked the bot`);
          await deactivateSubscriber(env.DB, sub.chat_id);
          await logDelivery(env.DB, article.id, sub.chat_id, false, 'blocked');
          break;
        } else if (msg === 'RATE_LIMITED') {
          console.warn('select: Telegram rate limited, stopping');
          break;
        } else {
          console.error(`select: article ${article.id} → ${sub.chat_id}: ${msg}`);
          await logDelivery(env.DB, article.id, sub.chat_id, false, msg);
        }
      }
    }

    console.log(`select: sent ${sent} articles to ${sub.chat_id}`);
  }

  if (SEND_AUDIO && audioRecipients.size) {
    await deliverAudio(env, audioRecipients);
  }
}

/**
 * Voice each delivered article once and fan the WAV out to every subscriber who received
 * the text. Best-effort: generation/send failures are logged, never thrown — text is
 * already delivered by the time this runs. Bounded by AUDIO_PASS_BUDGET_MS so a slow Live
 * API session can't push the scheduled invocation past its duration limit; when the budget
 * is hit we stop voicing further articles and log which ones were skipped.
 */
async function deliverAudio(
  env: Env,
  audioRecipients: Map<number, { article: Article & { source_name: string }; chatIds: number[] }>
): Promise<void> {
  const start = Date.now();
  let voiced = 0;
  const skipped: number[] = [];

  for (const { article, chatIds } of audioRecipients.values()) {
    if (Date.now() - start > AUDIO_PASS_BUDGET_MS) {
      skipped.push(article.id);
      continue;
    }

    const voiceText = article.full_fa || article.summary_fa;
    if (!voiceText) continue;

    let wav: Uint8Array | null = null;
    try {
      wav = await generateAudio(voiceText, article.title, env.GEMINI_API_KEY);
    } catch (err) {
      console.error(
        `select: article ${article.id} audio generation failed: ${err instanceof Error ? err.message : err}`
      );
      continue;
    }
    if (!wav) {
      console.warn(`select: article ${article.id} audio skipped (no audio generated)`);
      continue;
    }

    for (const chatId of chatIds) {
      try {
        await sendAudio(chatId, wav, article.title, env.BOT_TOKEN);
        console.log(`select: article ${article.id} audio → ${chatId} OK`);
      } catch (audioErr) {
        console.error(
          `select: article ${article.id} audio → ${chatId} failed: ${audioErr instanceof Error ? audioErr.message : audioErr}`
        );
      }
    }
    voiced++;
  }

  if (skipped.length) {
    console.warn(
      `select: audio pass hit ${AUDIO_PASS_BUDGET_MS}ms budget, skipped voice for ` +
        `${skipped.length} article(s): [${skipped.join(',')}]`
    );
  }
  console.log(`select: voiced ${voiced}/${audioRecipients.size} articles`);
}

function rotateCategories(
  articles: (Article & { source_name: string })[]
): (Article & { source_name: string })[] {
  const byCategory: Record<string, (Article & { source_name: string })[]> = {};
  for (const a of articles) {
    const cat = a.category || 'other';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(a);
  }

  const result: (Article & { source_name: string })[] = [];
  let lastCategory = '';
  let consecutiveCount = 0;
  const categories = Object.keys(byCategory);

  while (result.length < articles.length) {
    let chosen = categories.find((cat) => {
      if (byCategory[cat].length === 0) return false;
      if (cat === lastCategory && consecutiveCount >= MAX_SAME_CATEGORY_IN_ROW) return false;
      return true;
    });

    if (!chosen) {
      consecutiveCount = 0;
      chosen = categories.find((cat) => byCategory[cat].length > 0);
    }

    if (!chosen) break;

    result.push(byCategory[chosen].shift()!);
    if (chosen === lastCategory) {
      consecutiveCount++;
    } else {
      consecutiveCount = 1;
      lastCategory = chosen;
    }
  }

  return result;
}
