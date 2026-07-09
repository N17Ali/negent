import { FeedItem } from '../types';
import { MAX_CONTENT_LENGTH } from '../utils/constants';
import { extractMedia } from './media';

// We only keep MAX_CONTENT_LENGTH chars of the snippet, but full-content feeds
// (content:encoded / Atom <content>) embed the whole article HTML — tens of KB per item.
// decodeEntities + stripHtml run ~8 regex passes each, so decoding every item's full body
// before slicing burns CPU proportional to total feed size and can trip the Worker's CPU
// limit on big feeds. Slice the raw body to this bounded prefix FIRST; the extra headroom
// over MAX_CONTENT_LENGTH covers HTML tags/entities that get stripped away.
const RAW_CONTENT_LIMIT = MAX_CONTENT_LENGTH * 4;

export function parseFeed(xml: string): FeedItem[] {
  const isAtom = xml.includes('<feed') && xml.includes('http://www.w3.org/2005/Atom');
  return isAtom ? parseAtom(xml) : parseRss(xml);
}

function parseRss(xml: string): FeedItem[] {
  const items = extractTags(xml, 'item');
  return items.map((itemXml) => {
    const title = decodeEntities(firstTag(itemXml, 'title') || 'Untitled');
    const link = decodeEntities(firstTag(itemXml, 'link') || '');
    const raw = (
      firstTag(itemXml, 'content:encoded') ||
      firstTag(itemXml, 'description') ||
      ''
    ).slice(0, RAW_CONTENT_LIMIT);
    const description = stripHtml(decodeEntities(raw)).slice(0, MAX_CONTENT_LENGTH);
    const pubDate = firstTag(itemXml, 'pubDate') || firstTag(itemXml, 'dc:date') || null;
    const { mediaUrl, mediaType } = extractMedia(itemXml);
    return { title, link, description, pubDate, mediaUrl, mediaType };
  });
}

function parseAtom(xml: string): FeedItem[] {
  const entries = extractTags(xml, 'entry');
  return entries.map((entryXml) => {
    const title = decodeEntities(firstTag(entryXml, 'title') || 'Untitled');
    const linkMatch = entryXml.match(/<link[^>]+href=["']([^"']+)["'][^>]*\/?>/);
    const link = linkMatch ? decodeEntities(linkMatch[1]) : '';
    const raw = (firstTag(entryXml, 'content') || firstTag(entryXml, 'summary') || '').slice(
      0,
      RAW_CONTENT_LIMIT
    );
    const description = stripHtml(decodeEntities(raw)).slice(0, MAX_CONTENT_LENGTH);
    const pubDate = firstTag(entryXml, 'published') || firstTag(entryXml, 'updated') || null;
    const { mediaUrl, mediaType } = extractMedia(entryXml);
    return { title, link, description, pubDate, mediaUrl, mediaType };
  });
}

export function extractTags(xml: string, tagName: string): string[] {
  const results: string[] = [];
  let pos = 0;
  const open = `<${tagName}`;
  const close = `</${tagName}>`;

  while (true) {
    const start = xml.indexOf(open, pos);
    if (start === -1) break;

    const tagEnd = xml.indexOf('>', start + open.length);
    if (tagEnd === -1) break;

    if (xml[tagEnd - 1] === '/') {
      pos = tagEnd + 1;
      continue;
    }

    const contentStart = tagEnd + 1;
    const end = xml.indexOf(close, contentStart);
    if (end === -1) break;

    results.push(xml.slice(contentStart, end));
    pos = end + close.length;
  }

  return results;
}

function firstTag(xml: string, tagName: string): string | null {
  const results = extractTags(xml, tagName);
  return results.length > 0 ? results[0] : null;
}

export function decodeEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const strip = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref', 'source'];
    strip.forEach((p) => url.searchParams.delete(p));
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.hash = '';
    return url.toString().toLowerCase();
  } catch {
    return rawUrl.toLowerCase().trim();
  }
}

export function parsePubDate(raw: string | null): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw.trim());
  return Number.isNaN(ms) ? null : ms;
}

export async function computeUrlHash(url: string): Promise<string> {
  const normalized = normalizeUrl(url);
  const encoded = new TextEncoder().encode(normalized);
  const buf = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
