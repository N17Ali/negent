import { Env, Source } from '../types';
import { sendMessage } from '../services/telegram';
import {
  upsertSubscriber,
  unsubscribe,
  isAdmin,
  getAllSources,
  addSource,
  removeSource,
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
    try {
      await upsertSubscriber(env.DB, chatId, username, firstName);
      console.log(`upsertSubscriber OK for ${chatId}`);
    } catch (err) {
      console.error('upsertSubscriber failed:', err instanceof Error ? err.message : err);
      throw err;
    }
    await sendMessage(
      chatId,
      '👋 سلام! عضو شدی.\nهر ۳ ساعت خلاصه اخبار تکنولوژی رو برات میفرستم.\n\nلغو اشتراک: /stop\nلیست منابع: /sources',
      env.BOT_TOKEN
    );
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
      `📡 <b>منابع خبری:</b>\n\n${list}\n\nاضافه کردن: /add URL نام\nحذف: /remove شماره`,
      env.BOT_TOKEN
    );
    return;
  }

  if (text.startsWith('/add ')) {
    const admin = await isAdmin(env.DB, chatId);
    if (!admin?.is_admin) {
      await sendMessage(chatId, '⛔ فقط ادمین میتونه منبع اضافه کنه.', env.BOT_TOKEN);
      return;
    }
    const parts = text.slice(5).trim().split(/\s+/);
    const url = parts[0];
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      await sendMessage(chatId, '❌ فرمت: /add https://example.com/feed نام', env.BOT_TOKEN);
      return;
    }
    const name = parts.slice(1).join(' ') || hostname;
    try {
      await addSource(env.DB, url, name, chatId);
      await sendMessage(chatId, `✅ منبع اضافه شد: <b>${escapeHtml(name)}</b>`, env.BOT_TOKEN);
    } catch {
      await sendMessage(chatId, '❌ این منبع قبلاً اضافه شده.', env.BOT_TOKEN);
    }
    return;
  }

  if (text.startsWith('/remove ')) {
    const admin = await isAdmin(env.DB, chatId);
    if (!admin?.is_admin) {
      await sendMessage(chatId, '⛔ فقط ادمین میتونه منبع حذف کنه.', env.BOT_TOKEN);
      return;
    }
    const idStr = text.slice(8).trim();
    const { results: sources } = await getAllSources(env.DB);
    const idx = parseInt(idStr, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= sources.length) {
      await sendMessage(chatId, '❌ شماره نامعتبر. /sources رو بزن.', env.BOT_TOKEN);
      return;
    }
    const source = sources[idx];
    await removeSource(env.DB, source.id);
    await sendMessage(
      chatId,
      `🗑 منبع غیرفعال شد: <b>${escapeHtml(source.name)}</b>`,
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
      env.DB.prepare("SELECT COUNT(*) as c FROM articles WHERE status = 'processing'"),
      env.DB.prepare("SELECT COUNT(*) as c FROM articles WHERE status = 'done' AND delivered = 0"),
      env.DB.prepare("SELECT COUNT(*) as c FROM articles WHERE status = 'failed'"),
      env.DB.prepare('SELECT COUNT(*) as c FROM subscribers WHERE is_active = 1'),
      env.DB.prepare(
        "SELECT COALESCE(category, '?') as cat, COUNT(*) as c FROM articles WHERE status = 'done' GROUP BY category"
      ),
      env.DB.prepare(
        "SELECT COUNT(*) as c FROM articles WHERE status = 'done' AND relevance_score >= 4"
      ),
    ]);
    const [src, raw, processing, done, failed, subs, byCat, highScore] = stats;
    const srcN = (src.results[0] as any).c;
    const rawN = (raw.results[0] as any).c;
    const processingN = (processing.results[0] as any).c;
    const doneN = (done.results[0] as any).c;
    const failedN = (failed.results[0] as any).c;
    const subsN = (subs.results[0] as any).c;
    const highScoreN = (highScore.results[0] as any).c;
    const catLines = (byCat.results as any[])
      .map((r) => `   ${r.cat}: ${r.c}`)
      .join('\n');
    await sendMessage(
      chatId,
      '📊 <b>وضعیت سیستم:</b>\n\n'
        + `📡 منابع فعال: <b>${srcN}</b>\n`
        + `📝 مقالات raw: <b>${rawN}</b>\n`
        + `⏳ در حال پردازش: <b>${processingN}</b>\n`
        + `✅ آماده ارسال: <b>${doneN}</b>\n`
        + `⭐ نمره بالا (4+): <b>${highScoreN}</b>\n`
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
