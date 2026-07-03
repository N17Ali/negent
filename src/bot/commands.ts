import { Env, Source } from '../types';
import { sendMessage, sendArticle } from '../services/telegram';
import {
  upsertSubscriber,
  unsubscribe,
  isAdmin,
  getAllSources,
  getOneRecentArticle,
} from '../db';

interface TelegramUpdate {
  message?: {
    chat: { id: number };
    from?: { username?: string; first_name?: string };
    text?: string;
  };
}

export async function handleUpdate(update: TelegramUpdate, env: Env): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const username = msg.from?.username || null;
  const firstName = msg.from?.first_name || null;

  console.log(`command from ${chatId} (${username || firstName}): "${text}"`);

  if (text === '/start') {
    let isNew = false;
    try {
      const result = await upsertSubscriber(env.DB, chatId, username, firstName);
      isNew = result.isNew;
      console.log(`upsertSubscriber OK for ${chatId} (isNew=${isNew})`);
    } catch (err) {
      console.error('upsertSubscriber failed:', err instanceof Error ? err.message : err);
      throw err;
    }

    await sendMessage(
      chatId,
      '👋 سلام! به ربات اخبار تکنولوژی خوش اومدی.\n'
      + 'من مهم‌ترین اخبار هوش مصنوعی، برنامه‌نویسی و بازی‌های کامپیوتری رو از منابع معتبر دنیا جمع‌آوری می‌کنم و خلاصه‌اشون رو به فارسی هر روز بین ساعت ۹ صبح تا ۹ شب برات میفرستم.\n\n'
      + '📚 دستورها:\n'
      + '/sources — لیست منابع خبری\n'
      + '/stop — لغو اشتراک',
      env.BOT_TOKEN
    );

    if (isNew) {
      const article = await getOneRecentArticle(env.DB);
      if (article) {
        console.log(`start: sending welcome article ${article.id} to new subscriber ${chatId}`);
        try {
          await sendArticle(
            chatId,
            article,
            article.source_name || '',
            env.BOT_TOKEN
          );
        } catch (err) {
          console.error('start: failed to send welcome article:', err instanceof Error ? err.message : err);
        }
      }
    }
    return;
  }

  if (text === '/stop') {
    await unsubscribe(env.DB, chatId);
    await sendMessage(
      chatId,
      '✋ اشتراکت لغو شد.\nهر وقت خواستی دوباره /start بزن.',
      env.BOT_TOKEN
    );
    return;
  }

  if (text === '/sources') {
    const { results: sources } = await getAllSources(env.DB);
    if (!sources.length) {
      await sendMessage(chatId, 'هنوز منبعی اضافه نشده.', env.BOT_TOKEN);
      return;
    }
    const list = sources
      .map(
        (s: Source, i: number) =>
          `${i + 1}. ${s.active ? '✅' : '⏸'} <b>${escapeHtml(s.name)}</b>\n   <code>${s.url}</code>`
      )
      .join('\n');
    await sendMessage(
      chatId,
      `📡 <b>منابع خبری:</b>\n\n${list}`,
      env.BOT_TOKEN
    );
    return;
  }

  if (text === '/status') {
    const admin = await isAdmin(env.DB, chatId);
    if (!admin?.is_admin) {
      await sendMessage(chatId, '⛔ فقط ادمین.', env.BOT_TOKEN);
      return;
    }
    const stats = await env.DB.batch([
      env.DB.prepare('SELECT COUNT(*) as c FROM sources WHERE active = 1'),
      env.DB.prepare("SELECT COUNT(*) as c FROM articles WHERE status = 'raw'"),
      env.DB.prepare("SELECT COUNT(*) as c FROM articles WHERE status = 'selected'"),
      env.DB.prepare("SELECT COUNT(*) as c FROM articles WHERE status = 'done' AND delivered = 0"),
      env.DB.prepare("SELECT COUNT(*) as c FROM articles WHERE status = 'failed'"),
      env.DB.prepare("SELECT COUNT(*) as c FROM articles WHERE status = 'skipped'"),
      env.DB.prepare('SELECT COUNT(*) as c FROM subscribers WHERE is_active = 1'),
      env.DB.prepare(
        "SELECT COALESCE(category, '?') as cat, COUNT(*) as c FROM articles WHERE status = 'done' GROUP BY category"
      ),
      env.DB.prepare(
        "SELECT COUNT(*) as c FROM articles WHERE status = 'done' AND relevance_score >= 4"
      ),
    ]);
    const [src, raw, selected, done, failed, skipped, subs, byCat, highScore] = stats;
    const srcN = (src.results[0] as any).c;
    const rawN = (raw.results[0] as any).c;
    const selectedN = (selected.results[0] as any).c;
    const doneN = (done.results[0] as any).c;
    const failedN = (failed.results[0] as any).c;
    const skippedN = (skipped.results[0] as any).c;
    const subsN = (subs.results[0] as any).c;
    const highScoreN = (highScore.results[0] as any).c;
    const catLines = (byCat.results as any[])
      .map((r) => `   ${r.cat}: ${r.c}`)
      .join('\n');
    await sendMessage(
      chatId,
      '📊 <b>وضعیت سیستم:</b>\n\n'
        + `📡 منابع فعال: <b>${srcN}</b>\n`
        + `📝 صف انتظار: <b>${rawN}</b>\n`
        + `🎯 انتخاب‌شده: <b>${selectedN}</b>\n`
        + `✅ آماده ارسال: <b>${doneN}</b>\n`
        + `⭐ نمره بالا (4+): <b>${highScoreN}</b>\n`
        + `⏭ رد شده: <b>${skippedN}</b>\n`
        + `❌ ناموفق: <b>${failedN}</b>\n`
        + `👥 مشترکین فعال: <b>${subsN}</b>\n\n`
        + `📋 دسته‌بندی پردازش‌شده:\n${catLines}`,
      env.BOT_TOKEN
    );
    return;
  }

  console.log(`unknown command: "${text}"`);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
