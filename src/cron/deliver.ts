import { Env, Article } from '../types';
import { sendArticle } from '../services/telegram';
import {
  getUndeliveredArticles,
  getActiveSubscribers,
  getSubscriberMessageCount,
  getRecentDeliveredTitles,
  markDelivered,
  logDelivery,
  deactivateSubscriber,
} from '../db';
import { filterDuplicates, isSimilarTitle } from '../utils/dedup';
import {
  MAX_ARTICLES_PER_DELIVERY,
  MAX_SEND_PER_RUN,
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

export async function deliverCron(env: Env): Promise<void> {
  if (!isWithinDeliveryHours()) {
    console.log('deliver: outside delivery hours (9am-9pm Tehran), skipping');
    return;
  }

  const { results: articles } = await getUndeliveredArticles(
    env.DB,
    MAX_ARTICLES_PER_DELIVERY
  );
  if (!articles.length) {
    console.log('deliver: no articles to deliver');
    return;
  }

  const { results: subscribers } = await getActiveSubscribers(env.DB);
  if (!subscribers.length) {
    console.log('deliver: no active subscribers');
    return;
  }

  const { results: recent } = await getRecentDeliveredTitles(env.DB, 30);
  const recentTitles = recent.map((r) => r.title);

  const deduped = filterDuplicates(
    articles.map((a) => ({ id: a.id, title: a.title, category: a.category })),
    recentTitles
  );
  const dedupedIds = new Set(deduped.map((a) => a.id));
  const filtered = articles.filter((a) => dedupedIds.has(a.id));

  const ordered = rotateCategories(filtered);

  console.log(
    `deliver: ${articles.length} candidates → ${filtered.length} after dedup → ${ordered.length} ordered`
  );

  for (const sub of subscribers) {
    const countResult = await getSubscriberMessageCount(env.DB, sub.chat_id);
    const sentThisHour = countResult?.c ?? 0;
    let remaining = MAX_MESSAGES_PER_HOUR - sentThisHour;
    let sent = 0;

    if (remaining <= 0) {
      console.log(
        `deliver: subscriber ${sub.chat_id} rate-limited (${sentThisHour}/${MAX_MESSAGES_PER_HOUR} this hour)`
      );
      continue;
    }

    for (const article of ordered) {
      if (sent >= MAX_SEND_PER_RUN || remaining <= 0) break;

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
          console.log(`deliver: article ${article.id} [${article.category}] → ${sub.chat_id} OK`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown';
        if (msg === 'BLOCKED') {
          console.warn(`deliver: subscriber ${sub.chat_id} blocked the bot`);
          await deactivateSubscriber(env.DB, sub.chat_id);
          await logDelivery(env.DB, article.id, sub.chat_id, false, 'blocked');
          break;
        } else if (msg === 'RATE_LIMITED') {
          console.warn('deliver: Telegram rate limited, stopping');
          break;
        } else {
          console.error(`deliver: article ${article.id} → ${sub.chat_id}: ${msg}`);
          await logDelivery(env.DB, article.id, sub.chat_id, false, msg);
        }
      }
    }

    console.log(`deliver: sent ${sent} articles to ${sub.chat_id}`);
  }
}

function rotateCategories(articles: (Article & { source_name: string })[]): (Article & { source_name: string })[] {
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
