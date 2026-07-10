import { GeminiResult } from '../types';
import { GEMINI_MODEL, GEMMA_MODEL, AUDIO_MAX_CHARS } from '../utils/constants';

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
  const prompt = `You are a Persian tech news translator and summarizer.

## Task

1. Categorize into exactly ONE: "ai", "programming", or "gaming"
2. Rate importance 1-5 (for display only)
3. Summarize in 2-4 paragraphs (field "summary")
4. Produce a Persian rendering of the article for reading aloud, capped in length (field "full_fa")

## Length & completeness (important)

- Keep the "summary" UNDER 900 characters so it fits in one Telegram message without being cut.
- ALWAYS finish the final paragraph and the final sentence. Never stop mid-sentence or mid-word.
- If you're running out of room in the summary, write FEWER paragraphs rather than cutting one off — a complete 2-paragraph summary beats a truncated 4-paragraph one.

## Full translation ("full_fa") — this is what gets read aloud

- Produce a faithful Persian rendering of the article, but keep "full_fa" UNDER ${AUDIO_MAX_CHARS} characters. It is spoken aloud and the voice budget is limited, so this is a hard cap.
- ALWAYS finish the final sentence. Never stop mid-sentence or mid-word — if you're approaching the ${AUDIO_MAX_CHARS}-character limit, wrap up the current thought and end cleanly rather than cutting off.
- Within that budget, cover the article's most important points in order — the lead facts first. If the article is long, it's fine to leave out minor tail details, but never truncate mid-sentence to do so.
- It's a translation, not a retelling: preserve the article's structure and flow for the parts you include.
- This text is spoken aloud by a text-to-speech voice, so optimize it for LISTENING:
  - Prefer SHORTER sentences — break long, clause-heavy sentences into two or three short ones.
  - Use natural transitions between sentences and paragraphs so it flows when heard (e.g. «از طرف دیگه»، «در نهایت»، «نکته‌ی جالب اینه که»).
  - Use punctuation that guides speech — commas for short pauses, periods for full stops — so the voice paces itself and doesn't run on.
  - Expand abbreviations into spoken words where it helps the listener (write the full form the way it's said), instead of leaving a bare acronym mid-sentence.
- Same Persian writing rules as below. Separate paragraphs with \\n\\n — the reader pauses between paragraphs, so group each idea into its own paragraph.
- If the source body is very short, translate what's there; don't pad it.

## Persian writing rules

- Write in informal/conversational Persian (like talking to a friend, use "تو" not "شما")
- Keep technical terms in English (e.g., API, GPU, React, LLM, etc.)
- Do not add opinions or information not in the original
- If quoting someone, prefix the quote line with "> " (markdown quote style)
- If the content is too short or unclear, summarize what's available

## Keep the specifics (important)

Preserve every concrete fact the article states — never flatten a specific into a vague phrase:
- Numbers and figures: sales/records, prices, benchmarks, dates, version numbers, percentages, player/download counts
- Named entities: products, companies, people, studios, model names
- Example: if the article says a game "broke its sales record with X million copies sold", you MUST include the "X million" — do NOT write just "hit a record" without the number
- Never invent a figure that isn't in the source, but never drop one that is

Article title: ${title}
Article content: ${content}
Source: ${sourceName}

Respond in this exact JSON format (summary 2 to 4 paragraphs separated by \\n\\n and under 900 characters; full_fa the Persian reading separated by \\n\\n and under ${AUDIO_MAX_CHARS} characters; every sentence finished):
{"summary": "paragraph 1\\n\\nparagraph 2\\n\\n...up to paragraph 4", "full_fa": "full translation paragraph 1\\n\\nparagraph 2\\n\\n...", "category": "ai", "relevance_score": 4}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const requestBody = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 8192,
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
    } catch { }
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

  const parsed: GeminiResult = JSON.parse(extractJsonObject(text));
  if (!parsed.summary) throw new Error('No summary in Gemini response');
  if (!parsed.category) throw new Error('No category in Gemini response');
  if (typeof parsed.relevance_score !== 'number')
    throw new Error('No relevance_score in Gemini response');

  // full_fa is the full translation read aloud. Optional — if the model omits it, fall
  // back to the summary so the article still ships (with a shorter voice reading).
  if (!parsed.full_fa) parsed.full_fa = parsed.summary;

  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pull the first balanced top-level JSON object out of a model response. Gemini with
 * responseMimeType 'application/json' *usually* returns clean JSON, but occasionally wraps
 * it in ```json fences or appends stray text after the closing brace — which made a raw
 * JSON.parse throw "Unexpected non-whitespace character after JSON" and drop the article.
 * Scanning brace depth (while ignoring braces inside strings) returns just the object.
 */
function extractJsonObject(text: string): string {
  const start = text.indexOf('{');
  if (start === -1) return text.trim();

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  // Unbalanced (e.g. truncated at maxOutputTokens): return from the first brace and let
  // JSON.parse surface the error, same as before.
  return text.slice(start).trim();
}
