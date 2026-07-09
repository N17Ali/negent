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
          // Best-effort voice reading of the FULL translation (falls back to the summary
          // when full_fa is absent). Audio is a bonus channel — a Live API/quota failure
          // here must never affect the text delivery already counted above.
          const voiceText = article.full_fa || article.summary_fa;
          if (SEND_AUDIO && voiceText) {
            try {
              const wav = await generateAudio(voiceText, article.title, env.GEMINI_API_KEY);
              if (wav) {
                await sendAudio(sub.chat_id, wav, article.title, env.BOT_TOKEN);
                console.log(`select: article ${article.id} audio → ${sub.chat_id} OK`);
              } else {
                console.warn(`select: article ${article.id} audio skipped (no audio generated)`);
              }
            } catch (audioErr) {
              console.error(
                `select: article ${article.id} audio failed: ${audioErr instanceof Error ? audioErr.message : audioErr}`
              );
            }
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
