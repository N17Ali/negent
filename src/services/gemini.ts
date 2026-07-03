import { GeminiResult } from '../types';
import { GEMINI_MODEL, GEMMA_MODEL } from '../utils/constants';

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [2000, 5000];
const RETRYABLE_STATUS = new Set([429, 503]);

export async function summarizeAndTranslate(
  title: string,
  content: string,
  sourceName: string,
  apiKey: string
): Promise<GeminiResult> {
  try {
    return await callWithRetry(title, content, sourceName, apiKey, GEMINI_MODEL);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('RATE_LIMITED')) {
      console.warn(`gemini: primary model ${GEMINI_MODEL} rate-limited, falling back to ${GEMMA_MODEL}`);
      return await callWithRetry(title, content, sourceName, apiKey, GEMMA_MODEL);
    }
    throw err;
  }
}

async function callWithRetry(
  title: string,
  content: string,
  sourceName: string,
  apiKey: string,
  model: string
): Promise<GeminiResult> {
  const prompt = `You are an extremely selective tech news curator for a Persian-speaking audience. Your job is to identify ONLY the most important news worth telling a friend about.

## Scoring (BE EXTREMELY STRICT — when in doubt, score 1-2)

- 5: Industry-defining moment. Examples: GTA 6 release date, GPT-5 launch, Log4Shell-level CVE, Microsoft acquires Nintendo
- 4: Genuinely important. Examples: major game from top studio (Rockstar, CD Projekt, FromSoftware, Naughty Dog, Bethesda), new AI model from OpenAI/Google/Anthropic, major framework release (React 19, Docker 2.0), critical zero-day CVE
- 3: Notable but skip-worthy. Minor game updates, DLCs, opinion pieces, indie games, benchmarks, tool tips
- 2: Barely interesting. Niche topics, minor patches, rumors, tangential tech news
- 1: Not worth sending. General news, celebrity gossip, non-tech, pride week articles, developer personal stories

## Category rules

- gaming: ONLY AAA games from major studios score 4-5. Indie games, mobile games, browser games, game opinion pieces, pride week in games, developer interviews = score 1-2
- ai: ONLY new model launches, major capability breakthroughs, or significant safety/policy changes = 4-5. Tool updates, API changes, tutorials, benchmarks = 1-2
- programming: ONLY major releases (React, Docker, Kubernetes, Rust), critical vulnerabilities, or industry shifts = 4-5. Minor library updates, tutorials, tips, blog posts = 1-2

## Summary rules

1. Summarize in 3-4 short paragraphs
2. Write in informal/conversational Persian (like talking to a friend, use "تو" not "شما")
3. Keep technical terms in English (e.g., API, GPU, React, LLM, etc.)
4. Do not add opinions or information not in the original
5. If quoting someone, prefix the quote line with "> " (markdown quote style)
6. If the content is too short or unclear, summarize what's available

Article title: ${title}
Article content: ${content}
Source: ${sourceName}

Respond in this exact JSON format:
{"summary": "paragraph 1\\n\\nparagraph 2\\n\\nparagraph 3\\n\\nparagraph 4", "category": "ai", "relevance_score": 4}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const requestBody = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
    },
  });

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await callGemini(url, requestBody);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const status = (lastError as GeminiError).status;
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

  throw lastError || new Error('gemini: exhausted retries');
}

interface GeminiError extends Error {
  status?: number;
}

async function callGemini(url: string, body: string): Promise<GeminiResult> {
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
    const err: GeminiError = new Error(
      resp.status === 429
        ? `RATE_LIMITED: ${detail || 'quota exceeded'}`
        : `Gemini API error ${resp.status}: ${detail || 'unknown'}`
    );
    err.status = resp.status;
    throw err;
  }

  const data = (await resp.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty Gemini response');

  const parsed: GeminiResult = JSON.parse(text);
  if (!parsed.summary) throw new Error('No summary in Gemini response');
  if (!parsed.category) throw new Error('No category in Gemini response');
  if (typeof parsed.relevance_score !== 'number')
    throw new Error('No relevance_score in Gemini response');

  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
