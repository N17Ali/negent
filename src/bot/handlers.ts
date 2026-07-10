import { Env, Source } from '../types';
import { sendMessage } from '../services/telegram';
import {
  upsertSubscriber,
  unsubscribe,
  isAdmin,
  getAllSources,
} from '../db';
import { D1Result } from '@cloudflare/workers-types';

export async function handleStart(chatId: number, username: string | null, firstName: string | null, env: Env): Promise<void> {
  await upsertSubscriber(env.DB, chatId, username, firstName);
  await sendMessage(
    chatId,
    '👋 سلام! به ربات اخبار تکنولوژی خوش اومدی.\n'
    + 'من مهم‌ترین اخبار هوش مصنوعی، برنامه‌نویسی و بازی‌های کامپیوتری رو از منابع معتبر دنیا جمع‌آوری می‌کنم و خلاصه‌اشون رو به فارسی هر روز بین ساعت ۹ صبح تا ۹ شب برات میفرستم.\n\n'
    + '📚 دستورها:\n'
    + '/sources — لیست منابع خبری\n'
    + '/stop — لغو اشتراک',
    env.BOT_TOKEN
  );
}

export async function handleStop(chatId: number, env: Env): Promise<void> {
  await unsubscribe(env.DB, chatId);
  await sendMessage(
    chatId,
    '✋ اشتراکت لغو شد.\nهر وقت خواستی دوباره /start بزن.',
    env.BOT_TOKEN
  );
}

export async function handleSources(chatId: number, env: Env): Promise<void> {
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
    '📡 <b>منابع خبری:</b>\n\n' + list,
    env.BOT_TOKEN
  );
}

export async function handleStatus(chatId: number, env: Env): Promise<void> {
  const admin = await isAdmin(env.DB, chatId);
  if (!admin?.is_admin) {
    await sendMessage(chatId, '⛔ Admins only.', env.BOT_TOKEN);
    return;
  }
  const stats = await env.DB.batch([
    env.DB.prepare('SELECT COUNT(*) as c FROM sources WHERE active = 1'),
    env.DB.prepare("SELECT COUNT(*) as c FROM articles WHERE status = 'raw'"),
    env.DB.prepare("SELECT COUNT(*) as c FROM articles WHERE status = 'selected'"),
    env.DB.prepare("SELECT COUNT(*) as c FROM articles WHERE status = 'processing'"),
    env.DB.prepare("SELECT COUNT(*) as c FROM articles WHERE status = 'done' AND delivered = 0"),
    env.DB.prepare("SELECT COUNT(*) as c FROM articles WHERE delivered = 1"),
    env.DB.prepare("SELECT COUNT(*) as c FROM articles WHERE status = 'skipped'"),
    env.DB.prepare("SELECT COUNT(*) as c FROM articles WHERE status = 'failed'"),
    env.DB.prepare("SELECT COUNT(*) as c FROM articles WHERE status = 'done' AND relevance_score >= 4"),
    env.DB.prepare('SELECT COUNT(*) as c FROM subscribers WHERE is_active = 1'),
    env.DB.prepare(
      "SELECT COALESCE(category, '?') as cat, COUNT(*) as c FROM articles WHERE status = 'done' GROUP BY category"
    ),
  ]);
  const [src, raw, selected, processing, ready, delivered, skipped, failed, highScore, subs, byCat] =
    stats;
  const catLines = (byCat.results as { cat: string; c: number }[])
    .map((r) => '   • ' + r.cat + ': ' + r.c)
    .join('\n') || '   • (none yet)';
  await sendMessage(
    chatId,
    '📊 <b>System status</b>\n'
      + '<i>Pipeline: raw → selected → processing → ready → delivered</i>\n\n'
      + '📡 <b>Active sources</b>: ' + count(src) + '\n'
      + '   <i>RSS feeds currently being polled</i>\n\n'
      + '📥 <b>Raw (queued)</b>: ' + count(raw) + '\n'
      + '   <i>Fetched, waiting for the LLM to pick the best ones</i>\n\n'
      + '🎯 <b>Selected</b>: ' + count(selected) + '\n'
      + '   <i>Chosen by the LLM, waiting to be summarized</i>\n\n'
      + '⚙️ <b>Processing</b>: ' + count(processing) + '\n'
      + '   <i>Being summarized/translated right now</i>\n\n'
      + '✅ <b>Ready to send</b>: ' + count(ready) + '\n'
      + '   <i>Summarized, not yet delivered to subscribers</i>\n\n'
      + '📤 <b>Delivered</b>: ' + count(delivered) + '\n'
      + '   <i>Successfully sent out</i>\n\n'
      + '⭐ <b>High score (4+)</b>: ' + count(highScore) + '\n'
      + '   <i>Done articles the LLM rated most important</i>\n\n'
      + '⏭ <b>Skipped</b>: ' + count(skipped) + '\n'
      + '   <i>Not selected — filtered out as unimportant</i>\n\n'
      + '❌ <b>Failed</b>: ' + count(failed) + '\n'
      + '   <i>Summarize/deliver errored (see retry_count)</i>\n\n'
      + '👥 <b>Active subscribers</b>: ' + count(subs) + '\n\n'
      + '📋 <b>Done by category</b>:\n' + catLines,
    env.BOT_TOKEN
  );
}

// D1 COUNT(*) helper — the count queries all alias the total to `c`.
function count(result: D1Result): number {
  const row = result.results[0] as { c: number } | undefined;
  return row?.c ?? 0;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
}