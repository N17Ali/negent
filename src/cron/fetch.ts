import { Env } from '../types';
import { parseFeed, computeUrlHash } from '../services/rss';
import { getNextSource, advanceSourceOrder, batchInsertArticles, ArticleInsert } from '../db';
import { isRelevantArticle } from '../utils/filter';

export async function fetchCron(env: Env): Promise<void> {
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
  const toInsert: ArticleInsert[] = [];
  for (const item of items) {
    if (!item.link) continue;
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
    `fetch: ${source.name} inserted ${inserted} new, skipped ${skipped} irrelevant`
  );
  await advanceSourceOrder(env.DB, source.id);
}
