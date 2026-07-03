import { Article } from '../types';
import { MAX_CAPTION_LENGTH, MAX_MESSAGE_LENGTH } from '../utils/constants';

const RLM = '\u200F';

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

function formatCaption(article: Article, sourceName: string): string {
  const catIcon = categoryIcon(article.category);
  const footer = `\n\n🔗 <a href="${article.url}">منبع</a> | 📡 ${escapeHtml(sourceName)}`;
  const summary = formatSummary(article.summary_fa || '');
  const available = MAX_CAPTION_LENGTH - footer.length - catIcon.length - 4;
  const truncated = truncate(summary, available);
  return `${catIcon}\n\n${truncated}${footer}`;
}

function formatMessage(article: Article, sourceName: string): string {
  const catIcon = categoryIcon(article.category);
  const footer = `\n\n🔗 <a href="${article.url}">منبع</a> | 📡 ${escapeHtml(sourceName)}`;
  const mediaLine = article.media_url
    ? ` | 🖼 <a href="${article.media_url}">تصویر</a>`
    : '';
  const summary = formatSummary(article.summary_fa || '');
  const available = MAX_MESSAGE_LENGTH - footer.length - mediaLine.length - catIcon.length - 4;
  const truncated = truncate(summary, available);
  return `${catIcon}\n\n${truncated}${footer}${mediaLine}`;
}

function formatSummary(summary: string): string {
  const paragraphs = summary.split(/\n\n+/);
  return paragraphs
    .map((p) => {
      const trimmed = p.trim();
      if (trimmed.startsWith('> ')) {
        const quoteText = trimmed.slice(2);
        return `<blockquote>${RLM}${escapeHtmlPreserveLinks(quoteText)}</blockquote>`;
      }
      return `${RLM}${escapeHtmlPreserveLinks(trimmed)}`;
    })
    .join('\n\n');
}

function escapeHtmlPreserveLinks(text: string): string {
  return text
    .replace(/&(?!(?:amp|lt|gt|quot|#39);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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

function categoryIcon(category: string | null): string {
  switch (category) {
    case 'ai':
      return '🤖';
    case 'programming':
      return '💻';
    case 'gaming':
      return '🎮';
    default:
      return '📰';
  }
}
