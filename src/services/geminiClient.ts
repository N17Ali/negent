import { GEMINI_MODEL, GEMMA_MODEL } from '../utils/constants';

const DEFAULT_RETRYABLE_STATUS = new Set([429, 503]);

export interface GeminiHttpError extends Error {
  status?: number;
}

export interface RetryOptions {
  maxAttempts: number;
  retryDelaysMs: number[];
  label: string;
  retryableStatus?: Set<number>;
}

export function buildGeminiUrl(model: string, apiKey: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
}

export function buildGeminiBody(
  prompt: string,
  temperature: number,
  maxOutputTokens: number,
  responseMimeType = 'application/json'
): string {
  return JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens, responseMimeType },
  });
}

async function callGeminiHttp(url: string, body: string, errorLabel: string): Promise<string> {
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
    const err: GeminiHttpError = new Error(
      resp.status === 429
        ? `RATE_LIMITED: ${detail || 'quota exceeded'}`
        : `${errorLabel} API error ${resp.status}: ${detail || 'unknown'}`
    );
    err.status = resp.status;
    throw err;
  }

  const data = (await resp.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error(`Empty ${errorLabel} response`);
  return text;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const retryable = options.retryableStatus ?? DEFAULT_RETRYABLE_STATUS;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const status = (lastError as GeminiHttpError).status;
      const canRetry = status !== undefined && retryable.has(status);

      if (attempt < options.maxAttempts && canRetry) {
        const delay = options.retryDelaysMs[attempt - 1];
        console.warn(
          `${options.label}: attempt ${attempt}/${options.maxAttempts} failed (${lastError.message}), retrying in ${delay}ms...`
        );
        await sleep(delay);
        continue;
      }
      throw lastError;
    }
  }
  throw lastError || new Error(`${options.label}: exhausted retries`);
}

export async function withModelFallback<T>(
  callFn: (model: string) => Promise<T>,
  label: string
): Promise<T> {
  try {
    return await callFn(GEMINI_MODEL);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('RATE_LIMITED')) {
      console.warn(`${label}: primary model ${GEMINI_MODEL} rate-limited, falling back to ${GEMMA_MODEL}`);
      return await callFn(GEMMA_MODEL);
    }
    throw err;
  }
}

export async function callAndParse<T>(
  url: string,
  body: string,
  parse: (text: string) => T,
  errorLabel: string,
  retryOptions: RetryOptions
): Promise<T> {
  return withRetry(async () => {
    const text = await callGeminiHttp(url, body, errorLabel);
    return parse(text);
  }, retryOptions);
}

export function extractJsonObject(text: string): string {
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*\n?/, '');
    s = s.replace(/\n?```\s*$/, '');
    s = s.trim();
  }
  const start = s.indexOf('{');
  if (start === -1) return s;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
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
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return s.slice(start).trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
