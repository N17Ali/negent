import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { summarizeAndTranslate } from './summarize';

const OK_RESPONSE = (text: string) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
    }),
  }) as unknown as Response;

const ERR_RESPONSE = (status: number, message: string) =>
  ({
    ok: false,
    status,
    json: async () => ({ error: { message } }),
  }) as unknown as Response;

const VALID_RESULT = JSON.stringify({
  summary: 'خلاصه تست',
  full_fa: 'ترجمه کامل تست',
  category: 'ai',
  relevance_score: 4,
});

describe('summarizeAndTranslate', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns summary, category, and relevance_score from Gemini JSON', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE(VALID_RESULT));
    const out = await summarizeAndTranslate('T', 'C', 'Source', 'KEY');
    expect(out.summary).toBe('خلاصه تست');
    expect(out.full_fa).toBe('ترجمه کامل تست');
    expect(out.category).toBe('ai');
    expect(out.relevance_score).toBe(4);
  });

  it('falls back to the summary when full_fa is absent', async () => {
    fetchMock.mockResolvedValueOnce(
      OK_RESPONSE(JSON.stringify({ summary: 'خلاصه', category: 'ai', relevance_score: 3 }))
    );
    const out = await summarizeAndTranslate('T', 'C', 'S', 'K');
    expect(out.full_fa).toBe('خلاصه');
  });

  it('asks the model for a length-capped Persian reading', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE(VALID_RESULT));
    await summarizeAndTranslate('T', 'C', 'S', 'K');
    const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).contents[0].parts[0].text;
    expect(prompt).toContain('full_fa');
    // full_fa is read aloud and capped; the prompt must state a character limit and require
    // finishing sentences.
    expect(prompt).toContain('this is what gets read aloud');
    expect(prompt).toMatch(/UNDER \d+ characters/);
    expect(prompt).toContain('finish the final sentence');
  });

  it('sends prompt with title, content, and source in request body', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE(VALID_RESULT));
    await summarizeAndTranslate('MyTitle', 'MyContent', 'MySource', 'KEY');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.contents[0].parts[0].text).toContain('MyTitle');
    expect(body.contents[0].parts[0].text).toContain('MyContent');
    expect(body.contents[0].parts[0].text).toContain('MySource');
    expect(body.generationConfig.temperature).toBe(0.3);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
  });

  it('includes API key in URL', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE(VALID_RESULT));
    await summarizeAndTranslate('T', 'C', 'S', 'SECRET_KEY');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('key=SECRET_KEY');
  });

  it('asks for a bounded 2-4 paragraph, finished summary', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE(VALID_RESULT));
    await summarizeAndTranslate('T', 'C', 'S', 'K');
    const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).contents[0].parts[0].text;
    expect(prompt).toContain('2-4 paragraphs');
    expect(prompt).toContain('ALWAYS finish the final paragraph');
  });

  it('instructs the model to preserve concrete facts', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE(VALID_RESULT));
    await summarizeAndTranslate('T', 'C', 'S', 'K');
    const prompt = JSON.parse(fetchMock.mock.calls[0][1].body).contents[0].parts[0].text;
    expect(prompt).toContain('Preserve every concrete fact');
  });

  it('allows enough output tokens to avoid mid-output truncation', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE(VALID_RESULT));
    await summarizeAndTranslate('T', 'C', 'S', 'K');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.generationConfig.maxOutputTokens).toBe(8192);
  });

  it('retries on 503 and succeeds on second attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(ERR_RESPONSE(503, 'high demand'))
      .mockResolvedValueOnce(OK_RESPONSE(VALID_RESULT));
    const promise = summarizeAndTranslate('T', 'C', 'S', 'K');
    await vi.advanceTimersByTimeAsync(2000);
    const out = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.summary).toBe('خلاصه تست');
  });

  it('retries on 429 and succeeds on third attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(ERR_RESPONSE(429, 'quota exceeded'))
      .mockResolvedValueOnce(ERR_RESPONSE(429, 'quota exceeded'))
      .mockResolvedValueOnce(OK_RESPONSE(VALID_RESULT));
    const promise = summarizeAndTranslate('T', 'C', 'S', 'K');
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(5000);
    const out = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(out.summary).toBe('خلاصه تست');
  });

  it('throws RATE_LIMITED after max retries on 429 (primary), then falls back to Gemma', async () => {
    fetchMock
      .mockResolvedValueOnce(ERR_RESPONSE(429, 'quota exceeded'))
      .mockResolvedValueOnce(ERR_RESPONSE(429, 'quota exceeded'))
      .mockResolvedValueOnce(ERR_RESPONSE(429, 'quota exceeded'))
      .mockResolvedValueOnce(OK_RESPONSE(VALID_RESULT));
    const promise = summarizeAndTranslate('T', 'C', 'S', 'K');
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(5000);
    const out = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(out.summary).toBe('خلاصه تست');
    const fallbackUrl = fetchMock.mock.calls[3][0];
    expect(fallbackUrl).toContain('gemma-4-31b-it');
  });

  it('throws on non-retryable error immediately (500)', async () => {
    fetchMock.mockResolvedValueOnce(ERR_RESPONSE(500, 'internal error'));
    await expect(summarizeAndTranslate('T', 'C', 'S', 'K')).rejects.toThrow(
      'Gemini API error 500: internal error'
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws on empty candidates', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE(''));
    await expect(summarizeAndTranslate('T', 'C', 'S', 'K')).rejects.toThrow(
      'Empty Gemini response'
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws when summary field is missing', async () => {
    fetchMock.mockResolvedValueOnce(
      OK_RESPONSE(JSON.stringify({ category: 'ai', relevance_score: 3 }))
    );
    await expect(summarizeAndTranslate('T', 'C', 'S', 'K')).rejects.toThrow(
      'No summary in Gemini response'
    );
  });

  it('throws when category field is missing', async () => {
    fetchMock.mockResolvedValueOnce(
      OK_RESPONSE(JSON.stringify({ summary: 's', relevance_score: 3 }))
    );
    await expect(summarizeAndTranslate('T', 'C', 'S', 'K')).rejects.toThrow(
      'No category in Gemini response'
    );
  });

  it('throws when relevance_score field is missing', async () => {
    fetchMock.mockResolvedValueOnce(
      OK_RESPONSE(JSON.stringify({ summary: 's', category: 'ai' }))
    );
    await expect(summarizeAndTranslate('T', 'C', 'S', 'K')).rejects.toThrow(
      'No relevance_score in Gemini response'
    );
  });

  it('throws on malformed JSON text', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE('not json'));
    await expect(summarizeAndTranslate('T', 'C', 'S', 'K')).rejects.toThrow();
  });
});
