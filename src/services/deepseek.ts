import { BATCH_SELECT_SIZE, SELECT_TOP_N } from '../utils/constants';

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

  const prompt = `You are an extremely selective tech news curator for a Persian-speaking audience. Select the ${SELECT_TOP_N} most important articles worth telling a friend about.

## Selection criteria (BE EXTREMELY STRICT)

Only select articles that are:
- **AAA games** from major studios (Rockstar, CD Projekt, FromSoftware, Naughty Dog, Bethesda, Blizzard, etc.) — major releases, delays, or announcements only
- **Major AI launches** — new models from OpenAI/Google/Anthropic, significant capability breakthroughs, major safety/policy changes
- **Critical programming news** — major framework releases (React, Docker, Kubernetes, Rust), critical zero-day CVEs, industry shifts

## Do NOT select:
- Indie games, mobile games, browser games, game opinion pieces, pride week articles, developer interviews
- Tool updates, API changes, tutorials, benchmarks, tool tips
- Minor library updates, blog posts, personal stories, rumors
- General news, celebrity gossip, non-tech content
- Articles similar to already delivered ones

## Articles to choose from (${candidates.length} total):
[
${articleList}
]
${recentList}

Select exactly ${SELECT_TOP_N} articles. Respond in this exact JSON format:
{"selected": [{"id": 123, "reason": "major game release"}, {"id": 456, "reason": "new AI model launch"}]}`;

  const resp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-ai/deepseek-r1',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
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
