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
  const url = buildGeminiUrl(model, apiKey);
  const body = buildGeminiBody(prompt, 0.2, 16384);
  const retry: RetryOptions = { ...RETRY, label: model };

  return callAndParse(url, body, (text) => parseSelection(text, candidates), 'selector', retry);
}

function buildPrompt(candidates: ArticleCandidate[], recentTitles: string[]): string {
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

return `You are a strict tech news curator. Select AT MOST ${SELECT_TOP_N} articles — the ones that are genuinely important, must-know news for a sophisticated tech audience. Be strict but fair. The default answer is NO, but a genuinely consequential or technically novel story should get a YES.

## The bar (clear YES stories qualify)

An article qualifies if a well-informed engineer would consider it real, consequential news that they'd want to hear about today:
- **Games** — a major release, a significant delay, or a headline announcement from a major studio (or a genuinely landmark indie moment). Not roundups, reviews, sales, patches, or minor updates.
- **AI** — a genuinely new foundation model (GPT-5, Claude 4, Gemini 2, Llama 4, etc.), a real capability breakthrough (new SOTA on major benchmarks), a major product/API launch from a recognized lab (OpenAI, Anthropic, Google, Meta, xAI, Mistral), or a significant policy/safety development (government regulation, major safety research). Also accept: genuinely novel agent frameworks or tools IF they demonstrate a real new capability (not just a wrapper). NOT: incremental tweaks, fine-tunes, thin wrappers, dev.to tutorials, or "X company might do Y".
- **Programming & projects** — a major framework/tool release (React 19, TypeScript 5.5, Node 22, etc.), a serious security issue (real CVE with impact), a meaningful industry shift, OR a genuinely novel, technically deep tool/project (clever engineering, a new capability, a non-obvious hack). NOT tutorials, tips, opinion, format-conversion or "how to convert X to Y" comparisons, or minor version bumps.

## Source quality

- Major publications (TechCrunch, The Verge, Ars Technica, Hacker News front page, official company blogs) → higher trust
- dev.to, personal blogs, Medium, Substack → lower trust, but still selectable if the content is genuinely novel and consequential (not a tutorial or "I built X" clone)
- GitHub repo announcements → select only if the project is genuinely novel and technically deep
- Reddit/Hacker News comments/discussions → never select.

## Taste (learn from these examples)

WANT — technically deep and NOVEL. The reader learns something or sees a clever hack:
- "I built a linter that catches the security bugs AI assistants keep writing" — a tool solving a genuinely new, real problem.
- A single-file dependency-free C engine that streams a 744B-parameter MoE model on 25GB of consumer RAM — non-obvious, impressive engineering.

DO NOT WANT — generic, derivative, or non-technical, even if well-written or popular:
- "I built an open-source spreadsheet app as an alternative to Google Sheets" — a me-too clone of an existing product; no novelty.
- "JSON to Python dataclass / TypedDict / or Pydantic" — a tutorial / format-conversion / how-to comparison.
- "Paris-based AI voice startup raises $100M seed backed by Nvidia" — business/funding news. Funding rounds, valuations, raises, and acquisitions are NOT interesting even when confirmed.

The "I built X" framing is fine — judge the substance. A novel tool that attacks a real problem cleverly is a YES; a clone, wrapper, or tutorial is a NO.

## Reject

Say NO to: opinion/editorial, tutorials/how-tos/tips, format-conversion or "X vs Y" comparisons, listicles and roundups, speculation and rumors, business/funding/fundraising/acquisition news, marketing/PR fluff, derivative clones of existing products, incremental or minor updates, clickbait, and anything you're unsure about. If it's not important AND (consequential OR technically novel), it does not qualify.

## Quantity: prefer fewer, but don't be afraid to select

Do NOT try to fill ${SELECT_TOP_N} slots. Only select an article if it clears the bar above on its own merits. Most batches should yield 1–2 selections. An empty selection is acceptable when nothing qualifies, but if there's a genuinely important story, select it — don't withhold a qualified story just to stay sparse.

## Deduplicate (important)

Several sources often cover the SAME story. Never select more than one article about the same event — pick the single best (most detailed / most authoritative) one and drop the near-duplicates, even if their titles are worded differently.

## Articles to choose from (${candidates.length} total):
[
${articleList}
]
${recentList}

Select up to ${SELECT_TOP_N} articles for "selected" — fewer (or none) is expected and correct when few clear the bar. Additionally, if there are OTHER articles that genuinely clear the strict bar above but lost their slot only because you were already at ${SELECT_TOP_N}, list just their ids in "bucket" so they can be reconsidered next time. The bucket must hold ONLY articles you'd have selected outright — if in doubt, leave it out. Most runs should have an empty bucket. Never put the same id in both lists.

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
