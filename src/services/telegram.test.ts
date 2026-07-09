import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendArticle, sendMessage, sendAudio } from './telegram';
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
    full_fa: 'Full translation text.',
    category: 'ai',
    relevance_score: 4,
    processed_at: null,
    error_message: null,
    retry_count: 0,
    delivered: 0,
    delivered_at: null,
    ...overrides,
  };
}

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ result: { message_id: 123 } }),
  } as unknown as Response;
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
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('/sendPhoto');
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

  it('does not include English title in message', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const article = makeArticle({ title: 'Some English Title' });
    await sendArticle(1, article, 'S', 'TOKEN');
    const body = parseBody(fetchMock.mock.calls[0]);
    expect(body.text as string).not.toContain('Some English Title');
  });

  it('includes category icon at start', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const article = makeArticle({ category: 'ai' });
    await sendArticle(1, article, 'S', 'TOKEN');
    const body = parseBody(fetchMock.mock.calls[0]);
    expect(body.text as string).toMatch(/^🤖/);
  });

  it('includes source link footer', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const article = makeArticle({ url: 'https://example.com/x' });
    await sendArticle(1, article, 'TechCrunch', 'TOKEN');
    const body = parseBody(fetchMock.mock.calls[0]);
    expect(body.text).toContain('🔗 <a href="https://example.com/x">منبع</a> | 📡 TechCrunch');
  });

  it('escapes HTML in source name', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const article = makeArticle({ media_url: 'https://i.jpg', media_type: 'photo' });
    await sendArticle(1, article, '<Bad>', 'TOKEN');
    const body = parseBody(fetchMock.mock.calls[0]);
    expect(body.caption).toContain('📡 &lt;Bad&gt;');
  });

  it('includes RLM mark for RTL formatting', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const article = makeArticle({ summary_fa: 'متن فارسی' });
    await sendArticle(1, article, 'S', 'TOKEN');
    const body = parseBody(fetchMock.mock.calls[0]);
    expect(body.text).toContain('\u200F');
  });

  it('converts quote lines to blockquote', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const article = makeArticle({
      summary_fa: 'متن اول\n\n> این یک نقل قول است\n\nمتن سوم',
    });
    await sendArticle(1, article, 'S', 'TOKEN');
    const body = parseBody(fetchMock.mock.calls[0]);
    expect(body.text).toContain('<blockquote>');
    expect(body.text).toContain('این یک نقل قول است');
  });

  it('falls back to sendMessage when sendPhoto fails', async () => {
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
    const id = await sendArticle(1, article, 'S', 'TOKEN');
    expect(id).toBe(123);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws BLOCKED on 403', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 } as Response);
    const article = makeArticle();
    await expect(sendArticle(1, article, 'S', 'TOKEN')).rejects.toThrow('BLOCKED');
  });

  it('throws RATE_LIMITED on 429', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 } as Response);
    const article = makeArticle();
    await expect(sendArticle(1, article, 'S', 'TOKEN')).rejects.toThrow('RATE_LIMITED');
  });

  it('sends a long summary as a full message, not a truncated caption', async () => {
    // Long summary + photo: must not be crammed into the ~1020-char caption (which
    // caused the mid-paragraph cut). Media goes out with a short caption, then the
    // full summary as its own sendMessage.
    const para = 'این یک جمله کامل فارسی است که باید تا انتها بیاید. ';
    const longSummary = para.repeat(30); // ~1500 chars
    fetchMock.mockResolvedValue(okResponse());
    const article = makeArticle({
      summary_fa: longSummary,
      media_url: 'https://img.example.com/p.jpg',
      media_type: 'photo',
    });
    await sendArticle(1, article, 'S', 'TOKEN');

    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes('/sendPhoto'))).toBe(true);
    const msgCall = fetchMock.mock.calls.find((c) => (c[0] as string).includes('/sendMessage'));
    expect(msgCall).toBeDefined();
    const text = parseBody(msgCall).text as string;
    // The full summary shipped, and it ends on a sentence boundary — never mid-word.
    expect(text.length).toBeGreaterThan(1020);
    expect(text).toContain('منبع');
  });

  it('does not cut a summary mid-sentence when truncating', async () => {
    // Force truncation by exceeding the 4096 message limit; the text before the footer
    // must end at a sentence boundary (clean '.' or '.' + ellipsis), not a mid-word slice.
    const sentence = 'این جمله کامل است. ';
    const article = makeArticle({ summary_fa: sentence.repeat(300) }); // way over 4096
    fetchMock.mockResolvedValue(okResponse());
    await sendArticle(1, article, 'S', 'TOKEN');
    const text = parseBody(fetchMock.mock.calls[0]).text as string;
    expect(text.length).toBeLessThanOrEqual(4090);
    const beforeFooter = text.split('🔗')[0].trimEnd();
    expect(beforeFooter.endsWith('.') || beforeFooter.endsWith('...')).toBe(true);
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

  it('returns the message_id on ok', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const id = await sendMessage(1, 'hello', 'TOKEN');
    expect(id).toBe(123);
  });

  it('returns null on non-429/403 error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400 } as Response);
    const id = await sendMessage(1, 'hello', 'TOKEN');
    expect(id).toBeNull();
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

describe('sendAudio', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46]);

  it('tags performer as negent and names the file from the title', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    await sendAudio(1, wav, 'My Cool Article', 'TOKEN');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/sendAudio');
    const form = (init as { body: FormData }).body;
    expect(form.get('performer')).toBe('negent');
    expect(form.get('title')).toBe('My Cool Article');
    const file = form.get('audio') as unknown as File;
    expect(file.name).toBe('My Cool Article.wav');
  });

  it('sanitizes path characters out of the filename', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    await sendAudio(1, wav, 'a/b\\c: d', 'TOKEN');
    const file = (fetchMock.mock.calls[0][1] as { body: FormData }).body.get('audio') as unknown as File;
    expect(file.name).toBe('a b c d.wav');
  });
});
