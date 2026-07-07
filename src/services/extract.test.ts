import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractReadableText, fetchArticleText } from './extract';

const HTML_RESPONSE = (body: string) =>
  ({
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    text: async () => body,
  }) as unknown as Response;

describe('extractReadableText', () => {
  it('prefers the <article> region over surrounding chrome', () => {
    const html = `<html><body>
      <nav>Home About Contact</nav>
      <article><p>The real story is here.</p></article>
      <footer>Copyright 2026</footer>
    </body></html>`;
    const text = extractReadableText(html);
    expect(text).toContain('The real story is here.');
    expect(text).not.toContain('Copyright');
    expect(text).not.toContain('Home About');
  });

  it('falls back to <main>, then <body>', () => {
    const mainHtml = `<body><main><p>Main content</p></main></body>`;
    expect(extractReadableText(mainHtml)).toBe('Main content');
    const bodyHtml = `<body><p>Body content</p></body>`;
    expect(extractReadableText(bodyHtml)).toBe('Body content');
  });

  it('drops script and style blocks', () => {
    const html = `<article>
      <script>var x = 1; alert('hi');</script>
      <style>.a { color: red; }</style>
      <p>Visible text</p>
    </article>`;
    const text = extractReadableText(html);
    expect(text).toContain('Visible text');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color: red');
  });

  it('preserves paragraph breaks from block tags', () => {
    const html = `<article><p>First para.</p><p>Second para.</p></article>`;
    expect(extractReadableText(html)).toBe('First para.\nSecond para.');
  });

  it('decodes HTML entities', () => {
    const html = `<article><p>Sales &amp; records hit 30&#37; growth</p></article>`;
    expect(extractReadableText(html)).toBe('Sales & records hit 30% growth');
  });

  it('collapses whitespace runs', () => {
    const html = `<article><p>Too    many\t\tspaces</p></article>`;
    expect(extractReadableText(html)).toBe('Too many spaces');
  });

  it('truncates to the max length', () => {
    const body = '<p>' + 'a'.repeat(20000) + '</p>';
    const text = extractReadableText(`<article>${body}</article>`, 500);
    expect(text.length).toBe(500);
  });

  it('returns empty string for tag-only / empty html', () => {
    expect(extractReadableText('<html><body></body></html>')).toBe('');
  });
});

describe('fetchArticleText', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns extracted text for an OK HTML response', async () => {
    fetchMock.mockResolvedValueOnce(
      HTML_RESPONSE('<html><body><article><p>Full story body.</p></article></body></html>')
    );
    const text = await fetchArticleText('https://example.com/post');
    expect(text).toBe('Full story body.');
  });

  it('sends a User-Agent and an abort signal', async () => {
    fetchMock.mockResolvedValueOnce(HTML_RESPONSE('<article><p>x</p></article>'));
    await fetchArticleText('https://example.com/post');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.com/post');
    expect(init.headers['User-Agent']).toContain('negent');
    expect(init.signal).toBeDefined();
  });

  it('returns null on non-OK status', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      headers: { get: () => 'text/html' },
      text: async () => '<article>x</article>',
    } as unknown as Response);
    expect(await fetchArticleText('https://example.com/missing')).toBeNull();
  });

  it('returns null for non-HTML content types (e.g. PDF)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'application/pdf' },
      text: async () => '%PDF-1.4 ...',
    } as unknown as Response);
    expect(await fetchArticleText('https://example.com/file.pdf')).toBeNull();
  });

  it('returns null when the page has no readable text', async () => {
    fetchMock.mockResolvedValueOnce(HTML_RESPONSE('<html><body></body></html>'));
    expect(await fetchArticleText('https://example.com/empty')).toBeNull();
  });

  it('returns null when fetch throws (network error / timeout)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    expect(await fetchArticleText('https://example.com/post')).toBeNull();
  });
});
