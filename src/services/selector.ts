import { SELECT_TOP_N, GEMINI_MODEL, GEMMA_MODEL } from '../utils/constants';

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [3000, 8000];
const RETRYABLE_STATUS = new Set([429, 503]);

export interface ArticleCandidate {
  id: number;
  title: string;
  snippet: string;
  source: string;
}

export interface SelectedArticle {
  id: number;
  reason: string;
}

export async function selectTopArticles(
  candidates: ArticleCandidate[],
  recentTitles: string[],
  apiKey: string
): Promise<SelectedArticle[]> {
  try {
    return await callWithRetry(candidates, recentTitles, apiKey, GEMINI_MODEL);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('RATE_LIMITED')) {
      console.warn(
        `selector: primary model ${GEMINI_MODEL} rate-limited, falling back to ${GEMMA_MODEL}`
      );
      return await callWithRetry(candidates, recentTitles, apiKey, GEMMA_MODEL);
    }
    throw err;
  }
}

async function callWithRetry(
  candidates: ArticleCandidate[],
  recentTitles: string[],
  apiKey: string,
  model: string
): Promise<SelectedArticle[]> {
  const recentList =
    recentTitles.length > 0
      ? `\n\nAlready delivered (do NOT select similar articles):\n${recentTitles.map((t) => `- ${t}`).join('\n')}`
      : '';

  const articleList = candidates
    .map(
      (a) =>
        `{"id": ${a.id}, "title": "${a.title.replace(/"/g, "'")}", "snippet": "${(a.snippet || '').slice(0, 200).replace(/"/g, "'").replace(/\n/g, ' ')}", "source": "${a.source}"}`
    )
    .join(',\n');

  const prompt = `You are a tech news curator. Select the ${SELECT_TOP_N} most important articles from the list below.

## What qualifies as important (BE EXTREMELY STRICT)

Select ONLY articles that are:
- **AAA games** from major studios (Rockstar, CD Projekt, FromSoftware, Naughty Dog, Bethesda, Blizzard, etc.) — major releases, delays, or announcements. NOT indie games, NOT opinion pieces, NOT pride week articles, NOT interviews
- **Major AI launches** — new models from OpenAI/Google/Anthropic, significant capability breakthroughs, major safety/policy changes. NOT tool updates, NOT tutorials, NOT benchmarks
- **Critical programming news** — major framework releases (React, Docker, Kubernetes, Rust), critical zero-day CVEs, industry shifts. NOT minor library updates, NOT blog posts, NOT tips

When in doubt, do NOT select. It's better to select fewer than 10 than to include unimportant ones.

## Articles to choose from (${candidates.length} total):
[
${articleList}
]
${recentList}

Select up to ${SELECT_TOP_N} articles. Respond in this exact JSON format:
{"selected": [{"id": 123, "reason": "major game release"}, {"id": 456, "reason": "new AI model launch"}]}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const requestBody = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 1,
      maxOutputTokens: 16384,
      responseMimeType: 'application/json',
    },
  });

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await callGemini(url, requestBody, candidates);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const status = (lastError as SelectorError).status;
      const retryable = status !== undefined && RETRYABLE_STATUS.has(status);

      if (attempt < MAX_ATTEMPTS && retryable) {
        const delay = RETRY_DELAYS_MS[attempt - 1];
        console.warn(
          `${model}: attempt ${attempt}/${MAX_ATTEMPTS} failed (${lastError.message}), retrying in ${delay}ms...`
        );
        await sleep(delay);
        continue;
      }
      throw lastError;
    }
  }

  throw lastError || new Error('selector: exhausted retries');
}

interface SelectorError extends Error {
  status?: number;
}

async function callGemini(
  url: string,
  body: string,
  candidates: ArticleCandidate[]
): Promise<SelectedArticle[]> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!resp.ok) {
    let detail = '';
    try {
      const errBody = (await resp.json()) as { error?: { message?: string } };
      detail = errBody.error?.message || '';
    } catch {}
    const err: SelectorError = new Error(
      resp.status === 429
        ? `RATE_LIMITED: ${detail || 'quota exceeded'}`
        : `Selector API error ${resp.status}: ${detail || 'unknown'}`
    );
    err.status = resp.status;
    throw err;
  }

  const data = (await resp.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };

  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error('Empty selector response');

  const parsed = JSON.parse(stripMarkdownFences(content)) as { selected: SelectedArticle[] };
  if (!Array.isArray(parsed.selected))
    throw new Error('No selected array in selector response');

  const validIds = new Set(candidates.map((c) => c.id));
  const selected = parsed.selected
    .filter((s) => validIds.has(s.id))
    .slice(0, SELECT_TOP_N);

  console.log(
    `selector: selected ${selected.length}/${SELECT_TOP_N} from ${candidates.length} candidates`
  );

  return selected;
}

function stripMarkdownFences(text: string): string {
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*\n?/, '');
    s = s.replace(/\n?```\s*$/, '');
  }
  return s.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
