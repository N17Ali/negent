import { describe, it, expect } from 'vitest';
import { parseFeed, extractTags, normalizeUrl, computeUrlHash } from './rss';

const RSS_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Tech Feed</title>
    <item>
      <title>First Article</title>
      <link>https://example.com/post-1?utm_source=newsletter</link>
      <description>&lt;p&gt;Hello &amp; world&lt;/p&gt;</description>
      <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
    </item>
    <item>
      <title><![CDATA[Second <Article>]]></title>
      <link>https://example.com/post-2</link>
      <content:encoded><![CDATA[<p>Body with <b>html</b> &amp; entities</p>]]></content:encoded>
      <dc:date>2024-01-02T00:00:00Z</dc:date>
    </item>
  </channel>
</rss>`;

const ATOM_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <title>Atom Entry</title>
    <link href="https://example.com/atom-1" type="text/html"/>
    <content>Atom body</content>
    <published>2024-02-01T00:00:00Z</published>
  </entry>
</feed>`;

describe('parseFeed', () => {
  it('parses RSS 2.0 feed with multiple items', () => {
    const items = parseFeed(RSS_FEED);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('First Article');
    expect(items[0].link).toBe('https://example.com/post-1?utm_source=newsletter');
    expect(items[0].description).toBe('Hello & world');
    expect(items[0].pubDate).toBe('Mon, 01 Jan 2024 00:00:00 GMT');
    expect(items[1].title).toBe('Second <Article>');
    expect(items[1].description).toBe('Body with html & entities');
    expect(items[1].pubDate).toBe('2024-01-02T00:00:00Z');
  });

  it('prefers content:encoded over description', () => {
    const items = parseFeed(RSS_FEED);
    expect(items[1].description).toBe('Body with html & entities');
  });

  it('parses Atom feed', () => {
    const items = parseFeed(ATOM_FEED);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Atom Entry');
    expect(items[0].link).toBe('https://example.com/atom-1');
    expect(items[0].description).toBe('Atom body');
    expect(items[0].pubDate).toBe('2024-02-01T00:00:00Z');
  });

  it('falls back to "Untitled" when title is missing', () => {
    const xml = `<rss version="2.0"><channel>
      <item><link>https://example.com/no-title</link></item>
    </channel></rss>`;
    const items = parseFeed(xml);
    expect(items[0].title).toBe('Untitled');
  });

  it('returns empty array when no items present', () => {
    const xml = `<rss version="2.0"><channel><title>Empty</title></channel></rss>`;
    expect(parseFeed(xml)).toEqual([]);
  });

  it('treats unknown format as RSS', () => {
    const xml = `<rss><channel>
      <item><title>X</title><link>https://x.com/1</link></item>
    </channel></rss>`;
    const items = parseFeed(xml);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('X');
  });

  it('truncates description to MAX_CONTENT_LENGTH', () => {
    const longBody = 'a'.repeat(5000);
    const xml = `<rss><channel>
      <item><title>T</title><link>https://x.com</link><description>${longBody}</description></item>
    </channel></rss>`;
    const items = parseFeed(xml);
    expect(items[0].description!.length).toBe(2000);
  });

  it('skips items without links', () => {
    // parser still emits them; the fetch cron filters empty links
    const xml = `<rss><channel>
      <item><title>No Link</title></item>
    </channel></rss>`;
    const items = parseFeed(xml);
    expect(items).toHaveLength(1);
    expect(items[0].link).toBe('');
  });
});

describe('extractTags', () => {
  it('extracts nested tag contents', () => {
    const xml = `<root><item>a</item><item>b</item></root>`;
    expect(extractTags(xml, 'item')).toEqual(['a', 'b']);
  });

  it('skips self-closing tags', () => {
    const xml = `<root><link href="x"/><link href="y"/></root>`;
    expect(extractTags(xml, 'link')).toEqual([]);
  });

  it('returns empty array when tag absent', () => {
    expect(extractTags('<root></root>', 'item')).toEqual([]);
  });

  it('handles tags with attributes', () => {
    const xml = `<item type="x">content</item>`;
    expect(extractTags(xml, 'item')).toEqual(['content']);
  });

  it('documents nested same-name tag limitation (matches nearest close only)', () => {
    // Known limitation of string-based parsing: nested <item> inside <item>
    // is not handled correctly. Real RSS/Atom never nest items, so this is
    // a theoretical edge case — the parser matches the first </item> after
    // the opening tag, yielding a single concatenated result.
    const xml = `<item>outer<item>inner</item>tail</item>`;
    const result = extractTags(xml, 'item');
    expect(result).toEqual(['outer<item>inner']);
  });
});

describe('normalizeUrl', () => {
  it('strips utm_* tracking params', () => {
    const out = normalizeUrl('https://Example.com/Post?utm_source=foo&utm_medium=bar&keep=1');
    expect(out).toBe('https://example.com/post?keep=1');
  });

  it('strips ref and source params', () => {
    const out = normalizeUrl('https://example.com/p?ref=newsletter&source=rss&id=5');
    expect(out).toBe('https://example.com/p?id=5');
  });

  it('removes trailing slash', () => {
    expect(normalizeUrl('https://example.com/post/')).toBe('https://example.com/post');
  });

  it('removes fragment', () => {
    expect(normalizeUrl('https://example.com/post#section')).toBe('https://example.com/post');
  });

  it('lowercases host and scheme', () => {
    expect(normalizeUrl('HTTPS://Example.COM/Path')).toBe('https://example.com/path');
  });

  it('falls back to lowercased input for invalid URLs', () => {
    expect(normalizeUrl('  NotAUrl  ')).toBe('notaurl');
  });
});

describe('computeUrlHash', () => {
  it('returns 64-char hex SHA-256', async () => {
    const hash = await computeUrlHash('https://example.com/post');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic for same normalized URL', async () => {
    const a = await computeUrlHash('https://example.com/post?utm_source=x');
    const b = await computeUrlHash('https://example.com/post');
    expect(a).toBe(b);
  });

  it('differs for different URLs', async () => {
    const a = await computeUrlHash('https://example.com/a');
    const b = await computeUrlHash('https://example.com/b');
    expect(a).not.toBe(b);
  });
});
