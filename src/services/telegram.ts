import { Article, Source } from '../types';
import { MAX_CAPTION_LENGTH, MAX_MESSAGE_LENGTH } from '../utils/constants';

export async function sendArticle(
  chatId: number,
  article: Article,
  sourceName: string,
  botToken: string
): Promise<boolean> {
  const caption = formatCaption(article, sourceName);
  const message = formatMessage(article, sourceName);

  if (article.media_url && article.media_type === 'photo') {
    const ok = await sendPhoto(chatId, article.media_url, caption, botToken);
    if (ok) return true;
  }

  if (article.media_url && article.media_type === 'video') {
    const ok = await sendVideo(chatId, article.media_url, caption, botToken);
    if (ok) return true;
  }

  return sendMessage(chatId, message, botToken);
}

function formatCaption(article: Article, sourceName: string): string {
  const title = `<b>${escapeHtml(article.title)}</b>`;
  const footer = `\n\n🔗 <a href="${article.url}">منبع</a> | 📡 ${escapeHtml(sourceName)}`;
  const available = MAX_CAPTION_LENGTH - title.length - footer.length - 4;
  const summary = truncate(article.summary_fa || '', available);
  return `${title}\n\n${summary}${footer}`;
}

function formatMessage(article: Article, sourceName: string): string {
  const title = `<b>${escapeHtml(article.title)}</b>`;
  const footer = `\n\n🔗 <a href="${article.url}">منبع</a> | 📡 ${escapeHtml(sourceName)}`;
  const mediaLine = article.media_url ? `\n\n🖼 <a href="${article.media_url}">تصویر</a>` : '';
  const available = MAX_MESSAGE_LENGTH - title.length - footer.length - mediaLine.length - 4;
  const summary = truncate(article.summary_fa || '', available);
  return `${title}\n\n${summary}${footer}${mediaLine}`;
}

async function sendPhoto(
  chatId: number,
  photoUrl: string,
  caption: string,
  token: string
): Promise<boolean> {
  const resp = await tgFetch(token, 'sendPhoto', {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: 'HTML',
  });
  if (resp.ok) return true;
  const data = (await resp.json()) as { description?: string };
  if (
    data.description?.includes('wrong file identifier') ||
    data.description?.includes('failed to get HTTP URL content')
  ) {
    return false;
  }
  return handleTgError(resp.status);
}

async function sendVideo(
  chatId: number,
  videoUrl: string,
  caption: string,
  token: string
): Promise<boolean> {
  const resp = await tgFetch(token, 'sendVideo', {
    chat_id: chatId,
    video: videoUrl,
    caption,
    parse_mode: 'HTML',
  });
  if (resp.ok) return true;
  return false;
}

export async function sendMessage(
  chatId: number,
  text: string,
  token: string
): Promise<boolean> {
  const resp = await tgFetch(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
  });
  if (resp.ok) return true;
  return handleTgError(resp.status);
}

export async function setWebhook(token: string, url: string): Promise<boolean> {
  const resp = await tgFetch(token, 'setWebhook', { url });
  return resp.ok;
}

function tgFetch(token: string, method: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function handleTgError(status: number): boolean {
  if (status === 403) throw new Error('BLOCKED');
  if (status === 429) throw new Error('RATE_LIMITED');
  return false;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}
