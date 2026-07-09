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
 * The voice is generated FIRST, then the text and the voice are sent back-to-back so they
 * arrive together, with the audio quoting (replying to) the text message.
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

  // Generate the voice ONCE, before any text goes out, so text + voice arrive together.
  let wav: Uint8Array | null = null;
  const voiceText = article.full_fa || article.summary_fa;
  if (SEND_AUDIO && voiceText) {
    try {
      wav = await generateAudio(voiceText, article.title, env.GEMINI_API_KEY);
      if (!wav) console.warn(`deliver: article ${article.id} produced no audio`);
    } catch (err) {
      console.error(
        `deliver: article ${article.id} audio generation failed: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  let anyDelivered = false;
  for (const sub of eligible) {
    try {
      const messageId = await sendArticle(sub.chat_id, article, article.source_name || '', env.BOT_TOKEN);
      const ok = messageId != null;
      await logDelivery(env.DB, article.id, sub.chat_id, ok);
      if (!ok) continue;
      anyDelivered = true;
      console.log(`deliver: article ${article.id} [${article.category}] → ${sub.chat_id} OK`);

      // Voice reading, quoting the text message. Best-effort — the text is already sent.
      if (wav) {
        try {
          await sendAudio(sub.chat_id, wav, article.title, env.BOT_TOKEN, messageId);
          console.log(`deliver: article ${article.id} audio → ${sub.chat_id} OK`);
        } catch (audioErr) {
          console.error(
            `deliver: article ${article.id} audio → ${sub.chat_id} failed: ${audioErr instanceof Error ? audioErr.message : audioErr}`
          );
        }
      }
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

  // Mark delivered once it has reached at least one subscriber (matches the prior
  // any-subscriber semantics), so the next tick advances to the following article.
  if (anyDelivered) {
    await markDelivered(env.DB, article.id);
  }
  return anyDelivered;
}
