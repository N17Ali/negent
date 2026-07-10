import { Article } from '../types';
import { MAX_CAPTION_LENGTH, MAX_MESSAGE_LENGTH } from '../utils/constants';

const RLM = '\u200F';

export async function sendArticle(
  chatId: number,
  article: Article,
  sourceName: string,
  botToken: string
): Promise<number | null> {
  const footer = formatFooter(article, sourceName);
  const summary = formatSummary(article.summary_fa || '');

  const hasMedia =
    !!article.media_url && (article.media_type === 'photo' || article.media_type === 'video');

  if (hasMedia) {
    // A photo/video caption is capped at ~1020 chars. If the whole summary fits, ship
    // it as the caption (one message). If it doesn't, DON'T truncate it into the caption
    // (that's what cut the Persian summaries mid-paragraph) — attach the media with a
    // short caption and send the full summary as its own message below.
    const caption = `${summary}${footer}`;
    if (caption.length <= MAX_CAPTION_LENGTH) {
      const id =
        article.media_type === 'photo'
          ? await sendPhoto(chatId, article.media_url!, caption, botToken)
          : await sendVideo(chatId, article.media_url!, caption, botToken);
      if (id !== null) return id;
      // media failed (e.g. dead image URL) → fall through to a plain text message
    } else {
      const shortCaption = footer.trimStart();
      if (article.media_type === 'photo') {
        await sendPhoto(chatId, article.media_url!, shortCaption, botToken);
      } else {
        await sendVideo(chatId, article.media_url!, shortCaption, botToken);
      }
      // The summary is the point — send it in full regardless of whether media attached.
      // Return this text message's id: it's the one worth quoting with the voice reading.
      const body = `${summary}${footer}`;
      return sendMessage(chatId, truncate(body, MAX_MESSAGE_LENGTH), botToken);
    }
  }

  return sendMessage(chatId, formatMessage(article, sourceName), botToken);
}

async function sendPhoto(
  chatId: number,
  photoUrl: string,
  caption: string,
  token: string
): Promise<number | null> {
  const resp = await tgFetch(token, 'sendPhoto', {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: 'HTML',
  });
  if (resp.ok) return messageIdFrom(resp);
  const data = (await resp.json()) as { description?: string };
  if (
    data.description?.includes('wrong file identifier') ||
    data.description?.includes('failed to get HTTP URL content')
  ) {
    return null;
  }
  handleTgError(resp.status);
  return null;
}

async function sendVideo(
  chatId: number,
  videoUrl: string,
  caption: string,
  token: string
): Promise<number | null> {
  const resp = await tgFetch(token, 'sendVideo', {
    chat_id: chatId,
    video: videoUrl,
    caption,
    parse_mode: 'HTML',
  });
  if (resp.ok) return messageIdFrom(resp);
  return null;
}

function formatFooter(article: Article, sourceName: string): string {
  return `\n\n🔗 <a href="${article.url}">منبع</a> | 📡 ${escapeHtml(sourceName)}`;
}

function formatMessage(article: Article, sourceName: string): string {
  const footer = formatFooter(article, sourceName);
  const summary = formatSummary(article.summary_fa || '');
  const available = Math.max(0, MAX_MESSAGE_LENGTH - footer.length - 4);
  const truncated = truncate(summary, available);
  return `${truncated}${footer}`;
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
): Promise<number | null> {
  const resp = await tgFetch(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
  });
  if (resp.ok) return messageIdFrom(resp);
  handleTgError(resp.status);
  return null;
}

/** Extract message_id from a successful Telegram API response, or null if absent. */
async function messageIdFrom(resp: Response): Promise<number | null> {
  try {
    const data = (await resp.json()) as { result?: { message_id?: number } };
    return data.result?.message_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Upload a WAV voice reading as a Telegram audio message. Best-effort — returns false
 * on ordinary failures and only throws BLOCKED/RATE_LIMITED (same contract as the other
 * senders) so the caller can react. Uses multipart/form-data via the built-in FormData
 * (no deps). sendAudio (not sendVoice) because sendVoice requires OGG/Opus, while a
 * WAV plays inline as audio.
 *
 * The upload filename is derived from the title so Telegram (e.g. macOS) shows the
 * article name instead of a generic "negent.wav"; `performer` tags the artist as negent.
 */
export async function sendAudio(
  chatId: number,
  wav: Uint8Array,
  title: string,
  token: string,
  replyToMessageId?: number
): Promise<boolean> {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('title', title.slice(0, 64));
  form.append('performer', 'negent');
  // Quote the article's text message so the voice reading shows up as a reply beneath it.
  // allow_sending_without_reply so a deleted/missing text message still lets the audio send.
  if (replyToMessageId != null) {
    form.append('reply_to_message_id', String(replyToMessageId));
    form.append('allow_sending_without_reply', 'true');
  }
  form.append(
    'audio',
    new Blob([wav], { type: 'audio/wav' }),
    `${audioFileName(title)}.wav`
  );

  const resp = await fetch(`https://api.telegram.org/bot${token}/sendAudio`, {
    method: 'POST',
    body: form,
  });
  if (resp.ok) return true;
  return handleTgError(resp.status);
}

/** Sanitize an article title into a safe audio filename stem (no path/control chars). */
function audioFileName(title: string): string {
  const cleaned = title
    .replace(/[\/\\<>:"|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || 'negent';
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

// Truncate without cutting mid-sentence: prefer the last paragraph break, then the
// last sentence end, then a word boundary, that fits within maxLen (leaving room for
// the ellipsis). Guards against a negative/zero budget yielding a garbage tail slice.
function truncate(text: string, maxLen: number): string {
  if (maxLen <= 0) return '';
  if (text.length <= maxLen) return text;
  const budget = maxLen - 3;
  if (budget <= 0) return text.slice(0, maxLen);
  const window = text.slice(0, budget);
  const para = window.lastIndexOf('\n\n');
  if (para >= budget * 0.5) return window.slice(0, para).trimEnd();
  const sentence = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('؟ '),
    window.lastIndexOf('! '),
    window.lastIndexOf('۔ ')
  );
  if (sentence >= budget * 0.5) return window.slice(0, sentence + 1).trimEnd();
  const space = window.lastIndexOf(' ');
  const cut = space >= budget * 0.5 ? space : budget;
  return window.slice(0, cut).trimEnd() + '...';
}

