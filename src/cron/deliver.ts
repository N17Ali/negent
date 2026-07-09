import { Env } from '../types';
import { sendArticle, sendAudio } from '../services/telegram';
import { generateAudio } from '../services/tts';
import {
  getUndeliveredArticles,
  getActiveSubscribers,
  getSubscriberMessageCount,
  markDelivered,
  logDelivery,
  deactivateSubscriber,
} from '../db';
import { MAX_MESSAGES_PER_HOUR, SEND_AUDIO } from '../utils/constants';
import { isWithinDeliveryHours } from '../utils/time';

/**
 * Deliver ONE ready article and return whether anything was sent. Runs on its own cron
 * (cron/deliver.ts is dispatched at the :05,:15,… interleave between fetch ticks), so each
 * article ships in a separate Worker invocation — the voice synthesis (slow, CPU-heavy)
 * never has to share a run with fetch or with another article's audio, which is what kept
 * tripping the `exceededCpu` invocation limit before.
 *
 * The TEXT is sent FIRST (and the article marked delivered), then the voice is generated and
 * sent as a reply that quotes each subscriber's text message. Ordering matters: a full voice
 * pass can take ~a minute and the Live API sometimes stalls a turn, and a single Worker
 * invocation cannot hold that long — awaiting it inline gets `canceled` on client disconnect,
 * and deferring it past response end gets the `waitUntil() ... cancelled` time-limit. Either
 * way the audio can die; sending text first guarantees the summary always ships and the
 * article is never silently lost to a slow/stalled synthesis. The voice is pure best-effort
 * and arrives a few seconds later, threaded under the text.
 *
 * Rate limit: a subscriber still receives at most MAX_MESSAGES_PER_HOUR (3) articles in any
 * rolling hour — enforced here per tick via the delivery_log count, so the more frequent
 * delivery cron cannot exceed the cap.
 */
export async function deliverCron(env: Env, force = false): Promise<boolean> {
  if (!force && !isWithinDeliveryHours()) {
    return false;
  }

  const { results: subscribers } = await getActiveSubscribers(env.DB);
  if (!subscribers.length) return false;

  const { results: ready } = await getUndeliveredArticles(env.DB, 1);
  if (!ready.length) return false;
  const article = ready[0];

  // Only subscribers still under their hourly cap are eligible this tick. If none are,
  // leave the article undelivered (delivered=0) and don't waste a voice synthesis — a
  // later tick will pick it up once the rolling window clears.
  const eligible: typeof subscribers = [];
  for (const sub of subscribers) {
    const sentThisHour = force ? 0 : (await getSubscriberMessageCount(env.DB, sub.chat_id))?.c ?? 0;
    if (MAX_MESSAGES_PER_HOUR - sentThisHour > 0) {
      eligible.push(sub);
    } else {
      console.log(
        `deliver: subscriber ${sub.chat_id} rate-limited (${sentThisHour}/${MAX_MESSAGES_PER_HOUR} this hour)`
      );
    }
  }
  if (!eligible.length) {
    console.log('deliver: all subscribers rate-limited, deferring article');
    return false;
  }

  console.log(`deliver: article ${article.id} "${article.title}" → ${eligible.length} subscriber(s)`);

  // Pass 1: send the TEXT to every eligible subscriber and remember each one's message id so
  // the voice can quote it. Text is fast and reliable; do it before touching the slow voice
  // path so the summary always ships even if audio later stalls or gets time-limited.
  const textSent: { chatId: number; messageId: number }[] = [];
  let anyDelivered = false;
  for (const sub of eligible) {
    try {
      const messageId = await sendArticle(sub.chat_id, article, article.source_name || '', env.BOT_TOKEN);
      const ok = messageId != null;
      await logDelivery(env.DB, article.id, sub.chat_id, ok);
      if (!ok) continue;
      anyDelivered = true;
      textSent.push({ chatId: sub.chat_id, messageId: messageId as number });
      console.log(`deliver: article ${article.id} [${article.category}] → ${sub.chat_id} OK`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown';
      if (msg === 'BLOCKED') {
        console.warn(`deliver: subscriber ${sub.chat_id} blocked the bot`);
        await deactivateSubscriber(env.DB, sub.chat_id);
        await logDelivery(env.DB, article.id, sub.chat_id, false, 'blocked');
      } else if (msg === 'RATE_LIMITED') {
        console.warn('deliver: Telegram rate limited, stopping');
        break;
      } else {
        console.error(`deliver: article ${article.id} → ${sub.chat_id}: ${msg}`);
        await logDelivery(env.DB, article.id, sub.chat_id, false, msg);
      }
    }
  }

  // Mark delivered as soon as the text has reached at least one subscriber (matches the prior
  // any-subscriber semantics), so the article is locked in before the risky voice pass and the
  // next tick advances even if audio synthesis dies below.
  if (anyDelivered) {
    await markDelivered(env.DB, article.id);
  }

  // Pass 2: best-effort voice. Generate ONCE, then send it as a reply that quotes each
  // subscriber's text message. If this stalls or the invocation is time-limited, the text is
  // already delivered — the reader simply misses the audio for this one article.
  const voiceText = article.full_fa || article.summary_fa;
  if (textSent.length && SEND_AUDIO && voiceText) {
    let wav: Uint8Array | null = null;
    try {
      wav = await generateAudio(voiceText, article.title, env.GEMINI_API_KEY);
      if (!wav) console.warn(`deliver: article ${article.id} produced no audio`);
    } catch (err) {
      console.error(
        `deliver: article ${article.id} audio generation failed: ${err instanceof Error ? err.message : err}`
      );
    }
    if (wav) {
      for (const { chatId, messageId } of textSent) {
        try {
          await sendAudio(chatId, wav, article.title, env.BOT_TOKEN, messageId);
          console.log(`deliver: article ${article.id} audio → ${chatId} OK`);
        } catch (audioErr) {
          console.error(
            `deliver: article ${article.id} audio → ${chatId} failed: ${audioErr instanceof Error ? audioErr.message : audioErr}`
          );
        }
      }
    }
  }

  return anyDelivered;
}
