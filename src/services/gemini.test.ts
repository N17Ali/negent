import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { summarizeAndTranslate } from './gemini';

const OK_RESPONSE = (text: string) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
    }),
  }) as unknown as Response;

describe('summarizeAndTranslate', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the summary field from Gemini JSON', async () => {
    fetchMock.mockResolvedValueOnce(
      OK_RESPONSE(JSON.stringify({ summary: 'خلاصه تست' }))
    );
    const out = await summarizeAndTranslate('T', 'C', 'Source', 'KEY');
    expect(out).toBe('خلاصه تست');
  });

  it('sends prompt with title, content, and source in request body', async () => {
    fetchMock.mockResolvedValueOnce(
      OK_RESPONSE(JSON.stringify({ summary: 's' }))
    );
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
    fetchMock.mockResolvedValueOnce(
      OK_RESPONSE(JSON.stringify({ summary: 's' }))
    );
    await summarizeAndTranslate('T', 'C', 'S', 'SECRET_KEY');
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('key=SECRET_KEY');
  });

  it('throws RATE_LIMITED on 429', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'quota exceeded' } }),
    } as Response);
    await expect(summarizeAndTranslate('T', 'C', 'S', 'K')).rejects.toThrow(
      'RATE_LIMITED: quota exceeded'
    );
  });

  it('throws on non-ok response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: 'internal error' } }),
    } as Response);
    await expect(summarizeAndTranslate('T', 'C', 'S', 'K')).rejects.toThrow(
      'Gemini API error 500: internal error'
    );
  });

  it('throws on empty candidates', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE(''));
    await expect(summarizeAndTranslate('T', 'C', 'S', 'K')).rejects.toThrow(
      'Empty Gemini response'
    );
  });

  it('throws when summary field is missing', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE(JSON.stringify({ other: 'x' })));
    await expect(summarizeAndTranslate('T', 'C', 'S', 'K')).rejects.toThrow(
      'No summary in Gemini response'
    );
  });

  it('throws on malformed JSON text', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE('not json'));
    await expect(summarizeAndTranslate('T', 'C', 'S', 'K')).rejects.toThrow();
  });
});
