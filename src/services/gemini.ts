import { GeminiResult } from '../types';
import { GEMINI_MODEL } from '../utils/constants';

export async function summarizeAndTranslate(
  title: string,
  content: string,
  sourceName: string,
  apiKey: string
): Promise<string> {
  const prompt = `You are a tech news summarizer. Given an article title and content, produce a Persian (Farsi) summary.

Rules:
1. Summarize the key points in exactly 2-3 short paragraphs
2. Write in informal/conversational Persian (like talking to a friend, use "تو" not "شما")
3. Keep technical terms in English (e.g., API, GPU, React, LLM, etc.)
4. Do not add opinions or information not in the original
5. If the content is too short or unclear, summarize what's available

Article title: ${title}
Article content: ${content}
Source: ${sourceName}

Respond in this exact JSON format:
{"summary": "paragraph 1\\n\\nparagraph 2\\n\\nparagraph 3"}`;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1024,
          responseMimeType: 'application/json',
        },
      }),
    }
  );

  if (!resp.ok) {
    let detail = '';
    try {
      const errBody = (await resp.json()) as { error?: { message?: string } };
      detail = errBody.error?.message || '';
    } catch {}
    if (resp.status === 429) throw new Error(`RATE_LIMITED: ${detail || 'quota exceeded'}`);
    throw new Error(`Gemini API error ${resp.status}: ${detail || 'unknown'}`);
  }

  const data = (await resp.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty Gemini response');

  const parsed: GeminiResult = JSON.parse(text);
  if (!parsed.summary) throw new Error('No summary in Gemini response');

  return parsed.summary;
}
