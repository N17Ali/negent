import { GeminiResult } from '../types';
import { AUDIO_MAX_CHARS } from '../utils/constants';
import { buildGeminiUrl, buildGeminiBody, callAndParse, withModelFallback, extractJsonObject, type RetryOptions } from './geminiClient';

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [2000, 5000];

const RETRY: RetryOptions = {
  maxAttempts: MAX_ATTEMPTS,
  retryDelaysMs: RETRY_DELAYS_MS,
  label: 'gemini',
};

export async function summarizeAndTranslate(
  title: string,
  content: string,
  sourceName: string,
  apiKey: string
): Promise<GeminiResult> {
  return withModelFallback((model) => callModel(model, title, content, sourceName, apiKey), 'gemini');
}

async function callModel(
  model: string,
  title: string,
  content: string,
  sourceName: string,
  apiKey: string
): Promise<GeminiResult> {
  const prompt = buildPrompt(title, content, sourceName);
  const url = buildGeminiUrl(model, apiKey);
  const body = buildGeminiBody(prompt, 0.3, 8192);
  const retry: RetryOptions = { ...RETRY, label: model };

  return callAndParse(url, body, parseResult, 'Gemini', retry);
}

function buildPrompt(title: string, content: string, sourceName: string): string {
  return `You are a Persian tech news translator and summarizer.

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
}

function parseResult(text: string): GeminiResult {
  const parsed = JSON.parse(extractJsonObject(text)) as GeminiResult;
  if (!parsed.summary) throw new Error('No summary in Gemini response');
  if (!parsed.category) throw new Error('No category in Gemini response');
  if (typeof parsed.relevance_score !== 'number')
    throw new Error('No relevance_score in Gemini response');

  if (!parsed.full_fa) parsed.full_fa = parsed.summary;
  return parsed;
}
