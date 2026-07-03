import { Env } from '../types';
import { sendArticle } from '../services/telegram';
import {
  getUndeliveredArticles,
  getActiveSubscribers,
  getDeliveredChatIds,
  getSubscriberMessageCount,
  markDelivered,
  logDelivery,
  deactivateSubscriber,
} from '../db';
import {
  MAX_ARTICLES_PER_DELIVERY,
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

  console.log(`deliver: ${articles.length} articles × ${subscribers.length} subscribers`);

  for (const article of articles) {
    let allSent = true;
    const { results: delivered } = await getDeliveredChatIds(env.DB, article.id);
    const alreadySent = new Set(delivered.map((d) => d.chat_id));

    for (const sub of subscribers) {
      if (alreadySent.has(sub.chat_id)) continue;

      const countResult = await getSubscriberMessageCount(env.DB, sub.chat_id);
      const sentThisHour = countResult?.c ?? 0;
      if (sentThisHour >= MAX_MESSAGES_PER_HOUR) continue;

      try {
        const ok = await sendArticle(
          sub.chat_id,
          article,
          article.source_name || '',
          env.BOT_TOKEN
        );
        await logDelivery(env.DB, article.id, sub.chat_id, ok);
        if (!ok) allSent = false;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown';
        if (msg === 'BLOCKED') {
          console.warn(`deliver: subscriber ${sub.chat_id} blocked the bot`);
          await deactivateSubscriber(env.DB, sub.chat_id);
          await logDelivery(env.DB, article.id, sub.chat_id, false, 'blocked');
        } else if (msg === 'RATE_LIMITED') {
          console.warn('deliver: rate limited, stopping batch');
          return;
        } else {
          console.error(`deliver: article ${article.id} → ${sub.chat_id}: ${msg}`);
          await logDelivery(env.DB, article.id, sub.chat_id, false, msg);
          allSent = false;
        }
      }
    }

    if (allSent) {
      await markDelivered(env.DB, article.id);
      console.log(`deliver: article ${article.id} sent to all`);
    }
  }
}
