import { BATCH_SELECT_SIZE, SELECT_TOP_N } from '../utils/constants';

export const DEEPSEEK_MODEL = 'deepseek-ai/deepseek-v4-pro';

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

  const resp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      top_p: 0.95,
      max_tokens: 16384,
      chat_template_kwargs: { thinking: false },
      stream: false,
    }),
  });

  if (!resp.ok) {
    let detail = '';
    try {
      const errBody = await resp.json();
      detail = (errBody as any)?.error?.message || (errBody as any)?.detail || '';
    } catch {}
    throw new Error(`DeepSeek API error ${resp.status}: ${detail || 'unknown'}`);
  }

  const data = (await resp.json()) as {
    choices?: { message?: { content?: string } }[];
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty DeepSeek response');

  const parsed = JSON.parse(content) as { selected: SelectedArticle[] };
  if (!Array.isArray(parsed.selected)) throw new Error('No selected array in DeepSeek response');

  const validIds = new Set(candidates.map((c) => c.id));
  const selected = parsed.selected.filter((s) => validIds.has(s.id)).slice(0, SELECT_TOP_N);

  console.log(
    `deepseek: selected ${selected.length}/${SELECT_TOP_N} from ${candidates.length} candidates`
  );

  return selected;
}
