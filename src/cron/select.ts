import { Env, Article } from '../types';
import { selectTopArticles } from '../services/deepseek';
import { summarizeAndTranslate } from '../services/gemini';
import { sendArticle } from '../services/telegram';
import {
  getRawArticlesBatch,
  getRecentDeliveredTitles,
  markArticlesSkipped,
  markArticlesSelected,
  getSelectedArticles,
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

export async function selectCron(env: Env): Promise<void> {
  if (!isWithinDeliveryHours()) {
    console.log('select: outside delivery hours (9am-9pm Tehran), skipping');
    return;
  }

  const { results: rawRows } = await getRawArticlesBatch(env.DB, BATCH_SELECT_SIZE);
  if (!rawRows.length) {
    console.log('select: no raw articles to select from');
    return;
  }

  console.log(`select: ${rawRows.length} raw articles found`);

  const { results: recent } = await getRecentDeliveredTitles(env.DB, 30);
  const recentTitles = recent.map((r) => r.title);

  let selectedIds: number[];
  try {
    const candidates = rawRows.map((r) => ({
      id: r.id,
      title: r.title,
      snippet: r.content_snippet || '',
      source: r.source_name || '',
    }));

    const selected = await selectTopArticles(candidates, recentTitles, env.NVIDIA_API_KEY);
    selectedIds = selected.map((s) => s.id);

    console.log(
      `select: DeepSeek chose ${selectedIds.length} articles: [${selectedIds.join(',')}]`
    );
  } catch (err) {
    console.error('select: DeepSeek failed:', err instanceof Error ? err.message : err);
    return;
  }

  const notSelectedIds = rawRows.map((r) => r.id).filter((id) => !selectedIds.includes(id));
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

    try {
      const result = await summarizeAndTranslate(
        article.title,
        article.content_snippet || '',
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

  const { results: subscribers } = await getActiveSubscribers(env.DB);
  if (!subscribers.length) {
    console.log('select: no active subscribers');
    return;
  }

  const { results: doneArticles } = await getSelectedArticles(env.DB);
  const readyArticles = doneArticles.filter((a) => a.status === 'done');
  if (!readyArticles.length) {
    console.log('select: no articles ready for delivery');
    return;
  }

  const ordered = rotateCategories(readyArticles);

  console.log(`select: delivering ${ordered.length} articles to ${subscribers.length} subscribers`);

  for (const sub of subscribers) {
    const countResult = await getSubscriberMessageCount(env.DB, sub.chat_id);
    const sentThisHour = countResult?.c ?? 0;
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
        const ok = await sendArticle(
          sub.chat_id,
          article,
          article.source_name || '',
          env.BOT_TOKEN
        );
        await logDelivery(env.DB, article.id, sub.chat_id, ok);
        if (ok) {
          sent++;
          remaining--;
          await markDelivered(env.DB, article.id);
          console.log(`select: article ${article.id} [${article.category}] → ${sub.chat_id} OK`);
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
