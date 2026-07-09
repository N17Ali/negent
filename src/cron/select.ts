import { Env } from '../types';
import { selectTopArticles } from '../services/selector';
import { summarizeAndTranslate } from '../services/gemini';
import { fetchArticleText } from '../services/extract';
import {
  getRawArticlesBatch,
  getRecentDeliveredTitles,
  markArticlesSkipped,
  markArticlesSelected,
  getSelectedArticles,
  lockArticle,
  markArticleDone,
  markArticleFailed,
} from '../db';
import { BATCH_SELECT_SIZE } from '../utils/constants';
import { isWithinDeliveryHours } from '../utils/time';

export async function selectCron(env: Env, force = false): Promise<void> {
  if (!force && !isWithinDeliveryHours()) {
    console.log('select: outside delivery hours (9am-9pm Tehran), skipping');
    return;
  }
  if (force) {
    console.log('select: force=true — bypassing delivery-hours gate');
  }

  const { results: rawRows } = await getRawArticlesBatch(env.DB, BATCH_SELECT_SIZE);
  if (rawRows.length) {
    console.log(`select: ${rawRows.length} raw articles found`);
    await selectAndSummarize(env, rawRows);
  } else {
    console.log('select: no raw articles to select from');
  }
  // Delivery is a separate cron (cron/deliver.ts) — this run only produces `done`
  // articles for it to ship one-per-tick with their voice reading.
}

async function selectAndSummarize(
  env: Env,
  rawRows: { id: number; title: string; content_snippet: string | null; source_name: string | null }[]
): Promise<void> {
  // Wider recent-delivered window than a single run so a story delivered earlier in the
  // day still guards against a same-story near-duplicate showing up hours later (the
  // selector has no memory of past runs — this list is its only cross-run dedup signal).
  const { results: recent } = await getRecentDeliveredTitles(env.DB, 50);
  const recentTitles = recent.map((r) => r.title);

  let selectedIds: number[];
  let bucketIds: number[] = [];
  try {
    const candidates = rawRows.map((r) => ({
      id: r.id,
      title: r.title,
      snippet: r.content_snippet || '',
      source: r.source_name || '',
    }));

    const { selected, bucket } = await selectTopArticles(candidates, recentTitles, env.GEMINI_API_KEY);
    selectedIds = selected.map((s) => s.id);
    bucketIds = bucket;

    console.log(
      `select: selector chose ${selectedIds.length} articles: [${selectedIds.join(',')}], ` +
        `bucketed ${bucketIds.length} for next run: [${bucketIds.join(',')}]`
    );
  } catch (err) {
    console.error('select: selector failed:', err instanceof Error ? err.message : err);
    return;
  }

  // Skip everything the selector neither picked nor bucketed. Bucketed articles are left
  // 'raw' so the next select run reconsiders them alongside newly-fetched candidates.
  const keep = new Set([...selectedIds, ...bucketIds]);
  const notSelectedIds = rawRows.map((r) => r.id).filter((id) => !keep.has(id));
  if (notSelectedIds.length) {
    await markArticlesSkipped(env.DB, notSelectedIds);
    console.log(`select: marked ${notSelectedIds.length} articles as skipped`);
  }

  if (!selectedIds.length) {
    console.log('select: no articles selected');
    return;
  }

  await markArticlesSelected(env.DB, selectedIds);

  const { results: selectedArticles } = await getSelectedArticles(env.DB);
  if (!selectedArticles.length) {
    console.log('select: no selected articles found after marking');
    return;
  }

  let succeeded = 0;
  for (const article of selectedArticles) {
    const lock = await lockArticle(env.DB, article.id);
    if (!lock.meta.changes) {
      console.log(`select: article ${article.id} could not be locked`);
      continue;
    }

    console.log(`select: summarizing article ${article.id} "${article.title}"`);

    // Fetch the full article body for the summarizer; the RSS teaser is often too
    // short to contain the key facts (numbers, records). Fall back to the teaser
    // if the page fetch yields nothing useful or is shorter than what we have.
    const teaser = article.content_snippet || '';
    const fullText = await fetchArticleText(article.url);
    const contentForSummary = fullText && fullText.length > teaser.length ? fullText : teaser;
    console.log(
      `select: article ${article.id} content ${contentForSummary.length} chars ` +
        `(${contentForSummary === teaser ? 'teaser' : 'full page'})`
    );

    try {
      const result = await summarizeAndTranslate(
        article.title,
        contentForSummary,
        article.source_name || '',
        env.GEMINI_API_KEY
      );
      console.log(
        `select: article ${article.id} [${result.category}|${result.relevance_score}] done`
      );
      await markArticleDone(
        env.DB,
        article.id,
        result.summary,
        result.full_fa,
        result.category,
        result.relevance_score
      );
      succeeded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error(`select: article ${article.id} failed: ${msg}`);
      await markArticleFailed(env.DB, article.id, msg);
    }
  }

  console.log(`select: summarized ${succeeded}/${selectedArticles.length} articles`);
}
