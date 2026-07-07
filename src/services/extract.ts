import { decodeEntities } from './rss';
import { MAX_ARTICLE_TEXT_LENGTH } from '../utils/constants';

const FETCH_TIMEOUT_MS = 8000;

// Blocks that never contain the article body — dropped whole (open tag to close).
const NOISE_BLOCKS = ['script', 'style', 'noscript', 'template', 'svg'];

// Closing tags that mark a paragraph/line boundary — turned into newlines so the
// summarizer sees paragraph structure instead of one run-on wall of text.
const BLOCK_BREAKS = /<\/(p|div|li|h[1-6]|section|article|header|figcaption|blockquote|tr)\s*>/gi;

/**
 * Best-effort readable-text extraction from an HTML page. Dependency-free
 * (zero-runtime-deps rule): regex-based, mirrors the RSS parser's approach.
 * Prefers the <article>/<main> region when present, else falls back to <body>.
 */
export function extractReadableText(html: string, maxLen = MAX_ARTICLE_TEXT_LENGTH): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, ' ');
  for (const tag of NOISE_BLOCKS) {
    s = s.replace(new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, 'gi'), ' ');
  }

  const region = firstRegion(s, 'article') || firstRegion(s, 'main') || firstRegion(s, 'body') || s;

  const text = decodeEntities(
    region
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(BLOCK_BREAKS, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text.slice(0, maxLen);
}

// Inner HTML of the first <tag ...>...</tag> block, or null. Handles attributes
// on the open tag; not nesting-aware (news pages don't nest these regions).
function firstRegion(html: string, tag: string): string | null {
  const open = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'i').exec(html);
  if (!open) return null;
  const start = open.index + open[0].length;
  const close = html.toLowerCase().indexOf(`</${tag}>`, start);
  if (close === -1) return null;
  return html.slice(start, close);
}

/**
 * Fetch a URL and return its readable article text, or null on any failure
 * (network error, timeout, non-OK, non-HTML response). Callers fall back to the
 * RSS teaser when this returns null.
 */
export async function fetchArticleText(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'negent/1.0 (article reader)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;

    const html = await resp.text();
    const text = extractReadableText(html);
    return text.length ? text : null;
  } catch {
    return null;
  }
}
