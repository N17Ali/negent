import { Env, Article } from '../types';
import { sendArticleBatch } from '../services/telegram';
import {
  getUndeliveredArticles,
  getActiveSubscribers,
  getSubscriberMessageCount,
  markMultipleDelivered,
  logDelivery,
  deactivateSubscriber,
} from '../db';
import {
  MAX_ARTICLES_PER_DELIVERY,
  ARTICLES_PER_MESSAGE,
  MAX_MESSAGES_PER_HOUR,
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

  const batches: (Article & { source_name: string })[][] = [];
  for (let i = 0; i < articles.length; i += ARTICLES_PER_MESSAGE) {
    batches.push(articles.slice(i, i + ARTICLES_PER_MESSAGE));
  }

  console.log(
    `deliver: ${articles.length} articles in ${batches.length} batches × ${subscribers.length} subscribers`
  );

  for (const sub of subscribers) {
    const countResult = await getSubscriberMessageCount(env.DB, sub.chat_id);
    const sentThisHour = countResult?.c ?? 0;
    let remaining = MAX_MESSAGES_PER_HOUR - sentThisHour;

    if (remaining <= 0) {
      console.log(`deliver: subscriber ${sub.chat_id} rate-limited (${sentThisHour}/${MAX_MESSAGES_PER_HOUR} this hour)`);
      continue;
    }

    for (const batch of batches) {
      if (remaining <= 0) break;

      const articleIds = batch.map((a) => a.id);
      try {
        const ok = await sendArticleBatch(sub.chat_id, batch, env.BOT_TOKEN);
        for (const id of articleIds) {
          await logDelivery(env.DB, id, sub.chat_id, ok);
        }
        if (ok) {
          remaining--;
          console.log(`deliver: batch [${articleIds.join(',')}] → ${sub.chat_id} OK`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown';
        if (msg === 'BLOCKED') {
          console.warn(`deliver: subscriber ${sub.chat_id} blocked the bot`);
          await deactivateSubscriber(env.DB, sub.chat_id);
          for (const id of articleIds) {
            await logDelivery(env.DB, id, sub.chat_id, false, 'blocked');
          }
          break;
        } else if (msg === 'RATE_LIMITED') {
          console.warn('deliver: Telegram rate limited, stopping');
          break;
        } else {
          console.error(`deliver: batch [${articleIds.join(',')}] → ${sub.chat_id}: ${msg}`);
          for (const id of articleIds) {
            await logDelivery(env.DB, id, sub.chat_id, false, msg);
          }
        }
      }
    }
  }

  const allArticleIds = articles.map((a) => a.id);
  await markMultipleDelivered(env.DB, allArticleIds);
  console.log(`deliver: marked ${allArticleIds.length} articles as delivered`);
}
