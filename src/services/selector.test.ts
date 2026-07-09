import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { selectTopArticles } from './selector';
import { GEMINI_MODEL, GEMMA_MODEL } from '../utils/constants';

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
    const { selected } = await selectTopArticles(candidates, [], 'KEY');
    expect(selected).toHaveLength(2);
    expect(selected[0].id).toBe(1);
    expect(selected[0].reason).toBe('major game release');
    expect(selected[1].id).toBe(3);
  });

  it('returns important runner-ups in the bucket, excluding selected and invalid ids', async () => {
    fetchMock.mockResolvedValueOnce(
      OK_RESPONSE(
        JSON.stringify({
          selected: [{ id: 1, reason: 'top story' }],
          bucket: [2, 1, 999], // 1 is already selected, 999 isn't a candidate
        })
      )
    );
    const candidates = [
      { id: 1, title: 'A', snippet: '', source: 'S' },
      { id: 2, title: 'B', snippet: '', source: 'S' },
      { id: 3, title: 'C', snippet: '', source: 'S' },
    ];
    const { selected, bucket } = await selectTopArticles(candidates, [], 'KEY');
    expect(selected.map((s) => s.id)).toEqual([1]);
    expect(bucket).toEqual([2]);
  });

  it('returns an empty bucket when the model omits it', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE(VALID_SELECTION));
    const { bucket } = await selectTopArticles(
      [{ id: 1, title: 'T', snippet: '', source: 'S' }],
      [],
      'KEY'
    );
    expect(bucket).toEqual([]);
  });

  it('strips markdown code fences from response', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE(FENCED_SELECTION));
    const { selected } = await selectTopArticles(
      [{ id: 1, title: 'T', snippet: '', source: 'S' }],
      [],
      'KEY'
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe(1);
  });

  it('sends prompt with article list to the primary Gemini model', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE(VALID_SELECTION));
    const candidates = [{ id: 1, title: 'GTA 6', snippet: 'delayed', source: 'IGN' }];
    await selectTopArticles(candidates, [], 'KEY');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`/models/${GEMINI_MODEL}:generateContent`);
    expect(url).toContain('key=KEY');
    const body = JSON.parse(init.body);
    expect(body.contents[0].parts[0].text).toContain('GTA 6');
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.temperature).toBe(1);
  });

  it('includes recent delivered titles in prompt for dedup', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE(VALID_SELECTION));
    const candidates = [{ id: 1, title: 'Test', snippet: '', source: 'S' }];
    await selectTopArticles(candidates, ['GTA 6 trailer revealed'], 'KEY');
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.contents[0].parts[0].text).toContain('Already delivered');
    expect(body.contents[0].parts[0].text).toContain('GTA 6 trailer revealed');
  });

  it('falls back to gemma model when primary is rate-limited', async () => {
    fetchMock
      .mockResolvedValueOnce(ERR_RESPONSE(429, 'quota exceeded'))
      .mockResolvedValueOnce(ERR_RESPONSE(429, 'quota exceeded'))
      .mockResolvedValueOnce(ERR_RESPONSE(429, 'quota exceeded'))
      .mockResolvedValueOnce(OK_RESPONSE(VALID_SELECTION));
    const promise = selectTopArticles(
      [
        { id: 1, title: 'T1', snippet: '', source: 'S' },
        { id: 3, title: 'T3', snippet: '', source: 'S' },
      ],
      [],
      'KEY'
    );
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(8000);
    const { selected } = await promise;
    // 3 attempts on primary (all 429) then fallback succeeds on first gemma try
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0][0]).toContain(GEMINI_MODEL);
    expect(fetchMock.mock.calls[3][0]).toContain(GEMMA_MODEL);
    expect(selected).toHaveLength(2);
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
    const { selected } = await selectTopArticles(candidates, [], 'KEY');
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe(1);
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
    await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws on non-retryable error immediately (500)', async () => {
    fetchMock.mockResolvedValueOnce(ERR_RESPONSE(500, 'server error'));
    await expect(
      selectTopArticles([{ id: 1, title: 'T', snippet: '', source: 'S' }], [], 'KEY')
    ).rejects.toThrow('Selector API error 500: server error');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws on empty response', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE(''));
    await expect(
      selectTopArticles([{ id: 1, title: 'T', snippet: '', source: 'S' }], [], 'KEY')
    ).rejects.toThrow('Empty selector response');
  });

  it('throws when selected array is missing', async () => {
    fetchMock.mockResolvedValueOnce(OK_RESPONSE(JSON.stringify({ wrong_key: [] })));
    await expect(
      selectTopArticles([{ id: 1, title: 'T', snippet: '', source: 'S' }], [], 'KEY')
    ).rejects.toThrow('No selected array in selector response');
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
    const { selected } = await selectTopArticles(candidates, [], 'KEY');
    expect(selected.length).toBeLessThanOrEqual(10);
  });
});
