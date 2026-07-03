import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendArticle, sendMessage } from './telegram';
import { Article } from '../types';

function makeArticle(overrides: Partial<Article> = {}): Article {
  return {
    id: 1,
    source_id: 1,
    url: 'https://example.com/article',
    url_hash: 'hash',
    title: 'Test Title',
    content_snippet: null,
    media_url: null,
    media_type: null,
    published_at: null,
    fetched_at: '2024-01-01',
    status: 'done',
    summary_fa: 'Summary text.',
    processed_at: null,
    error_message: null,
    retry_count: 0,
    delivered: 0,
    delivered_at: null,
    ...overrides,
  };
}

function okResponse(): Response {
  return { ok: true, status: 200 } as Response;
}

function parseBody(call: unknown): Record<string, unknown> {
  const [, init] = (call as [unknown, RequestInit]);
  return JSON.parse(init.body as string);
}

describe('sendArticle', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls sendPhoto when media_type is photo', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const article = makeArticle({
      media_url: 'https://img.example.com/p.jpg',
      media_type: 'photo',
    });
    await sendArticle(1, article, 'TechCrunch', 'TOKEN');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/sendPhoto');
    const body = parseBody(fetchMock.mock.calls[0]);
    expect(body.photo).toBe('https://img.example.com/p.jpg');
    expect(body.parse_mode).toBe('HTML');
  });

  it('calls sendVideo when media_type is video', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const article = makeArticle({
      media_url: 'https://cdn.example.com/v.mp4',
      media_type: 'video',
    });
    await sendArticle(1, article, 'TechCrunch', 'TOKEN');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/sendVideo');
  });

  it('calls sendMessage when no media', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const article = makeArticle();
    await sendArticle(1, article, 'TechCrunch', 'TOKEN');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/sendMessage');
  });

  it('includes title as HTML-escaped bold in caption', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const article = makeArticle({
      title: 'A <b> & B',
      media_url: 'https://img.example.com/p.jpg',
      media_type: 'photo',
    });
    await sendArticle(1, article, 'S', 'TOKEN');
    const body = parseBody(fetchMock.mock.calls[0]);
    expect(body.caption).toContain('<b>A &lt;b&gt; &amp; B</b>');
  });

  it('includes source link footer in caption', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const article = makeArticle({
      url: 'https://example.com/x',
      media_url: 'https://img.example.com/p.jpg',
      media_type: 'photo',
    });
    await sendArticle(1, article, 'TechCrunch', 'TOKEN');
    const body = parseBody(fetchMock.mock.calls[0]);
    expect(body.caption).toContain('🔗 <a href="https://example.com/x">منبع</a> | 📡 TechCrunch');
  });

  it('escapes HTML in source name', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const article = makeArticle({ media_url: 'https://i.jpg', media_type: 'photo' });
    await sendArticle(1, article, '<Bad>', 'TOKEN');
    const body = parseBody(fetchMock.mock.calls[0]);
    expect(body.caption).toContain('📡 &lt;Bad&gt;');
  });

  it('falls back to sendMessage when sendPhoto fails with wrong file identifier', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ description: 'Bad Request: wrong file identifier' }),
      } as Response)
      .mockResolvedValueOnce(okResponse());
    const article = makeArticle({
      media_url: 'https://i.jpg',
      media_type: 'photo',
    });
    const ok = await sendArticle(1, article, 'S', 'TOKEN');
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('/sendPhoto');
    expect(fetchMock.mock.calls[1][0]).toContain('/sendMessage');
  });

  it('falls back to sendMessage when sendPhoto fails with HTTP URL error', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ description: 'failed to get HTTP URL content' }),
      } as Response)
      .mockResolvedValueOnce(okResponse());
    const article = makeArticle({
      media_url: 'https://i.jpg',
      media_type: 'photo',
    });
    await sendArticle(1, article, 'S', 'TOKEN');
    expect(fetchMock.mock.calls[1][0]).toContain('/sendMessage');
  });

  it('falls back to sendMessage when sendVideo fails', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ description: 'other' }),
      } as Response)
      .mockResolvedValueOnce(okResponse());
    const article = makeArticle({
      media_url: 'https://v.mp4',
      media_type: 'video',
    });
    await sendArticle(1, article, 'S', 'TOKEN');
    expect(fetchMock.mock.calls[1][0]).toContain('/sendMessage');
  });

  it('includes media link in fallback sendMessage body', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ description: 'wrong file identifier' }),
      } as Response)
      .mockResolvedValueOnce(okResponse());
    const article = makeArticle({
      media_url: 'https://i.jpg',
      media_type: 'photo',
    });
    await sendArticle(1, article, 'S', 'TOKEN');
    const fallbackBody = parseBody(fetchMock.mock.calls[1]);
    expect(fallbackBody.text).toContain('🖼 <a href="https://i.jpg">تصویر</a>');
  });

  it('truncates summary to fit caption length budget', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const longSummary = 'x'.repeat(2000);
    const article = makeArticle({
      media_url: 'https://i.jpg',
      media_type: 'photo',
      summary_fa: longSummary,
    });
    await sendArticle(1, article, 'S', 'TOKEN');
    const body = parseBody(fetchMock.mock.calls[0]);
    expect((body.caption as string).length).toBeLessThanOrEqual(1020);
  });

  it('truncates summary to fit message length budget on fallback', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ description: 'wrong file identifier' }),
      } as Response)
      .mockResolvedValueOnce(okResponse());
    const longSummary = 'x'.repeat(5000);
    const article = makeArticle({
      media_url: 'https://i.jpg',
      media_type: 'photo',
      summary_fa: longSummary,
    });
    await sendArticle(1, article, 'S', 'TOKEN');
    const body = parseBody(fetchMock.mock.calls[1]);
    expect((body.text as string).length).toBeLessThanOrEqual(4090);
  });

  it('throws BLOCKED on 403', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 } as Response);
    const article = makeArticle();
    await expect(sendArticle(1, article, 'S', 'TOKEN')).rejects.toThrow('BLOCKED');
  });

  it('throws RATE_LIMITED on 429', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 } as Response);
    const article = makeArticle();
    await expect(sendArticle(1, article, 'S', 'TOKEN')).rejects.toThrow(
      'RATE_LIMITED'
    );
  });
});

describe('sendMessage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true on ok', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const ok = await sendMessage(1, 'hello', 'TOKEN');
    expect(ok).toBe(true);
    const body = parseBody(fetchMock.mock.calls[0]);
    expect(body.text).toBe('hello');
    expect(body.parse_mode).toBe('HTML');
  });

  it('returns false on non-429/403 error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400 } as Response);
    const ok = await sendMessage(1, 'hello', 'TOKEN');
    expect(ok).toBe(false);
  });

  it('throws BLOCKED on 403', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 } as Response);
    await expect(sendMessage(1, 'x', 'TOKEN')).rejects.toThrow('BLOCKED');
  });

  it('throws RATE_LIMITED on 429', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 } as Response);
    await expect(sendMessage(1, 'x', 'TOKEN')).rejects.toThrow('RATE_LIMITED');
  });
});
