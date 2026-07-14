import { SELECT_TOP_N } from '../utils/constants';
import { buildGeminiUrl, buildGeminiBody, callAndParse, withModelFallback, extractJsonObject, type RetryOptions } from './geminiClient';

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [3000, 8000];

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

export interface SelectionResult {
  selected: SelectedArticle[];
  bucket: number[];
}

const RETRY: RetryOptions = {
  maxAttempts: MAX_ATTEMPTS,
  retryDelaysMs: RETRY_DELAYS_MS,
  label: 'selector',
};

export async function selectTopArticles(
  candidates: ArticleCandidate[],
  recentTitles: string[],
  apiKey: string
): Promise<SelectionResult> {
  return withModelFallback((model) => callModel(model, candidates, recentTitles, apiKey), 'selector');
}

async function callModel(
  model: string,
  candidates: ArticleCandidate[],
  recentTitles: string[],
  apiKey: string
): Promise<SelectionResult> {
  const prompt = buildPrompt(candidates, recentTitles);
  const systemInstruction = buildSystemInstruction();
  const url = buildGeminiUrl(model, apiKey);
  const body = buildGeminiBody(prompt, 0.2, 16384, 'application/json', systemInstruction);
  const retry: RetryOptions = { ...RETRY, label: model };

  return callAndParse(url, body, (text) => parseSelection(text, candidates), 'selector', retry);
}

function buildSystemInstruction(): string {
  return `You are a tech news curator for a sophisticated engineering audience. Your job: from a batch of candidate articles, select at most ${SELECT_TOP_N} that are genuinely important and worth knowing about today.

# Selection bar

An article qualifies ONLY if a well-informed engineer would consider it real, consequential news worth hearing about today. Judge each article on its own merits, regardless of source.

## Clear YES — qualifies
- **Major releases**: new foundation models (GPT-5, Claude 4, etc.), major framework/tool releases (React 19, TypeScript 5.5, Node 22), major game releases from recognized studios, AAA games news.
- **Real breakthroughs**: new SOTA on major benchmarks, a genuinely novel capability, serious security issues (real CVE with impact).
- **Industry shifts**: meaningful policy/safety developments, government regulation, a major company strategic pivot.

## Clear NO — does not qualify
- Tutorials, how-tos, tips, "X vs Y" format-conversion comparisons.
- Opinion pieces, editorials, listicles, roundups.
- Business/funding/fundraising/acquisition news.
- Speculation, rumors, "X company might do Y."
- Personal blog posts, "I built X" showcases, GitHub side projects.
- Incremental tweaks, minor version bumps, patches.
- Prompt/token tricks, MCP servers, agent frameworks, coding assistants, wrapper tools.
- Marketing/PR, clickbait.

## Taste examples

WANT — real, consequential news a sharp engineer would want today:
- "A single-file C engine streaming a 744B MoE model on 25GB consumer RAM" — non-obvious engineering with a genuinely novel result.
- "TypeScript's compiler rewritten in Go, 10x faster builds, shipping in 7.0" — a major release from a tool people actually use.
- "Rockstar locks in GTA 6 release date after the delay" — real AAA game news with a concrete, consequential fact.

DO NOT WANT — narrow, incremental, or not-really-news:
- "Automatic differentiation in LFortran via the Enzyme plugin" — niche library-integration deep-dive; matters to almost no one.
- "We benchmarked Apple's new Speech API against Whisper" — vendor/company benchmark blog post, basically marketing.
- "MIT's new method flags models trained on abuse imagery" — incremental academic research announcement, not a shipped capability or breakthrough.
- "openai/codex #28058: agent hangs on nested tool calls" — a GitHub issue/PR thread, not news.
- "OpenAI mandates hardware passkeys for staff ChatGPT logins" — internal corporate ops/security-policy PR, no consequence outside the company.
- "New gameplay trailer for an indie roguelike" — routine trailer/listicle, not a real release or announcement.

# Quantity

Do NOT try to fill ${SELECT_TOP_N} slots. Select only articles that clear the bar. Many batches yield 0–2, and an empty selection is the correct answer when nothing qualifies. When a story genuinely clears the bar, include it even if it's from a different domain than the others — a strong game or systems story should not be edged out just because AI stories are also present.

# Deduplication

If multiple articles cover the same story, select only the single best one.`;
}

function buildPrompt(candidates: ArticleCandidate[], recentTitles: string[]): string {
  const recentBlock =
    recentTitles.length > 0
      ? `\n\n## Already delivered (do NOT select these or any article covering the same story)\n${recentTitles.map((t) => `- ${t}`).join('\n')}`
      : '';

  const articleList = candidates
    .map(
      (a) =>
        `{"id": ${a.id}, "title": "${a.title.replace(/"/g, "'")}", "snippet": "${(a.snippet || '').slice(0, 200).replace(/"/g, "'").replace(/\n/g, ' ')}", "source": "${a.source}"}`
    )
    .join(',\n');

  return `## Articles (${candidates.length} total)
[
${articleList}
]${recentBlock}

## Task

Select up to ${SELECT_TOP_N} articles that clear the bar in the system instruction. For each, give a one-line reason.

Additionally, if OTHER articles clear the bar but lost their slot only because you were already at ${SELECT_TOP_N}, list their ids in "bucket" so they can be reconsidered next run. The bucket must hold ONLY articles you'd select outright — if in doubt, leave it out.

Respond in this exact JSON format:
{"selected": [{"id": 123, "reason": "major game release"}, {"id": 456, "reason": "new AI model launch"}], "bucket": [789, 1011]}`;
}

function parseSelection(text: string, candidates: ArticleCandidate[]): SelectionResult {
  const parsed = JSON.parse(extractJsonObject(text)) as {
    selected: SelectedArticle[];
    bucket?: number[];
  };
  if (!Array.isArray(parsed.selected))
    throw new Error('No selected array in selector response');

  const validIds = new Set(candidates.map((c) => c.id));
  const selected = parsed.selected
    .filter((s) => validIds.has(s.id))
    .slice(0, SELECT_TOP_N);

  const selectedIds = new Set(selected.map((s) => s.id));
  const bucket = Array.isArray(parsed.bucket)
    ? [...new Set(parsed.bucket)].filter((id) => validIds.has(id) && !selectedIds.has(id))
    : [];

  console.log(
    `selector: selected ${selected.length}/${SELECT_TOP_N}, bucketed ${bucket.length} for next run, from ${candidates.length} candidates`
  );

  return { selected, bucket };
}
