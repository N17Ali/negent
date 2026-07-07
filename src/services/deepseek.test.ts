import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { selectTopArticles } from './deepseek';

const OK_RESPONSE = (content: string) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
    }),
  }) as unknown as Response;

const ERR_RESPONSE = (status: number, message: string) =>
  ({
    ok: false,
    status,
    json: async () => ({ error: { message } }),
  }) as unknown as Response;

const VALID_SELECTION = JSON.stringify({
  selected: [
    { id: 1, reason: 'major game release' },
    { id: 3, reason: 'new AI model launch' },
  ],
});

const FENCED_SELECTION = '```json\n' + VALID_SELECTION + '\n```';

describe('selectTopArticles', () => {
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

  it('returns selected articles with ids and reasons', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE(VALID_SELECTION));
    const candidates = [
      { id: 1, title: 'GTA 6 delayed', snippet: 'Rockstar announced', source: 'IGN' },
      { id: 2, title: 'Pride week in games', snippet: 'opinion piece', source: 'Eurogamer' },
      { id: 3, title: 'GPT-5 launched', snippet: 'OpenAI announcement', source: 'TechCrunch' },
    ];
    const result = await selectTopArticles(candidates, [], 'NVIDIA_KEY');
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(1);
    expect(result[0].reason).toBe('major game release');
    expect(result[1].id).toBe(3);
  });

  it('strips markdown code fences from response', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE(FENCED_SELECTION));
    const result = await selectTopArticles(
      [{ id: 1, title: 'T', snippet: '', source: 'S' }],
      [],
      'KEY'
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });

  it('sends prompt with article list to NVIDIA API', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE(VALID_SELECTION));
    const candidates = [{ id: 1, title: 'GTA 6', snippet: 'delayed', source: 'IGN' }];
    await selectTopArticles(candidates, [], 'KEY');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('deepseek-ai/deepseek-v4-pro');
    expect(body.messages[0].content).toContain('GTA 6');
    expect(body.chat_template_kwargs).toEqual({ thinking: false });
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(1);
    expect(body.top_p).toBe(0.95);
  });

  it('includes API key as Bearer token', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE(VALID_SELECTION));
    const candidates = [{ id: 1, title: 'Test', snippet: '', source: 'S' }];
    await selectTopArticles(candidates, [], 'SECRET_NVIDIA_KEY');
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer SECRET_NVIDIA_KEY');
  });

  it('includes recent delivered titles in prompt for dedup', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE(VALID_SELECTION));
    const candidates = [{ id: 1, title: 'Test', snippet: '', source: 'S' }];
    await selectTopArticles(candidates, ['GTA 6 trailer revealed'], 'KEY');
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.messages[0].content).toContain('Already delivered');
    expect(body.messages[0].content).toContain('GTA 6 trailer revealed');
  });

  it('filters out selected ids not in candidates', async () => {
    fetchMock.mockResolvedValueOnce(
      OK_RESPONSE(
        JSON.stringify({
          selected: [
            { id: 1, reason: 'valid' },
            { id: 999, reason: 'invalid id not in candidates' },
          ],
        })
      )
    );
    const candidates = [
      { id: 1, title: 'Valid', snippet: '', source: 'S' },
      { id: 2, title: 'Other', snippet: '', source: 'S' },
    ];
    const result = await selectTopArticles(candidates, [], 'KEY');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });

  it('retries on 524 and succeeds on second attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(ERR_RESPONSE(524, 'timeout'))
      .mockResolvedValueOnce(OK_RESPONSE(VALID_SELECTION));
    const promise = selectTopArticles(
      [
        { id: 1, title: 'T1', snippet: '', source: 'S' },
        { id: 2, title: 'T2', snippet: '', source: 'S' },
        { id: 3, title: 'T3', snippet: '', source: 'S' },
      ],
      [],
      'KEY'
    );
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
  });

  it('retries on 503 and succeeds on second attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(ERR_RESPONSE(503, 'service unavailable'))
      .mockResolvedValueOnce(OK_RESPONSE(VALID_SELECTION));
    const promise = selectTopArticles(
      [{ id: 1, title: 'T', snippet: '', source: 'S' }],
      [],
      'KEY'
    );
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws after max retries on 524', async () => {
    fetchMock.mockResolvedValue(ERR_RESPONSE(524, 'timeout'));
    const promise = selectTopArticles(
      [{ id: 1, title: 'T', snippet: '', source: 'S' }],
      [],
      'KEY'
    );
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(8000);
    await expect(promise).rejects.toThrow('DeepSeek API error 524: timeout');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws on non-retryable error immediately (500)', async () => {
    fetchMock.mockResolvedValueOnce(ERR_RESPONSE(500, 'server error'));
    await expect(
      selectTopArticles([{ id: 1, title: 'T', snippet: '', source: 'S' }], [], 'KEY')
    ).rejects.toThrow('DeepSeek API error 500: server error');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws on empty response', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE(''));
    await expect(
      selectTopArticles([{ id: 1, title: 'T', snippet: '', source: 'S' }], [], 'KEY')
    ).rejects.toThrow('Empty DeepSeek response');
  });

  it('throws when selected array is missing', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE(JSON.stringify({ wrong_key: [] })));
    await expect(
      selectTopArticles([{ id: 1, title: 'T', snippet: '', source: 'S' }], [], 'KEY')
    ).rejects.toThrow('No selected array in DeepSeek response');
  });

  it('limits to SELECT_TOP_N even if more returned', async () => {
    fetchMock.mockResolvedValueOnce(
      OK_RESPONSE(
        JSON.stringify({
          selected: Array.from({ length: 15 }, (_, i) => ({ id: i + 1, reason: 'test' })),
        })
      )
    );
    const candidates = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      title: `Article ${i + 1}`,
      snippet: '',
      source: 'S',
    }));
    const result = await selectTopArticles(candidates, [], 'KEY');
    expect(result.length).toBeLessThanOrEqual(10);
  });
});
