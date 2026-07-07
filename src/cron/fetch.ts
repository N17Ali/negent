import { Env } from '../types';
import { parseFeed, computeUrlHash, parsePubDate } from '../services/rss';
import { getNextSource, advanceSourceOrder, batchInsertArticles, ArticleInsert, cleanupOldArticles } from '../db';
import { isRelevantArticle } from '../utils/filter';
import { MAX_ARTICLE_AGE_HOURS } from '../utils/constants';

export async function fetchCron(env: Env): Promise<void> {
  const cleanup = await cleanupOldArticles(env.DB);
  if (cleanup.meta.changes) {
    console.log(`fetch: cleaned up ${cleanup.meta.changes} old articles`);
  }

  const source = await getNextSource(env.DB);
  if (!source) {
    console.log('fetch: no active sources');
    return;
  }

  let xml: string;
  try {
    console.log(`fetch: ${source.name} → ${source.url}`);
    const resp = await fetch(source.url, {
      headers: { 'User-Agent': 'negent/1.0 (RSS reader)' },
    });
    if (!resp.ok) {
      console.warn(`fetch: ${source.name} returned HTTP ${resp.status}`);
      await advanceSourceOrder(env.DB, source.id);
      return;
    }
    xml = await resp.text();
  } catch (err) {
    console.error(`fetch: ${source.name} failed:`, err instanceof Error ? err.message : err);
    await advanceSourceOrder(env.DB, source.id);
    return;
  }

  const items = parseFeed(xml);
  console.log(`fetch: ${source.name} parsed ${items.length} items`);

  let skipped = 0;
  let stale = 0;
  const maxAgeMs = MAX_ARTICLE_AGE_HOURS * 60 * 60 * 1000;
  const now = Date.now();
  const toInsert: ArticleInsert[] = [];
  for (const item of items) {
    if (!item.link) continue;
    // Reject articles whose publish date is older than the age window. Feeds
    // sometimes re-list old posts under a new URL slug (different url_hash), so
    // dedup can't catch them — only the publish date can. Items with no/unparseable
    // date are allowed through (some feeds omit it) and bounded later by fetched_at.
    const publishedMs = parsePubDate(item.pubDate);
    if (publishedMs !== null && now - publishedMs > maxAgeMs) {
      stale++;
      continue;
    }
    if (!isRelevantArticle(item.title, item.description || '')) {
      skipped++;
      continue;
    }
    const urlHash = await computeUrlHash(item.link);
    toInsert.push({
      sourceId: source.id,
      urlHash,
      url: item.link,
      title: item.title,
      contentSnippet: item.description || null,
      mediaUrl: item.mediaUrl,
      mediaType: item.mediaType,
      publishedAt: item.pubDate,
    });
  }

  let inserted = 0;
  if (toInsert.length) {
    const results = await batchInsertArticles(env.DB, toInsert);
    inserted = results.filter((r) => r.meta.changes).length;
  }

  console.log(
    `fetch: ${source.name} inserted ${inserted} new, skipped ${skipped} irrelevant, ${stale} stale`
  );
  await advanceSourceOrder(env.DB, source.id);
}
