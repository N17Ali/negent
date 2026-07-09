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

/**
 * Selector output. `selected` is the top-N to ship now; `bucket` holds articles the
 * selector judged genuinely important but which lost the top-N slots to more important
 * stories. Bucket articles are kept (left `raw`) and reconsidered on the next run rather
 * than being skipped, so a strong story isn't dropped just because a better one showed up
 * the same batch.
 */
export interface SelectionResult {
  selected: SelectedArticle[];
  bucket: number[];
}

export async function selectTopArticles(
  candidates: ArticleCandidate[],
  recentTitles: string[],
  apiKey: string
): Promise<SelectionResult> {
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
): Promise<SelectionResult> {
  const recentList =
    recentTitles.length > 0
      ? `\n\nAlready delivered (do NOT select these or any article covering the same story):\n${recentTitles.map((t) => `- ${t}`).join('\n')}`
      : '';

  const articleList = candidates
    .map(
      (a) =>
        `{"id": ${a.id}, "title": "${a.title.replace(/"/g, "'")}", "snippet": "${(a.snippet || '').slice(0, 200).replace(/"/g, "'").replace(/\n/g, ' ')}", "source": "${a.source}"}`
    )
    .join(',\n');

  const prompt = `You are a tech news curator. Select the ${SELECT_TOP_N} most interesting articles from the list below.

## What qualifies as important

Prefer concrete news that matters to a tech-savvy audience:
- **Games** — notable releases, delays, or announcements (major studios especially, but strong indie news counts too).
- **AI** — new models, notable capability advances, significant product/API launches, or policy/safety changes.
- **Programming** — framework or tool releases, notable version launches, security issues (CVEs), or meaningful industry shifts.

Favor real news over pure opinion pieces, tutorials, and how-to tips. Aim to fill all ${SELECT_TOP_N} slots when there are enough reasonable candidates; only pick fewer if there genuinely aren't ${SELECT_TOP_N} worthwhile stories.

## Deduplicate (important)

Several sources often cover the SAME story. Never select more than one article about the same event — pick the single best (most detailed / most authoritative) one and drop the near-duplicates, even if their titles are worded differently.

## Articles to choose from (${candidates.length} total):
[
${articleList}
]
${recentList}

Select up to ${SELECT_TOP_N} articles for "selected". Additionally, if there are OTHER articles that are genuinely worthwhile by the bar above but didn't make the top ${SELECT_TOP_N} (they lost their slot to more important stories), list just their ids in "bucket" so they can be reconsidered next time. Do NOT put weak articles in "bucket" — only ones you'd have selected if there were more room. Never put the same id in both lists.

Respond in this exact JSON format:
{"selected": [{"id": 123, "reason": "major game release"}, {"id": 456, "reason": "new AI model launch"}], "bucket": [789, 1011]}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const requestBody = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
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
): Promise<SelectionResult> {
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

  const parsed = JSON.parse(stripMarkdownFences(content)) as {
    selected: SelectedArticle[];
    bucket?: number[];
  };
  if (!Array.isArray(parsed.selected))
    throw new Error('No selected array in selector response');

  const validIds = new Set(candidates.map((c) => c.id));
  const selected = parsed.selected
    .filter((s) => validIds.has(s.id))
    .slice(0, SELECT_TOP_N);

  // Runner-ups: valid, not already selected, deduped. Kept raw for the next run.
  const selectedIds = new Set(selected.map((s) => s.id));
  const bucket = Array.isArray(parsed.bucket)
    ? [...new Set(parsed.bucket)].filter((id) => validIds.has(id) && !selectedIds.has(id))
    : [];

  console.log(
    `selector: selected ${selected.length}/${SELECT_TOP_N}, bucketed ${bucket.length} for next run, from ${candidates.length} candidates`
  );

  return { selected, bucket };
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
