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
  const prompt = `You are a Persian tech news translator and summarizer. An article has already been selected as important — your job is to summarize it in Persian.

## Task

1. Categorize into exactly ONE: "ai", "programming", or "gaming"
2. Rate importance 1-5 (this is for display only, the article is already selected)
3. Summarize in 3-4 short paragraphs

## Persian writing rules

- Write in informal/conversational Persian (like talking to a friend, use "تو" not "شما")
- Keep technical terms in English (e.g., API, GPU, React, LLM, etc.)
- Do not add opinions or information not in the original
- If quoting someone, prefix the quote line with "> " (markdown quote style)
- If the content is too short or unclear, summarize what's available

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
